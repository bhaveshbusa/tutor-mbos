/**
 * Review of one acceptance run's cleanup manifest.
 * The manifest is untrusted. This module does not open connections,
 * read credentials, or delete anything.
 */
import { ENVIRONMENT_BINDINGS } from "../config/environments";

export const AUTH_ADMIN_KEY_SECRET = "SUPABASE_DEVELOPMENT_AUTH_ADMIN_KEY";

/** GitHub environment secret location. Values are never read by this module. */
export const AUTH_ADMIN_KEY_LOCATION =
  "GitHub → Settings → Environments → development → Secrets";

/**
 * Project Auth admin credential for development project
 * idvzjqrkgnihvxoswuxu. The supported routes are GET and DELETE
 * /auth/v1/admin/users/{id} and GET and DELETE
 * /auth/v1/admin/oauth/clients/{client_id}. Hard delete is the
 * documented session removal. This is not the read-only Management API
 * token and it is not a database URL. The business-test step must not
 * receive it. The credential can administer every Auth user on that
 * project; the cleanup step's isolation is the separate process plus
 * the checks below, not a narrower token.
 */
export const AUTH_ADMIN_KEY_PURPOSE =
  "Delete Auth users and OAuth clients created by one development acceptance run after GET verification. Not the Management API token and not a database credential.";

export const CLEANUP_PROJECT_REF =
  ENVIRONMENT_BINDINGS.development.supabaseProjectRef;

export const CLEANUP_REDIRECT_URI = "https://example.com/oauth/callback";

export const CLEANUP_CLIENT_NAMES = [
  "tutor-mbos-generic-acceptance",
  "tutor-mbos-generic-denial",
  "tutor-mbos-generic-restricted",
] as const;

export const CLEANUP_USER_LABELS = ["tenant-a", "tenant-b"] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CleanupUserLabel = (typeof CLEANUP_USER_LABELS)[number];
export type CleanupClientName = (typeof CLEANUP_CLIENT_NAMES)[number];

export interface CleanupUser {
  label: CleanupUserLabel;
  id: string;
}

export interface CleanupClient {
  name: CleanupClientName;
  id: string;
}

export interface CleanupManifest {
  version: 1;
  environment: "development";
  projectRef: string;
  commit: string;
  runId: string;
  runNonce: string;
  users: CleanupUser[];
  clients: CleanupClient[];
}

/** Identity supplied by the protected workflow, never by the manifest. */
export interface CleanupIdentity {
  projectRef: string;
  commit: string;
  runId: string;
  runNonce: string;
}

export function expectedCleanupEmail(
  label: CleanupUserLabel,
  nonce: string,
): string {
  return `tos3-${label}-${nonce}@example.com`;
}

export function reviewCleanupManifest(
  input: unknown,
  identity: CleanupIdentity,
): { ok: true; manifest: CleanupManifest } | { ok: false; reason: string } {
  if (!isRecord(input)) return { ok: false, reason: "manifest_invalid" };
  if (input.version !== 1) return { ok: false, reason: "manifest_version" };
  if (input.environment !== "development") {
    return { ok: false, reason: "manifest_environment" };
  }
  if (
    input.projectRef !== CLEANUP_PROJECT_REF ||
    input.projectRef !== identity.projectRef
  ) {
    return { ok: false, reason: "manifest_project" };
  }
  if (!isSha(identity.commit) || input.commit !== identity.commit) {
    return { ok: false, reason: "manifest_commit" };
  }
  if (!isRunId(identity.runId) || input.runId !== identity.runId) {
    return { ok: false, reason: "manifest_run" };
  }
  if (!isNonce(identity.runNonce) || input.runNonce !== identity.runNonce) {
    return { ok: false, reason: "manifest_nonce" };
  }
  const users = reviewUsers(input.users);
  if (!users.ok) return users;
  const clients = reviewClients(input.clients);
  if (!clients.ok) return clients;
  return {
    ok: true,
    manifest: {
      version: 1,
      environment: "development",
      projectRef: CLEANUP_PROJECT_REF,
      commit: identity.commit,
      runId: identity.runId,
      runNonce: identity.runNonce,
      users: users.users,
      clients: clients.clients,
    },
  };
}

function reviewUsers(
  value: unknown,
): { ok: true; users: CleanupUser[] } | { ok: false; reason: string } {
  if (!Array.isArray(value) || value.length > CLEANUP_USER_LABELS.length) {
    return { ok: false, reason: "manifest_users" };
  }
  const users: CleanupUser[] = [];
  const labels = new Set<string>();
  for (const entry of value) {
    if (!isRecord(entry)) return { ok: false, reason: "manifest_users" };
    const label = entry.label;
    const id = entry.id;
    if (
      typeof label !== "string" ||
      !CLEANUP_USER_LABELS.includes(label as CleanupUserLabel) ||
      labels.has(label)
    ) {
      return { ok: false, reason: "manifest_users" };
    }
    if (typeof id !== "string" || !UUID.test(id)) {
      return { ok: false, reason: "manifest_users" };
    }
    labels.add(label);
    users.push({ label: label as CleanupUserLabel, id });
  }
  return { ok: true, users };
}

function reviewClients(
  value: unknown,
): { ok: true; clients: CleanupClient[] } | { ok: false; reason: string } {
  if (!Array.isArray(value) || value.length > CLEANUP_CLIENT_NAMES.length) {
    return { ok: false, reason: "manifest_clients" };
  }
  const clients: CleanupClient[] = [];
  const names = new Set<string>();
  const ids = new Set<string>();
  for (const entry of value) {
    if (!isRecord(entry)) return { ok: false, reason: "manifest_clients" };
    const name = entry.name;
    const id = entry.id;
    if (
      typeof name !== "string" ||
      !CLEANUP_CLIENT_NAMES.includes(name as CleanupClientName) ||
      names.has(name)
    ) {
      return { ok: false, reason: "manifest_clients" };
    }
    if (typeof id !== "string" || !UUID.test(id) || ids.has(id)) {
      return { ok: false, reason: "manifest_clients" };
    }
    names.add(name);
    ids.add(id);
    clients.push({ name: name as CleanupClientName, id });
  }
  return { ok: true, clients };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSha(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

function isRunId(value: string): boolean {
  return /^[0-9]+$/.test(value);
}

function isNonce(value: string): boolean {
  return /^[a-f0-9]{32}$/.test(value);
}
