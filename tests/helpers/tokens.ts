import { authIssuer } from "@/server/config/access";
import {
  ENVIRONMENT_BINDINGS,
  supabaseUrlFor,
} from "@/server/config/environments";

export interface TestJwk {
  kid?: string;
  kty: string;
  crv?: string;
  x?: string;
  y?: string;
  alg?: string;
  key_ops?: string[];
  [key: string]: unknown;
}

export const NOW = new Date("2026-10-15T12:00:00Z");
export const DEV_ORIGIN = "https://tutor-mbos-dev-lets-play-game.vercel.app";
export const ISSUER = authIssuer(
  supabaseUrlFor(ENVIRONMENT_BINDINGS.development.supabaseProjectRef),
);

export const TENANT_A = {
  userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
  name: "North Bridge Tutoring",
};
export const TENANT_B = {
  userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
  name: "Northbridge Tutoring",
};
export const CHATGPT_CLIENT = "11111111-1111-4111-8111-111111111111";
export const GENERIC_MCP_CLIENT = "22222222-2222-4222-8222-222222222222";
export const API_CLIENT = "33333333-3333-4333-8333-333333333333";

function base64url(value: Uint8Array | string): string {
  const buffer =
    typeof value === "string" ? Buffer.from(value) : Buffer.from(value);
  return buffer.toString("base64url");
}

export async function signingKey(): Promise<{
  privateKey: CryptoKey;
  jwk: TestJwk;
}> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as TestJwk;
  jwk.kid = "test-key";
  jwk.alg = "ES256";
  jwk.key_ops = ["verify"];
  return { privateKey: pair.privateKey, jwk };
}

export async function signToken(
  privateKey: CryptoKey,
  payload: Record<string, unknown>,
  header: Record<string, unknown> = {
    alg: "ES256",
    kid: "test-key",
    typ: "JWT",
  },
): Promise<string> {
  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(payload));
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
  );
  return `${encodedHeader}.${encodedPayload}.${base64url(new Uint8Array(signature))}`;
}

export function sessionClaims(
  userId: string,
  extra: Record<string, unknown> = {},
) {
  const issuedAt = Math.floor(Date.now() / 1000) - 30;
  return {
    sub: userId,
    role: "authenticated",
    aud: "authenticated",
    iss: ISSUER,
    iat: issuedAt,
    exp: issuedAt + 3600,
    aal: "aal1",
    session_id: `session-${userId.slice(-4)}`,
    user_metadata: {
      tenant_id: TENANT_B.userId,
      permissions: ["business.onboard"],
    },
    app_metadata: { role: "service_role" },
    ...extra,
  };
}
