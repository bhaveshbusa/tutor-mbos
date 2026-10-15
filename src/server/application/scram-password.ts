import {
  createHash,
  createHmac,
  pbkdf2Sync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import saslprep from "@mongodb-js/saslprep";

/**
 * Builds the SCRAM-SHA-256 secret PostgreSQL stores in pg_authid.
 *
 * The format and the key derivation are PostgreSQL's scram_build_secret:
 * PBKDF2-HMAC-SHA-256, StoredKey = SHA-256(HMAC(SaltedPassword, "Client Key")),
 * ServerKey = HMAC(SaltedPassword, "Server Key"). The password is prepared
 * with SASLprep (RFC 4013) through @mongodb-js/saslprep, the same profile
 * PostgreSQL's pg_saslprep uses. PostgreSQL keeps the raw password when
 * SASLprep is prohibited or the prepared password would be empty
 * (https://www.postgresql.org/docs/17/sasl-authentication.html). Salt length
 * and iteration count are the Postgres 17 defaults: 16 bytes and
 * scram_iterations 4096. Node's crypto performs the KDF and HMAC.
 */

export const SCRAM_SHA256_ITERATIONS = 4096;
export const SCRAM_SALT_BYTES = 16;
const MAX_SCRAM_ITERATIONS = 100_000;
const VERIFIER =
  /^SCRAM-SHA-256\$(\d+):([A-Za-z0-9+/]+=*)\$([A-Za-z0-9+/]+=*):([A-Za-z0-9+/]+=*)$/;

interface ParsedVerifier {
  iterations: number;
  salt: Buffer;
  storedKey: Buffer;
  serverKey: Buffer;
}

function preparePassword(password: string): string {
  try {
    const prepared = saslprep(password);
    if (prepared.length === 0) return password;
    return prepared;
  } catch {
    return password;
  }
}

function parsedVerifier(verifier: string): ParsedVerifier | null {
  const match = VERIFIER.exec(verifier);
  if (!match) return null;
  const iterations = Number(match[1]);
  const salt = Buffer.from(match[2] ?? "", "base64");
  const storedKey = Buffer.from(match[3] ?? "", "base64");
  const serverKey = Buffer.from(match[4] ?? "", "base64");
  if (
    !Number.isInteger(iterations) ||
    iterations < 1 ||
    iterations > MAX_SCRAM_ITERATIONS ||
    salt.length === 0 ||
    storedKey.length !== 32 ||
    serverKey.length !== 32
  ) {
    return null;
  }
  return { iterations, salt, storedKey, serverKey };
}

function xor(left: Buffer, right: Buffer): Buffer {
  const out = Buffer.alloc(left.length);
  for (let index = 0; index < left.length; index += 1) {
    out[index] = (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return out;
}

export function scramSha256Verifier(
  password: string,
  salt: Buffer = randomBytes(SCRAM_SALT_BYTES),
  iterations: number = SCRAM_SHA256_ITERATIONS,
): string {
  const prepared = preparePassword(password);
  const salted = pbkdf2Sync(prepared, salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}

/**
 * Runs a SCRAM-SHA-256 exchange against a stored verifier. The password is
 * prepared with the same SASLprep rules the server uses when it checks a
 * client proof. A wrong password, or a verifier this process will not trust,
 * is rejected.
 */
export function scramSha256Accepts(
  verifier: string,
  password: string,
): boolean {
  const parsed = parsedVerifier(verifier);
  if (!parsed) return false;
  try {
    const prepared = preparePassword(password);
    const salted = pbkdf2Sync(
      prepared,
      parsed.salt,
      parsed.iterations,
      32,
      "sha256",
    );
    const clientKey = createHmac("sha256", salted)
      .update("Client Key")
      .digest();
    const storedKey = createHash("sha256").update(clientKey).digest();
    const serverKey = createHmac("sha256", salted)
      .update("Server Key")
      .digest();
    const clientNonce = randomBytes(18).toString("base64");
    const serverNonce = `${clientNonce}server`;
    const clientFirst = `n=*,r=${clientNonce}`;
    const serverFirst = `r=${serverNonce},s=${parsed.salt.toString("base64")},i=${parsed.iterations}`;
    const clientFinalWithoutProof = `c=biws,r=${serverNonce}`;
    const authMessage = `${clientFirst},${serverFirst},${clientFinalWithoutProof}`;
    const clientSignature = createHmac("sha256", storedKey)
      .update(authMessage)
      .digest();
    const clientProof = xor(clientKey, clientSignature);
    const serverCheck = createHmac("sha256", parsed.storedKey)
      .update(authMessage)
      .digest();
    const recoveredClientKey = xor(clientProof, serverCheck);
    const recoveredStoredKey = createHash("sha256")
      .update(recoveredClientKey)
      .digest();
    const serverSignature = createHmac("sha256", parsed.serverKey)
      .update(authMessage)
      .digest();
    const expectedServerSignature = createHmac("sha256", serverKey)
      .update(authMessage)
      .digest();
    return (
      timingSafeEqual(recoveredStoredKey, parsed.storedKey) &&
      timingSafeEqual(serverSignature, expectedServerSignature)
    );
  } catch {
    return false;
  }
}

/** True when this generator reproduces PostgreSQL's stored secret byte for byte. */
export function scramSha256ReproducesStoredSecret(
  password: string,
  stored: string,
): boolean {
  const parsed = parsedVerifier(stored);
  if (!parsed) return false;
  const rebuilt = Buffer.from(
    scramSha256Verifier(password, parsed.salt, parsed.iterations),
  );
  const original = Buffer.from(stored);
  return (
    rebuilt.length === original.length && timingSafeEqual(rebuilt, original)
  );
}
