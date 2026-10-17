import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { VerifyResult } from "./verified-token";

type ClaimsOptions = NonNullable<
  Parameters<SupabaseClient["auth"]["getClaims"]>[1]
>;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function clientFor(
  supabaseUrl: string,
  publishableKey: string,
  fetchImpl: typeof fetch,
): SupabaseClient {
  return createClient(supabaseUrl, publishableKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: { fetch: fetchImpl },
  });
}

function unavailable(
  error: { message?: string; name?: string } | null,
): boolean {
  if (!error) return false;
  if (error.name === "AuthRetryableFetchError") return true;
  return /fetch|network|jwks|failed to fetch/i.test(error.message ?? "");
}

/**
 * Verifies a Supabase access token with auth.getClaims(). The SDK checks the
 * signature against the project JWKS. Issuer, audience, role and subject are
 * application rules on those verified claims. Editable metadata is not read.
 */
export async function verifySupabaseAccessToken(input: {
  token: string;
  supabaseUrl: string;
  publishableKey: string;
  issuer: string;
  audiences: readonly string[];
  fetchImpl?: typeof fetch;
  jwks?: { keys: ReadonlyArray<Record<string, unknown>> };
}): Promise<VerifyResult> {
  const supabase = clientFor(
    input.supabaseUrl,
    input.publishableKey,
    input.fetchImpl ?? fetch,
  );
  let result: Awaited<ReturnType<typeof supabase.auth.getClaims>>;
  try {
    result = await supabase.auth.getClaims(
      input.token,
      input.jwks ? { jwks: input.jwks as ClaimsOptions["jwks"] } : undefined,
    );
  } catch {
    return { ok: false, code: "jwks_unavailable" };
  }
  if (!result.data) {
    return {
      ok: false,
      code: unavailable(result.error) ? "jwks_unavailable" : "invalid_token",
    };
  }
  const claims = result.data.claims;
  if (claims.iss !== input.issuer) return { ok: false, code: "invalid_token" };
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (
    audiences.length === 0 ||
    audiences.some((audience) => !input.audiences.includes(audience))
  ) {
    return { ok: false, code: "invalid_token" };
  }
  if (claims.role !== "authenticated") {
    return { ok: false, code: "invalid_token" };
  }
  if (typeof claims.sub !== "string" || !UUID.test(claims.sub)) {
    return { ok: false, code: "invalid_token" };
  }
  const rawClient = claims.client_id;
  const clientId =
    typeof rawClient === "string" && rawClient.length > 0 ? rawClient : null;
  return {
    ok: true,
    claims: { sub: claims.sub, clientId, role: "authenticated" },
  };
}

/** Confirms the Auth server still accepts the token. A revoked session fails here. */
export async function confirmedUser(
  supabaseUrl: string,
  publishableKey: string,
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ userId: string } | null | "unavailable"> {
  try {
    const supabase = clientFor(supabaseUrl, publishableKey, fetchImpl);
    const { data, error } = await supabase.auth.getUser(accessToken);
    if (error) return unavailable(error) ? "unavailable" : null;
    const userId = data.user?.id;
    return typeof userId === "string" && userId.length > 0 ? { userId } : null;
  } catch {
    return "unavailable";
  }
}
