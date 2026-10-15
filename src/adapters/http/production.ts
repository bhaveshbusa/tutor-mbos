import { createServerClient, parseCookieHeader } from "@supabase/ssr";
import {
  acceptedAudiences,
  authIssuer,
  inspectAppDatabaseUrl,
  jwksUrl,
  protectedResourceMetadataUrl,
  siteOriginFor,
} from "@/server/config/access";
import {
  loadRuntimeConfig,
  looksLikeSecret,
  type EnvSource,
} from "@/server/config/environments";
import {
  verifyAccessTokenRefreshingKeys,
  type JsonWebKey,
} from "@/server/application/access-token";
import { applySetCookies, serializeAuthCookie } from "./auth-cookies";
import { oauthGrantRevokeUrl } from "./consent";
import { createPgAccessStore } from "@/server/application/access-store";
import { pgConnection } from "@/server/application/pg-connection";
import type { AccessDeps } from "./access";
import { problemResponse } from "./problem";

interface CachedJwks {
  url: string;
  keys: JsonWebKey[];
  expiresAt: number;
}

let jwksCache: CachedJwks | null = null;
const jwksMissState = { lastMissRefetchAt: 0 };

export function resetJwksCache(): void {
  jwksCache = null;
  jwksMissState.lastMissRefetchAt = 0;
}

async function loadJwks(
  url: string,
  fetchImpl: typeof fetch,
  force = false,
): Promise<JsonWebKey[]> {
  const now = Date.now();
  if (!force && jwksCache && jwksCache.url === url && jwksCache.expiresAt > now)
    return jwksCache.keys;
  const response = await fetchImpl(url, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error("jwks");
  const body = (await response.json()) as { keys?: JsonWebKey[] };
  if (!Array.isArray(body.keys)) throw new Error("jwks");
  jwksCache = { url, keys: body.keys, expiresAt: now + 10 * 60 * 1000 };
  return body.keys;
}

export function authConfigured(env: EnvSource): boolean {
  const runtime = loadRuntimeConfig(env);
  const key = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!runtime.ok || !key || looksLikeSecret(key)) return false;
  const databaseUrl = env.TUTOR_MBOS_APP_DATABASE_URL;
  if (!databaseUrl) return true;
  return inspectAppDatabaseUrl(databaseUrl, runtime.config.environment).ok;
}

export async function withAccess(
  request: Request,
  env: EnvSource,
  run: (deps: AccessDeps) => Promise<Response>,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const runtime = loadRuntimeConfig(env);
  const publishableKey = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!runtime.ok || !publishableKey || looksLikeSecret(publishableKey)) {
    return problemResponse(
      503,
      "Authentication unavailable",
      "Supabase Auth is not configured for this deployment.",
    );
  }
  const databaseUrl = env.TUTOR_MBOS_APP_DATABASE_URL;
  if (
    databaseUrl &&
    !inspectAppDatabaseUrl(databaseUrl, runtime.config.environment).ok
  ) {
    return problemResponse(
      503,
      "Store unavailable",
      "The business database connection is not the app runtime role for this environment.",
    );
  }
  const siteOrigin = siteOriginFor(runtime.config.environment);
  const connection = databaseUrl ? pgConnection(databaseUrl) : null;
  const refreshedCookies: string[] = [];
  const deps: AccessDeps = {
    siteOrigin,
    resourceMetadataUrl: protectedResourceMetadataUrl(siteOrigin),
    now: () => new Date(),
    store: connection ? createPgAccessStore(connection) : null,
    authServer: {
      async getUser(accessToken) {
        try {
          const response = await fetchImpl(
            `${runtime.config.supabaseUrl}/auth/v1/user`,
            {
              headers: {
                authorization: `Bearer ${accessToken}`,
                apikey: publishableKey,
              },
            },
          );
          if (!response.ok) return null;
          const body = (await response.json()) as { id?: unknown };
          return typeof body.id === "string" ? { userId: body.id } : null;
        } catch {
          return "unavailable";
        }
      },
    },
    async verify(token) {
      return verifyAccessTokenRefreshingKeys(token, {
        issuer: authIssuer(runtime.config.supabaseUrl),
        audiences: acceptedAudiences(siteOrigin),
        now: new Date(),
        state: jwksMissState,
        loadKeys: (force) =>
          loadJwks(jwksUrl(runtime.config.supabaseUrl), fetchImpl, force),
      });
    },
    revokeAuthGrant: async (sessionToken, clientId) => {
      try {
        const response = await fetchImpl(
          oauthGrantRevokeUrl(runtime.config.supabaseUrl, clientId),
          {
            method: "DELETE",
            headers: {
              authorization: `Bearer ${sessionToken}`,
              apikey: publishableKey,
            },
          },
        );
        return response.ok ? "ok" : "failed";
      } catch {
        return "failed";
      }
    },
    sessionToken: async (incoming) => {
      const session = await readUiSession(
        incoming,
        runtime.config.supabaseUrl,
        publishableKey,
        fetchImpl,
      );
      refreshedCookies.push(...session.setCookies);
      return session.accessToken;
    },
  };
  try {
    return applySetCookies(await run(deps), refreshedCookies);
  } finally {
    await connection?.close();
  }
}

export async function readUiSession(
  request: Request,
  supabaseUrl: string,
  publishableKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ accessToken: string | null; setCookies: string[] }> {
  const setCookies: string[] = [];
  const supabase = createServerClient(supabaseUrl, publishableKey, {
    cookieOptions: {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
    },
    global: { fetch: fetchImpl },
    cookies: {
      getAll: () => parseCookieHeader(request.headers.get("cookie") ?? ""),
      setAll: (cookies) => {
        for (const cookie of cookies) {
          setCookies.push(
            serializeAuthCookie(
              cookie.name,
              cookie.value,
              cookie.options ?? {},
            ),
          );
        }
      },
    },
  });
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return {
    accessToken: typeof token === "string" && token.length > 0 ? token : null,
    setCookies,
  };
}
