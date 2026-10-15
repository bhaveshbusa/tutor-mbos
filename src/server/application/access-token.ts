import {
  ACCEPTED_TOKEN_ALGORITHMS,
  ACCESS_TOKEN_CLOCK_SKEW_SECONDS,
} from "@/server/domain/access-contract";

export type TokenFailureCode =
  | "malformed"
  | "unsupported_algorithm"
  | "unknown_key"
  | "bad_signature"
  | "issuer"
  | "audience"
  | "expired"
  | "not_yet_valid"
  | "subject"
  | "client_id"
  | "role"
  | "jwks_unavailable";

export interface AccessTokenClaims {
  sub: string;
  clientId: string | null;
  role: "authenticated";
  exp: number;
  sessionId: string | null;
}

export type VerifyResult =
  | { ok: true; claims: AccessTokenClaims }
  | { ok: false; code: TokenFailureCode };

export interface JsonWebKey {
  kid?: string;
  kty: string;
  crv?: string;
  x?: string;
  y?: string;
  n?: string;
  e?: string;
  alg?: string;
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function bytes(part: string): Uint8Array<ArrayBuffer> {
  const padded = part.replace(/-/g, "+").replace(/_/g, "/");
  const decoded = Buffer.from(padded, "base64");
  const copy = new Uint8Array(decoded.byteLength);
  copy.set(decoded);
  return copy;
}

function json(part: string): unknown {
  return JSON.parse(Buffer.from(bytes(part)).toString("utf8"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Verifies a Supabase-issued access token with the project's public JWKS.
 * Signature, issuer, audience, expiry and role are checked before any claim
 * is returned. Editable metadata is not read.
 */
export async function verifyAccessToken(
  token: string,
  options: {
    jwks: readonly JsonWebKey[];
    issuer: string;
    audiences: readonly string[];
    now: Date;
    clockSkewSeconds?: number;
  },
): Promise<VerifyResult> {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    return { ok: false, code: "malformed" };
  }
  const [encodedHeader, encodedPayload, encodedSignature] = parts as [
    string,
    string,
    string,
  ];
  let header: unknown;
  let payload: unknown;
  try {
    header = json(encodedHeader);
    payload = json(encodedPayload);
  } catch {
    return { ok: false, code: "malformed" };
  }
  if (!isRecord(header) || !isRecord(payload)) {
    return { ok: false, code: "malformed" };
  }
  const algorithm = header.alg;
  if (
    typeof algorithm !== "string" ||
    !(ACCEPTED_TOKEN_ALGORITHMS as readonly string[]).includes(algorithm)
  ) {
    return { ok: false, code: "unsupported_algorithm" };
  }
  const kid = header.kid;
  if (typeof kid !== "string" || kid.length === 0) {
    return { ok: false, code: "unknown_key" };
  }
  const jwk = options.jwks.find((key) => key.kid === kid);
  if (!jwk) return { ok: false, code: "unknown_key" };
  const signed = new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`);
  const signature = bytes(encodedSignature);
  let valid = false;
  try {
    valid = await crypto.subtle.verify(
      algorithm === "ES256"
        ? { name: "ECDSA", hash: "SHA-256" }
        : { name: "RSASSA-PKCS1-v1_5" },
      await importKey(jwk, algorithm),
      signature,
      signed,
    );
  } catch {
    return { ok: false, code: "bad_signature" };
  }
  if (!valid) return { ok: false, code: "bad_signature" };

  if (payload.iss !== options.issuer) return { ok: false, code: "issuer" };
  if (!audienceAllowed(payload.aud, options.audiences)) {
    return { ok: false, code: "audience" };
  }
  const skew =
    (options.clockSkewSeconds ?? ACCESS_TOKEN_CLOCK_SKEW_SECONDS) * 1000;
  if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) {
    return { ok: false, code: "expired" };
  }
  if (options.now.getTime() >= payload.exp * 1000 + skew) {
    return { ok: false, code: "expired" };
  }
  if (
    typeof payload.nbf === "number" &&
    options.now.getTime() + skew < payload.nbf * 1000
  ) {
    return { ok: false, code: "not_yet_valid" };
  }
  if (typeof payload.sub !== "string" || !UUID.test(payload.sub)) {
    return { ok: false, code: "subject" };
  }
  if (payload.role !== "authenticated") return { ok: false, code: "role" };
  const clientId = payload.client_id;
  if (clientId !== undefined && clientId !== null) {
    if (typeof clientId !== "string" || !UUID.test(clientId)) {
      return { ok: false, code: "client_id" };
    }
  }
  const sessionId = payload.session_id;
  return {
    ok: true,
    claims: {
      sub: payload.sub,
      clientId: typeof clientId === "string" ? clientId : null,
      role: "authenticated",
      exp: payload.exp,
      sessionId: typeof sessionId === "string" ? sessionId : null,
    },
  };
}

function audienceAllowed(aud: unknown, allowed: readonly string[]): boolean {
  const values = Array.isArray(aud) ? aud : [aud];
  if (values.length === 0) return false;
  return values.every(
    (value) => typeof value === "string" && allowed.includes(value),
  );
}

async function importKey(
  jwk: JsonWebKey,
  algorithm: string,
): Promise<CryptoKey> {
  const key = jwk as unknown as globalThis.JsonWebKey;
  if (algorithm === "ES256") {
    return crypto.subtle.importKey(
      "jwk",
      key,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
  }
  return crypto.subtle.importKey(
    "jwk",
    key,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
}
