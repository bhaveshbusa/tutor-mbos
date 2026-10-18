export interface VerifiedClaims {
  sub: string;
  clientId: string | null;
  role: "authenticated";
}

export type VerifyResult =
  | { ok: true; claims: VerifiedClaims }
  | { ok: false; code: "invalid_token" | "jwks_unavailable" };
