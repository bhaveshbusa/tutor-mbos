import { describe, expect, it } from "vitest";
import { verifySupabaseAccessToken } from "@/server/application/verify-supabase-token";
import { acceptedAudiences } from "@/server/config/access";
import {
  ENVIRONMENT_BINDINGS,
  supabaseUrlFor,
} from "@/server/config/environments";
import {
  DEV_ORIGIN,
  ISSUER,
  TENANT_A,
  sessionClaims,
  signToken,
  signingKey,
} from "./helpers/tokens";

const supabaseUrl = supabaseUrlFor(
  ENVIRONMENT_BINDINGS.development.supabaseProjectRef,
);
const publishableKey = `sb_${"publishable"}_ci`;

async function verify(
  token: string,
  jwk: Awaited<ReturnType<typeof signingKey>>["jwk"],
) {
  return verifySupabaseAccessToken({
    token,
    supabaseUrl,
    publishableKey,
    issuer: ISSUER,
    audiences: acceptedAudiences(DEV_ORIGIN),
    jwks: { keys: [jwk] },
  });
}

describe("Supabase access token verification", () => {
  it("accepts a signed token and ignores editable metadata", async () => {
    const keys = await signingKey();
    const token = await signToken(
      keys.privateKey,
      sessionClaims(TENANT_A.userId),
    );
    const result = await verify(token, keys.jwk);
    expect(result).toEqual({
      ok: true,
      claims: {
        sub: TENANT_A.userId,
        clientId: null,
        role: "authenticated",
      },
    });
  });

  it("rejects a bad signature, the wrong issuer, audience, role, or an expired token", async () => {
    const keys = await signingKey();
    const other = await signingKey();
    const cases = [
      await signToken(other.privateKey, sessionClaims(TENANT_A.userId)),
      await signToken(
        keys.privateKey,
        sessionClaims(TENANT_A.userId, { iss: `${ISSUER}-other` }),
      ),
      await signToken(
        keys.privateKey,
        sessionClaims(TENANT_A.userId, { aud: "https://evil.example" }),
      ),
      await signToken(
        keys.privateKey,
        sessionClaims(TENANT_A.userId, { role: "service_role" }),
      ),
      await signToken(
        keys.privateKey,
        sessionClaims(TENANT_A.userId, {
          exp: Math.floor(Date.now() / 1000) - 120,
        }),
      ),
    ];
    for (const token of cases) {
      expect(await verify(token, keys.jwk)).toEqual({
        ok: false,
        code: "invalid_token",
      });
    }
  });

  it("reports an unreachable JWKS endpoint as unavailable", async () => {
    const keys = await signingKey();
    const token = await signToken(
      keys.privateKey,
      sessionClaims(TENANT_A.userId),
    );
    const result = await verifySupabaseAccessToken({
      token,
      supabaseUrl,
      publishableKey,
      issuer: ISSUER,
      audiences: acceptedAudiences(DEV_ORIGIN),
      fetchImpl: async () => {
        throw new Error("network down");
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("jwks_unavailable");
  });
});
