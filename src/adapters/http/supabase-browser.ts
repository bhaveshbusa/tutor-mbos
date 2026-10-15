import { createServerClient, parseCookieHeader } from "@supabase/ssr";
import { siteOriginFor } from "@/server/config/access";
import {
  loadRuntimeConfig,
  looksLikeSecret,
  type EnvSource,
} from "@/server/config/environments";
import { serializeAuthCookie, applySetCookies } from "./auth-cookies";
import type { BrowserAuth } from "./browser-auth";
import { problemResponse } from "./problem";

/**
 * Browser sign-in, recovery and code exchange through Supabase Auth.
 * Cookie writes stay httpOnly. The caller never receives a service credential.
 */
export async function withBrowserAuth(
  request: Request,
  env: EnvSource,
  run: (auth: BrowserAuth, siteOrigin: string) => Promise<Response>,
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
  const siteOrigin = siteOriginFor(runtime.config.environment);
  const setCookies: string[] = [];
  const supabase = createServerClient(
    runtime.config.supabaseUrl,
    publishableKey,
    {
      cookieOptions: {
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        path: "/",
      },
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
    },
  );
  const auth: BrowserAuth = {
    async signIn(email, password) {
      try {
        const { error } = await supabase.auth.signInWithPassword({
          email,
          password,
        });
        return error ? "invalid" : "ok";
      } catch {
        return "unavailable";
      }
    },
    async recover(email, redirectTo) {
      try {
        const { error } = await supabase.auth.resetPasswordForEmail(email, {
          redirectTo,
        });
        return error ? "unavailable" : "ok";
      } catch {
        return "unavailable";
      }
    },
    async exchange(code) {
      try {
        const { error } = await supabase.auth.exchangeCodeForSession(code);
        return error ? "invalid" : "ok";
      } catch {
        return "unavailable";
      }
    },
    async updatePassword(password) {
      try {
        const { error } = await supabase.auth.updateUser({ password });
        return error ? "invalid" : "ok";
      } catch {
        return "unavailable";
      }
    },
  };
  const response = await run(auth, siteOrigin);
  return applySetCookies(response, setCookies);
}
