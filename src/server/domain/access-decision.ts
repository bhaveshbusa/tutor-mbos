import {
  UI_SESSION_PERMISSIONS,
  knownPermissions,
  type BusinessPermission,
} from "./access-contract";

export interface VerifiedActor {
  path: "ui-session" | "delegated-oauth";
  userId: string;
  /** Null for a first-party UI session. Required for a delegated token. */
  clientId: string | null;
}

/** A grant row written by this server. Never taken from token metadata. */
export interface ServerGrant {
  oauthClientId: string;
  permissions: readonly string[];
  revokedAt: string | null;
}

export interface AccessDecisionInput {
  actor: VerifiedActor;
  grant: ServerGrant | null;
  /**
   * Caller-supplied tenant id, editable metadata and OIDC scopes are accepted
   * here so tests can prove the decision does not read them.
   */
  requestedTenantId?: string | null;
  editableClaims?: unknown;
  oidcScopes?: readonly string[] | null;
}

/**
 * Permissions for an already verified actor. Identity comes only from the
 * verified subject and the server grant. Requested tenant ids, user metadata
 * and OIDC scopes are ignored.
 */
export function permissionsFor(
  input: AccessDecisionInput,
): BusinessPermission[] {
  if (input.actor.path === "ui-session") {
    if (input.actor.clientId !== null) return [];
    return [...UI_SESSION_PERMISSIONS];
  }
  if (!input.actor.clientId || !input.grant) return [];
  if (input.grant.revokedAt !== null) return [];
  if (input.grant.oauthClientId !== input.actor.clientId) return [];
  return knownPermissions(input.grant.permissions);
}

export function hasPermission(
  permissions: readonly BusinessPermission[],
  permission: BusinessPermission,
): boolean {
  return permissions.includes(permission);
}

const DISPLAY_NAME_MAX = 120;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,200}$/;

export function normalizeDisplayName(
  value: string,
): { ok: true; name: string } | { ok: false } {
  const name = value.trim();
  if (name.length < 1 || name.length > DISPLAY_NAME_MAX) return { ok: false };
  if (/[\u0000-\u001f\u007f]/.test(name)) return { ok: false };
  return { ok: true, name };
}

export function validIdempotencyKey(value: string): boolean {
  return IDEMPOTENCY_KEY.test(value);
}

export function sameOwner(actorUserId: string, ownerUserId: string): boolean {
  return actorUserId === ownerUserId;
}
