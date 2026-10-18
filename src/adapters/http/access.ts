import {
  authenticateMaterial,
  type AuthServer,
  type AuthSuccess,
} from "@/server/application/authenticate";
import type { VerifyResult } from "@/server/application/verified-token";
import {
  createFirstBusiness,
  readBusiness,
  readSetupReport,
  revokeClient,
  type AccessContext,
} from "@/server/application/business-access";
import type { AccessStore } from "@/server/application/access-store";
import { browserRequestAllowed } from "@/server/config/access";
import { ACCESS_CONTRACT_VERSION } from "@/server/domain/access-contract";
import { permissionsFor } from "@/server/domain/access-decision";
import { API_VERSION, jsonResponse, problemResponse } from "./problem";

export interface AccessDeps {
  siteOrigin: string;
  resourceMetadataUrl: string;
  now: () => Date;
  verify: (token: string) => Promise<VerifyResult>;
  authServer: AuthServer;
  /** Opens a user-scoped store for the access token that was just verified. */
  storeFor: (accessToken: string) => AccessStore | null;
  /** First-party session token from the Supabase auth cookie. Not a request claim. */
  sessionToken: (request: Request) => Promise<string | null> | string | null;
  /** Deletes the Supabase OAuth grant before the app grant is revoked. */
  revokeAuthGrant?: (
    sessionToken: string,
    clientId: string,
  ) => Promise<"ok" | "failed">;
}

function bearer(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match?.[1] ?? null;
}

function requestedTenantId(request: Request, body: unknown): string | null {
  const header = request.headers.get("x-tenant-id");
  const url = new URL(request.url);
  const query = url.searchParams.get("tenantId");
  const record =
    typeof body === "object" && body !== null
      ? (body as Record<string, unknown>)
      : {};
  const fromBody = record.tenantId ?? record.businessId ?? record.ownerUserId;
  for (const value of [header, query, fromBody]) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

async function readBody(request: Request): Promise<unknown> {
  const type = request.headers.get("content-type") ?? "";
  if (request.method === "GET" || request.method === "HEAD") return {};
  if (type.includes("application/json")) {
    return request.json().catch(() => null);
  }
  if (
    type.includes("application/x-www-form-urlencoded") ||
    type.includes("multipart/form-data")
  ) {
    const form = await request.formData().catch(() => null);
    if (!form) return null;
    const body: Record<string, string> = {};
    for (const [key, value] of form.entries()) {
      if (typeof value === "string") body[key] = value;
    }
    return body;
  }
  return {};
}

function challenge(deps: AccessDeps, response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set(
    "www-authenticate",
    `Bearer realm="tutor-mbos", resource_metadata="${deps.resourceMetadataUrl}"`,
  );
  return new Response(response.body, { status: response.status, headers });
}

async function authorize(
  request: Request,
  deps: AccessDeps,
  body: unknown,
): Promise<
  | { ok: true; auth: AuthSuccess; context: AccessContext; store: AccessStore }
  | { ok: false; response: Response }
> {
  const bearerToken = bearer(request);
  const session = bearerToken ? null : await deps.sessionToken(request);
  const auth = await authenticateMaterial({
    bearerToken,
    sessionToken: session,
    verify: deps.verify,
    authServer: deps.authServer,
  });
  if (!auth.ok) {
    const response =
      auth.status === 503
        ? problemResponse(
            503,
            "Authentication unavailable",
            "The authentication server could not be reached.",
          )
        : problemResponse(
            401,
            "Unauthorized",
            "A valid UI session or delegated access token is required.",
          );
    return { ok: false, response: challenge(deps, response) };
  }
  const accessToken = bearerToken ?? session;
  const store = accessToken ? deps.storeFor(accessToken) : null;
  if (!store) {
    return {
      ok: false,
      response: problemResponse(
        503,
        "Store unavailable",
        "Business data access is not configured for this deployment.",
      ),
    };
  }
  if (
    auth.presented === "cookie" &&
    !browserRequestAllowed(request, deps.siteOrigin)
  ) {
    return {
      ok: false,
      response: problemResponse(
        403,
        "Forbidden",
        "The browser origin is not allowed.",
      ),
    };
  }
  let grant = null;
  if (auth.actor.clientId !== null) {
    try {
      grant = await store.readGrant(auth.actor, auth.actor.clientId);
    } catch {
      return {
        ok: false,
        response: problemResponse(
          503,
          "Store unavailable",
          "The business grant could not be read.",
        ),
      };
    }
  }
  return {
    ok: true,
    auth,
    context: {
      actor: auth.actor,
      grant,
      requestedTenantId: requestedTenantId(request, body),
    },
    store,
  };
}

function failure(result: { status: number; code: string }): Response {
  const title =
    result.status === 403
      ? "Forbidden"
      : result.status === 400
        ? "Bad request"
        : result.status === 502
          ? "Authorization server error"
          : "Unavailable";
  return problemResponse(result.status, title, result.code);
}

export function createAccessHandlers(deps: AccessDeps) {
  return {
    async session(request: Request): Promise<Response> {
      const decision = await authorize(request, deps, {});
      if (!decision.ok) return decision.response;
      const permissions = permissionsFor({
        actor: decision.context.actor,
        grant: decision.context.grant,
        requestedTenantId: decision.context.requestedTenantId,
      });
      return jsonResponse(200, {
        apiVersion: API_VERSION,
        contractVersion: ACCESS_CONTRACT_VERSION,
        userId: decision.context.actor.userId,
        path: decision.context.actor.path,
        clientId: decision.context.actor.clientId,
        permissions,
      });
    },
    async getBusiness(request: Request): Promise<Response> {
      const decision = await authorize(request, deps, {});
      if (!decision.ok) return decision.response;
      const result = await readBusiness(decision.store, decision.context);
      if (!result.ok) return failure(result);
      return jsonResponse(200, {
        apiVersion: API_VERSION,
        business: result.business
          ? { id: result.business.id, displayName: result.business.displayName }
          : null,
      });
    },
    async postBusiness(request: Request): Promise<Response> {
      const body = await readBody(request);
      if (body === null) {
        return problemResponse(400, "Bad request", "invalid_body");
      }
      const decision = await authorize(request, deps, body);
      if (!decision.ok) return decision.response;
      const record =
        typeof body === "object" && body !== null
          ? (body as Record<string, unknown>)
          : {};
      const displayName =
        typeof record.displayName === "string" ? record.displayName : "";
      const headerKey = request.headers.get("idempotency-key");
      const formKey =
        typeof record.idempotencyKey === "string" ? record.idempotencyKey : "";
      const idempotencyKey = headerKey || formKey || "browser-onboarding";
      const result = await createFirstBusiness(
        decision.store,
        decision.context,
        {
          displayName,
          idempotencyKey,
        },
      );
      if (!result.ok) return failure(result);
      return jsonResponse(result.created ? 201 : 200, {
        apiVersion: API_VERSION,
        created: result.created,
        business: {
          id: result.business.id,
          displayName: result.business.displayName,
        },
      });
    },
    async setupReport(request: Request): Promise<Response> {
      const decision = await authorize(request, deps, {});
      if (!decision.ok) return decision.response;
      const result = await readSetupReport(decision.store, decision.context);
      if (!result.ok) return failure(result);
      return jsonResponse(200, { apiVersion: API_VERSION, ...result.report });
    },
    async revoke(request: Request): Promise<Response> {
      const body = await readBody(request);
      const decision = await authorize(request, deps, body);
      if (!decision.ok) return decision.response;
      const record =
        typeof body === "object" && body !== null
          ? (body as Record<string, unknown>)
          : {};
      const clientId =
        typeof record.clientId === "string" ? record.clientId : "";
      const result = await revokeClient(
        decision.store,
        decision.context,
        clientId,
        deps.revokeAuthGrant
          ? async () => {
              const session = await deps.sessionToken(request);
              if (!session) return false;
              return (await deps.revokeAuthGrant!(session, clientId)) === "ok";
            }
          : undefined,
      );
      if (!result.ok) return failure(result);
      return jsonResponse(200, {
        apiVersion: API_VERSION,
        revoked: result.revoked,
      });
    },
  };
}
