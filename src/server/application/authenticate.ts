import type { VerifiedActor } from "@/server/domain/access-decision";
import type { VerifyResult } from "./verified-token";

export interface AuthServer {
  getUser(
    accessToken: string,
  ): Promise<{ userId: string } | null | "unavailable">;
}

export type AuthSuccess = {
  ok: true;
  actor: VerifiedActor;
  presented: "bearer" | "cookie";
};

export type AuthFailure = {
  ok: false;
  status: 401 | 503;
  code: "unauthenticated" | "invalid_token" | "auth_unavailable";
};

/**
 * Bearer tokens are delegated OAuth tokens and must carry client_id.
 * Cookie tokens are first-party UI sessions and must not carry client_id.
 * A bearer token is never upgraded by a cookie, and a delegated token in a
 * cookie is never treated as the account owner.
 */
export async function authenticateMaterial(input: {
  bearerToken: string | null;
  sessionToken: string | null;
  verify: (token: string) => Promise<VerifyResult>;
  authServer: AuthServer;
}): Promise<AuthSuccess | AuthFailure> {
  if (input.bearerToken) {
    return finish("bearer", "delegated-oauth", input.bearerToken, true, input);
  }
  if (input.sessionToken) {
    return finish("cookie", "ui-session", input.sessionToken, false, input);
  }
  return { ok: false, status: 401, code: "unauthenticated" };
}

async function finish(
  presented: "bearer" | "cookie",
  path: VerifiedActor["path"],
  token: string,
  requireClient: boolean,
  input: {
    verify: (token: string) => Promise<VerifyResult>;
    authServer: AuthServer;
  },
): Promise<AuthSuccess | AuthFailure> {
  const verified = await input.verify(token);
  if (!verified.ok) {
    if (verified.code === "jwks_unavailable") {
      return { ok: false, status: 503, code: "auth_unavailable" };
    }
    return { ok: false, status: 401, code: "invalid_token" };
  }
  const hasClient = verified.claims.clientId !== null;
  if (hasClient !== requireClient) {
    return { ok: false, status: 401, code: "invalid_token" };
  }
  const user = await input.authServer.getUser(token);
  if (user === "unavailable") {
    return { ok: false, status: 503, code: "auth_unavailable" };
  }
  if (!user || user.userId !== verified.claims.sub) {
    return { ok: false, status: 401, code: "invalid_token" };
  }
  return {
    ok: true,
    presented,
    actor: {
      path,
      userId: verified.claims.sub,
      clientId: verified.claims.clientId,
    },
  };
}
