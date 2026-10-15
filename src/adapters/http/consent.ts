import { knownPermissions } from "@/server/domain/access-contract";
import { recordClientConsent } from "@/server/application/business-access";
import {
  loadRuntimeConfig,
  type EnvSource,
} from "@/server/config/environments";
import type { AccessDeps } from "./access";
import { problemResponse } from "./problem";

export interface AuthorizationDetails {
  clientId: string;
  clientName: string;
  redirectUri: string;
  scopes: string[];
}

export type AuthorizationLookup =
  AuthorizationDetails | { redirectUrl: string } | { error: string };

export interface ConsentGateway {
  details(
    authorizationId: string,
    sessionToken: string,
  ): Promise<AuthorizationLookup>;
  decide(
    authorizationId: string,
    sessionToken: string,
    decision: "approve" | "deny",
  ): Promise<{ redirectUrl: string } | { error: string }>;
  revokeGrant(
    sessionToken: string,
    clientId: string,
  ): Promise<{ ok: true } | { error: string }>;
}

export function authorizationDetailsUrl(
  supabaseUrl: string,
  authorizationId: string,
): string {
  return `${supabaseUrl}/auth/v1/oauth/authorizations/${encodeURIComponent(authorizationId)}`;
}

export function authorizationConsentUrl(
  supabaseUrl: string,
  authorizationId: string,
): string {
  return `${authorizationDetailsUrl(supabaseUrl, authorizationId)}/consent`;
}

export function oauthGrantRevokeUrl(
  supabaseUrl: string,
  clientId: string,
): string {
  const url = new URL(`${supabaseUrl}/auth/v1/user/oauth/grants`);
  url.searchParams.set("client_id", clientId);
  return url.toString();
}

export function authorizationRequest(
  supabaseUrl: string,
  authorizationId: string,
  decision: "approve" | "deny" | null,
): {
  url: string;
  method: "GET" | "POST";
  body: { action: "approve" | "deny" } | null;
} {
  if (!decision) {
    return {
      url: authorizationDetailsUrl(supabaseUrl, authorizationId),
      method: "GET",
      body: null,
    };
  }
  return {
    url: authorizationConsentUrl(supabaseUrl, authorizationId),
    method: "POST",
    body: { action: decision },
  };
}

/**
 * A missing Supabase OAuth grant is success. DELETE returns 204 when a grant
 * existed and 404 oauth_consent_not_found when it did not. Other statuses and
 * network errors stay failures so a live grant is not dropped by mistake.
 */
export async function revokeSupabaseOauthGrant(
  supabaseUrl: string,
  publishableKey: string,
  sessionToken: string,
  clientId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<"gone" | "failed"> {
  if (!supabaseUrl || !publishableKey || !sessionToken) return "failed";
  try {
    const response = await fetchImpl(
      oauthGrantRevokeUrl(supabaseUrl, clientId),
      {
        method: "DELETE",
        headers: {
          authorization: `Bearer ${sessionToken}`,
          apikey: publishableKey,
        },
      },
    );
    if (response.ok) return "gone";
    if (response.status === 404) {
      const body = (await response.json().catch(() => null)) as {
        error_code?: unknown;
      } | null;
      if (body?.error_code === "oauth_consent_not_found") return "gone";
    }
    return "failed";
  } catch {
    return "failed";
  }
}

export function safeClientRedirect(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol === "https:") return url.toString();
  if (url.protocol === "http:" && url.hostname === "localhost")
    return url.toString();
  return null;
}

/** Origin and path only. Query and fragment are not part of the client match. */
export function redirectOriginPath(value: string): string | null {
  const safe = safeClientRedirect(value);
  if (!safe) return null;
  const url = new URL(safe);
  const path =
    url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;
  return `${url.origin}${path}`;
}

export async function handleConsentDecision(
  request: Request,
  deps: AccessDeps,
  gateway: ConsentGateway,
): Promise<Response> {
  if (request.headers.get("origin") !== deps.siteOrigin) {
    return problemResponse(
      403,
      "Forbidden",
      "The browser origin is not allowed.",
    );
  }
  const form = await request.formData().catch(() => null);
  if (!form) return problemResponse(400, "Bad request", "invalid_body");
  const authorizationId = form.get("authorization_id");
  const decision = form.get("decision");
  if (typeof authorizationId !== "string" || authorizationId.length < 1) {
    return problemResponse(400, "Bad request", "missing_authorization");
  }
  if (decision !== "approve" && decision !== "deny") {
    return problemResponse(400, "Bad request", "invalid_decision");
  }
  const session = await deps.sessionToken(request);
  if (!session)
    return problemResponse(
      401,
      "Unauthorized",
      "Sign in before granting access.",
    );
  const probe = await deps.verify(session);
  if (!probe.ok || probe.claims.clientId !== null) {
    return problemResponse(
      401,
      "Unauthorized",
      "A first-party session is required.",
    );
  }
  const user = await deps.authServer.getUser(session);
  if (user === "unavailable") {
    return problemResponse(
      503,
      "Authentication unavailable",
      "The authentication server could not be reached.",
    );
  }
  if (!user || user.userId !== probe.claims.sub) {
    return problemResponse(
      401,
      "Unauthorized",
      "The session is no longer valid.",
    );
  }
  const details = await gateway.details(authorizationId, session);
  if ("error" in details)
    return problemResponse(400, "Bad request", "invalid_authorization");
  if (!deps.store) {
    return problemResponse(
      503,
      "Store unavailable",
      "Business data access is not configured for this deployment.",
    );
  }
  const actor = {
    path: "ui-session" as const,
    userId: user.userId,
    clientId: null,
  };
  if (!("clientId" in details)) {
    return reconnectResponse(deps.store, actor, details.redirectUrl);
  }
  const requested = form
    .getAll("permissions")
    .filter((value): value is string => typeof value === "string");
  const permissions = decision === "approve" ? knownPermissions(requested) : [];
  const redirectUri = decision === "approve" ? details.redirectUri : null;
  if (decision === "approve" && !redirectOriginPath(details.redirectUri)) {
    return problemResponse(400, "Bad request", "invalid_redirect");
  }
  const recorded = await recordClientConsent(deps.store, actor, {
    oauthClientId: details.clientId,
    permissions,
    scopes: details.scopes,
    authorizationId,
    decision: decision === "approve" ? "approved" : "denied",
    redirectUri,
  });
  if (!recorded.ok) {
    return problemResponse(recorded.status, "Consent failed", recorded.code);
  }
  if (decision === "deny") {
    const revoked = await gateway.revokeGrant(session, details.clientId);
    if ("error" in revoked) {
      return problemResponse(
        502,
        "Authorization server error",
        "The authentication server did not revoke the client.",
      );
    }
  }
  const outcome = await gateway.decide(authorizationId, session, decision);
  if ("error" in outcome) {
    if (decision === "approve") {
      await deps.store.revokeGrant(actor, details.clientId);
    }
    return problemResponse(
      502,
      "Authorization server error",
      "The consent decision was not accepted.",
    );
  }
  const redirect = safeClientRedirect(outcome.redirectUrl);
  if (!redirect)
    return problemResponse(
      502,
      "Authorization server error",
      "The client redirect was rejected.",
    );
  return Response.redirect(redirect, 303);
}

export async function resolveConsentEntry(
  request: Request,
  deps: AccessDeps,
  gateway: ConsentGateway,
  authorizationId: string,
): Promise<Response> {
  const session = await deps.sessionToken(request);
  if (!session) return Response.json({ view: "form" });
  const probe = await deps.verify(session);
  if (!probe.ok || probe.claims.clientId !== null)
    return Response.json({ view: "form" });
  const user = await deps.authServer.getUser(session);
  if (!user || user === "unavailable" || user.userId !== probe.claims.sub) {
    return Response.json({ view: "form" });
  }
  const details = await gateway.details(authorizationId, session);
  if ("error" in details || "clientId" in details)
    return Response.json({ view: "form" });
  if (!deps.store) return Response.json({ view: "repeat" });
  return reconnectResponse(
    deps.store,
    { path: "ui-session", userId: user.userId, clientId: null },
    details.redirectUrl,
    { repeatStatus: 200 },
  );
}

async function reconnectResponse(
  store: NonNullable<AccessDeps["store"]>,
  actor: { path: "ui-session"; userId: string; clientId: null },
  redirectUrl: string,
  options: { repeatStatus: 200 | 409 } = { repeatStatus: 409 },
): Promise<Response> {
  const redirect = safeClientRedirect(redirectUrl);
  if (!redirect) {
    return problemResponse(
      502,
      "Authorization server error",
      "The client redirect was rejected.",
    );
  }
  const target = redirectOriginPath(redirect);
  const live = await store.listLiveGrantRedirects(actor);
  const matches = target
    ? live.filter((uri) => redirectOriginPath(uri) === target)
    : [];
  if (matches.length !== 1) {
    return options.repeatStatus === 200
      ? Response.json({ view: "repeat" })
      : problemResponse(409, "Consent required", "consent_required");
  }
  return Response.redirect(redirect, 303);
}

export function createSupabaseConsentGateway(env: EnvSource): ConsentGateway {
  const runtime = loadRuntimeConfig(env);
  const supabaseUrl = runtime.ok ? runtime.config.supabaseUrl : "";
  const publishableKey = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "";
  return {
    async details(authorizationId, sessionToken) {
      const result = await callAuthorization(
        supabaseUrl,
        publishableKey,
        authorizationId,
        sessionToken,
        null,
      );
      if (result.kind === "details") {
        return {
          clientId: result.clientId,
          clientName: result.clientName,
          redirectUri: result.redirectUri,
          scopes: result.scopes,
        };
      }
      if (result.kind === "redirect")
        return { redirectUrl: result.redirectUrl };
      return { error: result.error };
    },
    async revokeGrant(sessionToken, clientId) {
      const result = await revokeSupabaseOauthGrant(
        supabaseUrl,
        publishableKey,
        sessionToken,
        clientId,
      );
      return result === "gone" ? { ok: true } : { error: "rejected" };
    },
    async decide(authorizationId, sessionToken, decision) {
      const result = await callAuthorization(
        supabaseUrl,
        publishableKey,
        authorizationId,
        sessionToken,
        decision,
      );
      if (result.kind === "redirect")
        return { redirectUrl: result.redirectUrl };
      return { error: result.kind === "error" ? result.error : "rejected" };
    },
  };
}

type AuthCall =
  | ({ kind: "details" } & AuthorizationDetails)
  | { kind: "redirect"; redirectUrl: string }
  | { kind: "error"; error: string };

async function callAuthorization(
  supabaseUrl: string,
  publishableKey: string,
  authorizationId: string,
  sessionToken: string,
  decision: "approve" | "deny" | null,
): Promise<AuthCall> {
  if (!supabaseUrl || !publishableKey)
    return { kind: "error", error: "unconfigured" };
  try {
    const planned = authorizationRequest(
      supabaseUrl,
      authorizationId,
      decision,
    );
    const response = await fetch(planned.url, {
      method: planned.method,
      headers: {
        authorization: `Bearer ${sessionToken}`,
        apikey: publishableKey,
        "content-type": "application/json",
      },
      body: planned.body ? JSON.stringify(planned.body) : undefined,
    });
    if (!response.ok) return { kind: "error", error: "rejected" };
    const body = (await response.json()) as {
      redirect_url?: string;
      redirect_uri?: string;
      scope?: string;
      client?: { id?: string; name?: string };
    };
    if (decision) {
      return typeof body.redirect_url === "string"
        ? { kind: "redirect", redirectUrl: body.redirect_url }
        : { kind: "error", error: "rejected" };
    }
    if (typeof body.redirect_url === "string" && !body.client?.id) {
      return { kind: "redirect", redirectUrl: body.redirect_url };
    }
    if (!body.client?.id || !body.client.name || !body.redirect_uri) {
      return { kind: "error", error: "rejected" };
    }
    return {
      kind: "details",
      clientId: body.client.id,
      clientName: body.client.name,
      redirectUri: body.redirect_uri,
      scopes: (body.scope ?? "").split(" ").filter(Boolean),
    };
  } catch {
    return { kind: "error", error: "unavailable" };
  }
}
