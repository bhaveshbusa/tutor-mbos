import { describe, expect, it } from "vitest";
import {
  verifyAccessToken,
  verifyAccessTokenRefreshingKeys,
} from "@/server/application/access-token";
import { acceptedAudiences, resourceUrl } from "@/server/config/access";
import {
  DEV_ORIGIN,
  ISSUER,
  NOW,
  TENANT_A,
  sessionClaims,
  signToken,
  signingKey,
} from "./helpers/tokens";

const audiences = acceptedAudiences(DEV_ORIGIN);

async function token(
  payload: Record<string, unknown>,
  header?: Record<string, unknown>,
) {
  const keys = await signingKey();
  return {
    keys,
    jwt: await signToken(keys.privateKey, payload, header),
  };
}

describe("delegated and session token verification", () => {
  it("accepts a signed token for this issuer and audience", async () => {
    const { keys, jwt } = await token(sessionClaims(TENANT_A.userId));
    const result = await verifyAccessToken(jwt, {
      jwks: [keys.jwk],
      issuer: ISSUER,
      audiences,
      now: NOW,
    });
    expect(result).toMatchObject({
      ok: true,
      claims: { sub: TENANT_A.userId, clientId: null, role: "authenticated" },
    });
  });

  it("rejects a bad signature, the wrong issuer, audience, expiry, role and algorithm", async () => {
    const keys = await signingKey();
    const valid = await signToken(
      keys.privateKey,
      sessionClaims(TENANT_A.userId),
    );
    const [header, payload, signature] = valid.split(".");
    const tampered = `${header}.${payload}.${signature!.slice(0, -2)}aa`;
    const cases: { name: string; jwt: string; code: string }[] = [
      { name: "signature", jwt: tampered, code: "bad_signature" },
      {
        name: "issuer",
        jwt: await signToken(
          keys.privateKey,
          sessionClaims(TENANT_A.userId, { iss: `${ISSUER}-other` }),
        ),
        code: "issuer",
      },
      {
        name: "audience",
        jwt: await signToken(
          keys.privateKey,
          sessionClaims(TENANT_A.userId, { aud: "https://evil.example" }),
        ),
        code: "audience",
      },
      {
        name: "mixed audience",
        jwt: await signToken(
          keys.privateKey,
          sessionClaims(TENANT_A.userId, {
            aud: ["authenticated", "https://evil.example"],
          }),
        ),
        code: "audience",
      },
      {
        name: "expired",
        jwt: await signToken(
          keys.privateKey,
          sessionClaims(TENANT_A.userId, {
            exp: Math.floor(NOW.getTime() / 1000) - 60,
          }),
        ),
        code: "expired",
      },
      {
        name: "role",
        jwt: await signToken(
          keys.privateKey,
          sessionClaims(TENANT_A.userId, { role: "service_role" }),
        ),
        code: "role",
      },
      {
        name: "none",
        jwt: await signToken(keys.privateKey, sessionClaims(TENANT_A.userId), {
          alg: "none",
          kid: "test-key",
        }),
        code: "unsupported_algorithm",
      },
      {
        name: "hmac",
        jwt: await signToken(keys.privateKey, sessionClaims(TENANT_A.userId), {
          alg: "HS256",
          kid: "test-key",
        }),
        code: "unsupported_algorithm",
      },
    ];
    for (const entry of cases) {
      const result = await verifyAccessToken(entry.jwt, {
        jwks: [keys.jwk],
        issuer: ISSUER,
        audiences,
        now: NOW,
      });
      expect(result, entry.name).toEqual({ ok: false, code: entry.code });
    }
    expect(audiences).toContain(resourceUrl(DEV_ORIGIN));
  });

  it("refetches JWKS once when the key id is unknown", async () => {
    const { keys, jwt } = await token(sessionClaims(TENANT_A.userId));
    const loads: boolean[] = [];
    const state = { lastMissRefetchAt: 0 };
    const options = {
      issuer: ISSUER,
      audiences,
      now: NOW,
      state,
      loadKeys: async (force: boolean) => {
        loads.push(force);
        return force ? [keys.jwk] : [];
      },
    };
    const refreshed = await verifyAccessTokenRefreshingKeys(jwt, options);
    expect(refreshed.ok).toBe(true);
    expect(loads).toEqual([false, true]);
    loads.length = 0;
    const stale = await verifyAccessTokenRefreshingKeys(
      await signToken(keys.privateKey, sessionClaims(TENANT_A.userId), {
        alg: "ES256",
        kid: "missing",
        typ: "JWT",
      }),
      options,
    );
    expect(stale).toEqual({ ok: false, code: "unknown_key" });
    expect(loads).toEqual([false]);
  });
});
