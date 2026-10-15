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
  verifyAccessToken,
  type JsonWebKey,
} from "@/server/application/access-token";
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

export function resetJwksCache(): void {
  jwksCache = null;
}

async function loadJwks(
  url: string,
  fetchImpl: typeof fetch,
): Promise<JsonWebKey[]> {
  const now = Date.now();
  if (jwksCache && jwksCache.url === url && jwksCache.expiresAt > now)
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
      try {
        const keys = await loadJwks(
          jwksUrl(runtime.config.supabaseUrl),
          fetchImpl,
        );
        return verifyAccessToken(token, {
          jwks: keys,
          issuer: authIssuer(runtime.config.supabaseUrl),
          audiences: acceptedAudiences(siteOrigin),
          now: new Date(),
        });
      } catch {
        return { ok: false, code: "jwks_unavailable" };
      }
    },
    sessionToken: (incoming) =>
      sessionAccessToken(incoming, runtime.config.supabaseUrl, publishableKey),
  };
  try {
    return await run(deps);
  } finally {
    await connection?.close();
  }
}

async function sessionAccessToken(
  request: Request,
  supabaseUrl: string,
  publishableKey: string,
): Promise<string | null> {
  const supabase = createServerClient(supabaseUrl, publishableKey, {
    cookieOptions: { httpOnly: true, secure: true, sameSite: "lax", path: "/" },
    cookies: {
      getAll: () => parseCookieHeader(request.headers.get("cookie") ?? ""),
      setAll: () => undefined,
    },
  });
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return typeof token === "string" && token.length > 0 ? token : null;
}
