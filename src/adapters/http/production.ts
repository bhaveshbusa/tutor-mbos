import { createServerClient, parseCookieHeader } from "@supabase/ssr";
import {
  acceptedAudiences,
  authIssuer,
  protectedResourceMetadataUrl,
  siteOriginFor,
} from "@/server/config/access";
import {
  loadRuntimeConfig,
  looksLikeSecret,
  type EnvSource,
} from "@/server/config/environments";
import {
  confirmedUser,
  verifySupabaseAccessToken,
} from "@/server/application/verify-supabase-token";
import {
  createSupabaseAccessStore,
  createUserSupabaseClient,
} from "@/server/application/supabase-store";
import { applySetCookies, serializeAuthCookie } from "./auth-cookies";
import { revokeSupabaseOauthGrant } from "./consent";
import type { AccessDeps } from "./access";
import { problemResponse } from "./problem";

export function authConfigured(env: EnvSource): boolean {
  const runtime = loadRuntimeConfig(env);
  const key = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  return Boolean(runtime.ok && key && !looksLikeSecret(key));
}

const SESSION_REFRESH_MARGIN_MS = 90_000;

export function authStorageKey(supabaseUrl: string): string {
  return `sb-${new URL(supabaseUrl).hostname.split(".")[0]}-auth-token`;
}

/**
 * Reads the UI access token from the request cookie and does not call Auth.
 * A token inside the refresh window is treated as absent so a Server Component
 * cannot rotate the refresh token and then drop the new cookies.
 */
export function readStoredAccessToken(
  request: Request,
  supabaseUrl: string,
  now = Date.now(),
): string | null {
  const cookies = parseCookieHeader(request.headers.get("cookie") ?? "");
  const key = authStorageKey(supabaseUrl);
  const direct = cookies.find((cookie) => cookie.name === key)?.value;
  const chunked = cookies
    .flatMap((cookie) => {
      if (!cookie.name.startsWith(`${key}.`)) return [];
      const index = Number(cookie.name.slice(key.length + 1));
      return Number.isInteger(index) && index >= 0
        ? [{ index, value: cookie.value }]
        : [];
    })
    .sort((left, right) => left.index - right.index)
    .map((cookie) => cookie.value)
    .join("");
  const raw = direct || chunked;
  if (!raw) return null;
  const encoded = raw.startsWith("base64-") ? raw.slice("base64-".length) : raw;
  let session: { access_token?: unknown; expires_at?: unknown };
  try {
    session = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as { access_token?: unknown; expires_at?: unknown };
  } catch {
    return null;
  }
  if (typeof session.access_token !== "string" || !session.access_token) {
    return null;
  }
  if (typeof session.expires_at !== "number") return null;
  if (session.expires_at * 1000 - now < SESSION_REFRESH_MARGIN_MS) return null;
  return session.access_token;
}

export async function withAccess(
  request: Request,
  env: EnvSource,
  run: (deps: AccessDeps) => Promise<Response>,
  options: { fetch?: typeof fetch; session?: "refresh" | "stored" } = {},
): Promise<Response> {
  const fetchImpl = options.fetch ?? fetch;
  const runtime = loadRuntimeConfig(env);
  const publishableKey = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!runtime.ok || !publishableKey || looksLikeSecret(publishableKey)) {
    return problemResponse(
      503,
      "Authentication unavailable",
      "Supabase Auth is not configured for this deployment.",
    );
  }
  const siteOrigin = siteOriginFor(runtime.config.environment);
  const refreshedCookies: string[] = [];
  const deps: AccessDeps = {
    siteOrigin,
    resourceMetadataUrl: protectedResourceMetadataUrl(siteOrigin),
    now: () => new Date(),
    storeFor: (accessToken) =>
      createSupabaseAccessStore(
        createUserSupabaseClient({
          supabaseUrl: runtime.config.supabaseUrl,
          publishableKey,
          accessToken,
          fetchImpl,
        }),
      ),
    authServer: {
      getUser: (accessToken) =>
        confirmedUser(
          runtime.config.supabaseUrl,
          publishableKey,
          accessToken,
          fetchImpl,
        ),
    },
    verify: (token) =>
      verifySupabaseAccessToken({
        token,
        supabaseUrl: runtime.config.supabaseUrl,
        publishableKey,
        issuer: authIssuer(runtime.config.supabaseUrl),
        audiences: acceptedAudiences(siteOrigin),
        fetchImpl,
      }),
    revokeAuthGrant: async (sessionToken, clientId) => {
      const result = await revokeSupabaseOauthGrant(
        runtime.config.supabaseUrl,
        publishableKey,
        sessionToken,
        clientId,
        fetchImpl,
      );
      return result === "gone" ? "ok" : "failed";
    },
    sessionToken: async (incoming) => {
      if (options.session === "stored") {
        return readStoredAccessToken(incoming, runtime.config.supabaseUrl);
      }
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
  return applySetCookies(await run(deps), refreshedCookies);
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
