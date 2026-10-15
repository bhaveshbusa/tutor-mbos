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

export interface ConsentGateway {
  details(
    authorizationId: string,
    sessionToken: string,
  ): Promise<AuthorizationDetails | { error: string }>;
  decide(
    authorizationId: string,
    sessionToken: string,
    decision: "approve" | "deny",
  ): Promise<{ redirectUrl: string } | { error: string }>;
}

export function authorizationDetailsUrl(
  supabaseUrl: string,
  authorizationId: string,
): string {
  return `${supabaseUrl}/auth/v1/oauth/authorizations/${encodeURIComponent(authorizationId)}`;
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
  const requested = form
    .getAll("permissions")
    .filter((value): value is string => typeof value === "string");
  const permissions = decision === "approve" ? knownPermissions(requested) : [];
  if (!deps.store) {
    return problemResponse(
      503,
      "Store unavailable",
      "Business data access is not configured for this deployment.",
    );
  }
  const recorded = await recordClientConsent(
    deps.store,
    { path: "ui-session", userId: user.userId, clientId: null },
    {
      oauthClientId: details.clientId,
      permissions,
      scopes: details.scopes,
      authorizationId,
      decision: decision === "approve" ? "approved" : "denied",
    },
  );
  if (!recorded.ok) {
    return problemResponse(recorded.status, "Consent failed", recorded.code);
  }
  const outcome = await gateway.decide(authorizationId, session, decision);
  if ("error" in outcome) {
    if (decision === "approve") {
      await deps.store.revokeGrant(
        { path: "ui-session", userId: user.userId, clientId: null },
        details.clientId,
      );
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
      return { error: result.kind === "error" ? result.error : "rejected" };
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
    const response = await fetch(
      authorizationDetailsUrl(supabaseUrl, authorizationId),
      {
        method: decision ? "POST" : "GET",
        headers: {
          authorization: `Bearer ${sessionToken}`,
          apikey: publishableKey,
          "content-type": "application/json",
        },
        body: decision ? JSON.stringify({ action: decision }) : undefined,
      },
    );
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
