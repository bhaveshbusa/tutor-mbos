import { ACCESS_CONTRACT_VERSION } from "@/server/domain/access-contract";
import {
  hasPermission,
  normalizeDisplayName,
  permissionsFor,
  sameOwner,
  validIdempotencyKey,
  type ServerGrant,
  type VerifiedActor,
} from "@/server/domain/access-decision";
import {
  AccessStoreError,
  type AccessStore,
  type BusinessRecord,
} from "./access-store";

export interface AccessContext {
  actor: VerifiedActor;
  grant: ServerGrant | null;
  requestedTenantId: string | null;
}

type Failure = { ok: false; status: 400 | 403 | 502 | 503; code: string };

function permissions(context: AccessContext) {
  return permissionsFor({
    actor: context.actor,
    grant: context.grant,
    requestedTenantId: context.requestedTenantId,
  });
}

function fail(error: unknown): Failure {
  if (error instanceof AccessStoreError) {
    if (error.code === "forbidden")
      return { ok: false, status: 403, code: "forbidden" };
    if (error.code === "rate_limited")
      return { ok: false, status: 403, code: "rate_limited" };
    if (
      error.code === "invalid_name" ||
      error.code === "invalid_idempotency_key" ||
      error.code === "invalid_permissions" ||
      error.code === "invalid_client" ||
      error.code === "invalid_decision"
    ) {
      return { ok: false, status: 400, code: error.code };
    }
  }
  return { ok: false, status: 503, code: "unavailable" };
}

function owned(
  actor: VerifiedActor,
  business: BusinessRecord | null,
): { ok: true; business: BusinessRecord | null } | Failure {
  if (business && !sameOwner(actor.userId, business.ownerUserId)) {
    return { ok: false, status: 403, code: "forbidden" };
  }
  return { ok: true, business };
}

export async function createFirstBusiness(
  store: AccessStore,
  context: AccessContext,
  input: { displayName: string; idempotencyKey: string },
): Promise<{ ok: true; business: BusinessRecord; created: boolean } | Failure> {
  if (!hasPermission(permissions(context), "business.onboard")) {
    return { ok: false, status: 403, code: "forbidden" };
  }
  const name = normalizeDisplayName(input.displayName);
  if (!name.ok) return { ok: false, status: 400, code: "invalid_name" };
  if (!validIdempotencyKey(input.idempotencyKey)) {
    return { ok: false, status: 400, code: "invalid_idempotency_key" };
  }
  try {
    const result = await store.createBusiness(context.actor, {
      displayName: name.name,
      idempotencyKey: input.idempotencyKey,
    });
    const checked = owned(context.actor, result.business);
    if (!checked.ok || !checked.business)
      return { ok: false, status: 403, code: "forbidden" };
    return { ok: true, business: checked.business, created: result.created };
  } catch (error) {
    return fail(error);
  }
}

export async function readBusiness(
  store: AccessStore,
  context: AccessContext,
): Promise<{ ok: true; business: BusinessRecord | null } | Failure> {
  if (!hasPermission(permissions(context), "business.read")) {
    return { ok: false, status: 403, code: "forbidden" };
  }
  try {
    return owned(context.actor, await store.readBusiness(context.actor));
  } catch (error) {
    return fail(error);
  }
}

export async function readSetupReport(
  store: AccessStore,
  context: AccessContext,
): Promise<
  | {
      ok: true;
      report: {
        dataset: "setup";
        contractVersion: string;
        businessId: string | null;
        displayName: string | null;
        ready: boolean;
      };
    }
  | Failure
> {
  if (!hasPermission(permissions(context), "reports.read")) {
    return { ok: false, status: 403, code: "forbidden" };
  }
  try {
    const checked = owned(
      context.actor,
      await store.readSetupReport(context.actor),
    );
    if (!checked.ok) return checked;
    return {
      ok: true,
      report: {
        dataset: "setup",
        contractVersion: ACCESS_CONTRACT_VERSION,
        businessId: checked.business?.id ?? null,
        displayName: checked.business?.displayName ?? null,
        ready: checked.business !== null,
      },
    };
  } catch (error) {
    return fail(error);
  }
}

export async function revokeClient(
  store: AccessStore,
  context: AccessContext,
  clientId: string,
  revokeAuthGrant?: () => Promise<boolean>,
): Promise<{ ok: true; revoked: boolean } | Failure> {
  if (context.actor.path !== "ui-session" || context.actor.clientId !== null) {
    return { ok: false, status: 403, code: "forbidden" };
  }
  if (!/^[0-9a-f-]{36}$/i.test(clientId)) {
    return { ok: false, status: 400, code: "invalid_client" };
  }
  if (revokeAuthGrant) {
    try {
      if (!(await revokeAuthGrant())) {
        return { ok: false, status: 502, code: "auth_revoke_failed" };
      }
    } catch {
      return { ok: false, status: 502, code: "auth_revoke_failed" };
    }
  }
  try {
    return {
      ok: true,
      revoked: await store.revokeGrant(context.actor, clientId),
    };
  } catch (error) {
    return fail(error);
  }
}

export async function recordClientConsent(
  store: AccessStore,
  actor: VerifiedActor,
  input: {
    oauthClientId: string;
    permissions: readonly string[];
    scopes: readonly string[];
    authorizationId: string;
    decision: "approved" | "denied";
    redirectUri?: string | null;
  },
): Promise<{ ok: true } | Failure> {
  if (actor.path !== "ui-session")
    return { ok: false, status: 403, code: "forbidden" };
  try {
    await store.recordConsent(actor, input);
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}
