/**
 * Review of one acceptance run's cleanup manifest.
 * The manifest is untrusted. This module does not open connections,
 * read credentials, or delete anything.
 */
import { randomBytes } from "node:crypto";
import { appendFileSync, renameSync, writeFileSync } from "node:fs";
import { ENVIRONMENT_BINDINGS } from "../config/environments";

export const AUTH_ADMIN_KEY_SECRET = "SUPABASE_DEVELOPMENT_AUTH_ADMIN_KEY";

/** GitHub environment secret location. Values are never read by this module. */
export const AUTH_ADMIN_KEY_LOCATION =
  "GitHub → Settings → Environments → development → Secrets";

/**
 * Development Auth admin credential for project idvzjqrkgnihvxoswuxu.
 * Supported shapes are a secret key (`sb_secret_…`, `apikey` header only)
 * or a legacy service_role JWT (`apikey` and `Authorization: Bearer`).
 * Any other shape is refused before a request. The read-only check is
 * GET /auth/v1/admin/users?page=1&per_page=1 and it must return 200
 * before signup. Deletes use GET and DELETE /auth/v1/admin/users/{id}
 * and GET and DELETE /auth/v1/admin/oauth/clients/{client_id}. This is
 * not the Management API token and it is not a database URL. The
 * business job must not receive it. The credential can administer every
 * Auth user on that project. Isolation is a separate job with a fresh
 * checkout, a frozen install, and no shared cache, plus the GET checks
 * below. There is no narrower official token, and the Management API
 * token is not given delete permission.
 */
export const AUTH_ADMIN_KEY_PURPOSE =
  "Delete Auth users and OAuth clients created by one development acceptance run after a read-only capability check and GET verification. Secret keys use the apikey header only. Not the Management API token and not a database credential.";

export const ADMIN_CAPABILITY_PATH = "/auth/v1/admin/users?page=1&per_page=1";

export const CLEANUP_PROJECT_REF =
  ENVIRONMENT_BINDINGS.development.supabaseProjectRef;

export const CLEANUP_REDIRECT_URI = "https://example.com/oauth/callback";

export const CLEANUP_TIME_SKEW_MS = 120_000;

/** A legitimate manifest is a few hundred bytes. Job outputs are not masked. */
export const MANIFEST_MAX_BYTES = 4096;

export const MANIFEST_OUTPUT_NAME = "manifest";

export const CLEANUP_CLIENT_LABELS = [
  "acceptance",
  "denial",
  "restricted",
] as const;

export const CLEANUP_USER_LABELS = ["tenant-a", "tenant-b"] as const;

/**
 * Resend receiving domain for synthetic acceptance mail.
 * Signup, cleanup lookup, and the receiving reader all use this binding.
 * The sender domain is `tutor.wonderkidz.co.uk`.
 */
export const ACCEPTANCE_RECEIVING_DOMAIN = "weeveo.resend.app";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JWT = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export type CleanupUserLabel = (typeof CLEANUP_USER_LABELS)[number];
export type CleanupClientLabel = (typeof CLEANUP_CLIENT_LABELS)[number];

export interface CleanupUser {
  label: CleanupUserLabel;
  id?: string;
}

export interface CleanupClient {
  label: CleanupClientLabel;
  id?: string;
}

export interface CleanupManifest {
  version: 1;
  environment: "development";
  projectRef: string;
  commit: string;
  runId: string;
  runAttempt: string;
  users: CleanupUser[];
  clients: CleanupClient[];
}

/** Identity supplied by the protected workflow, never by the manifest. */
export interface CleanupIdentity {
  projectRef: string;
  commit: string;
  runId: string;
  runAttempt: string;
  runNonce: string;
  startedAt: string;
}

export function expectedCleanupEmail(
  label: CleanupUserLabel,
  nonce: string,
): string {
  return `tos3-${label}-${nonce}@${ACCEPTANCE_RECEIVING_DOMAIN}`;
}

export function expectedClientName(
  label: CleanupClientLabel,
  nonce: string,
): string {
  return `tos3-${label}-${nonce}`;
}

/**
 * Secret keys are not JWTs. Sending one as a bearer token makes the
 * platform try to parse it and reject the call. Legacy service_role
 * JWTs still use both headers.
 */
export function adminRequestHeaders(
  adminKey: string,
): Record<string, string> | null {
  if (
    adminKey.startsWith("sb_secret_") &&
    adminKey.length > "sb_secret_".length
  ) {
    return { apikey: adminKey, accept: "application/json" };
  }
  if (JWT.test(adminKey)) {
    return {
      apikey: adminKey,
      authorization: `Bearer ${adminKey}`,
      accept: "application/json",
    };
  }
  return null;
}

export function createdAtInRunWindow(
  createdAt: unknown,
  startedAt: string,
  nowMs: number,
): "in_window" | "created_at_absent" | "created_at_outside_window" {
  if (typeof createdAt !== "string") return "created_at_absent";
  const created = Date.parse(createdAt);
  const started = Date.parse(startedAt);
  if (!Number.isFinite(created) || !Number.isFinite(started)) {
    return "created_at_absent";
  }
  if (
    created < started - CLEANUP_TIME_SKEW_MS ||
    created > nowMs + CLEANUP_TIME_SKEW_MS
  ) {
    return "created_at_outside_window";
  }
  return "in_window";
}

export function reviewCleanupManifest(
  input: unknown,
  identity: CleanupIdentity,
):
  | { ok: true; manifest: CleanupManifest; complete: boolean }
  | { ok: false; reason: string } {
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
  if (!isDigits(identity.runId) || input.runId !== identity.runId) {
    return { ok: false, reason: "manifest_run" };
  }
  if (
    !isDigits(identity.runAttempt) ||
    input.runAttempt !== identity.runAttempt
  ) {
    return { ok: false, reason: "manifest_run_attempt" };
  }
  if (!isNonce(identity.runNonce)) {
    return { ok: false, reason: "manifest_nonce" };
  }
  if ("runNonce" in input && input.runNonce !== identity.runNonce) {
    return { ok: false, reason: "manifest_nonce" };
  }
  if (!Number.isFinite(Date.parse(identity.startedAt))) {
    return { ok: false, reason: "started_at_absent" };
  }
  if ("startedAt" in input && input.startedAt !== identity.startedAt) {
    return { ok: false, reason: "manifest_started_at" };
  }
  const users = reviewUsers(input.users);
  if (!users.ok) return users;
  const clients = reviewClients(input.clients);
  if (!clients.ok) return clients;
  const manifest: CleanupManifest = {
    version: 1,
    environment: "development",
    projectRef: CLEANUP_PROJECT_REF,
    commit: identity.commit,
    runId: identity.runId,
    runAttempt: identity.runAttempt,
    users: users.users,
    clients: clients.clients,
  };
  return {
    ok: true,
    manifest,
    complete: users.complete && clients.complete,
  };
}

/**
 * Writes a complete manifest and then renames it into place so a killed
 * writer cannot leave a truncated file at the manifest path.
 */
export function writeManifestAtomic(filePath: string, body: string): void {
  const temporary = `${filePath}.${process.pid}.tmp`;
  writeFileSync(temporary, body);
  renameSync(temporary, filePath);
}

/**
 * Append one manifest job output. The value is not masked: Actions drops a
 * masked job output. The body is written to the output file, not through a
 * shell. An oversized body is refused before any write.
 */
export function writeManifestOutput(
  body: string,
  outputPath: string | undefined,
): void {
  if (Buffer.byteLength(body, "utf8") > MANIFEST_MAX_BYTES) {
    throw new Error("manifest_oversize");
  }
  if (!outputPath) {
    if (process.env.GITHUB_ACTIONS === "true") {
      throw new Error("manifest_output_absent");
    }
    return;
  }
  let delimiter = "";
  do {
    delimiter = `MANIFEST_${randomBytes(16).toString("hex")}`;
  } while (body.includes(delimiter));
  appendFileSync(
    outputPath,
    `${MANIFEST_OUTPUT_NAME}<<${delimiter}\n${body}\n${delimiter}\n`,
  );
}

function reviewUsers(
  value: unknown,
):
  | { ok: true; users: CleanupUser[]; complete: boolean }
  | { ok: false; reason: string } {
  if (!Array.isArray(value) || value.length > CLEANUP_USER_LABELS.length) {
    return { ok: false, reason: "manifest_users" };
  }
  const users: CleanupUser[] = [];
  const labels = new Set<string>();
  let complete = true;
  for (const entry of value) {
    if (!isRecord(entry)) return { ok: false, reason: "manifest_users" };
    const label = entry.label;
    if (
      typeof label !== "string" ||
      !CLEANUP_USER_LABELS.includes(label as CleanupUserLabel) ||
      labels.has(label)
    ) {
      return { ok: false, reason: "manifest_users" };
    }
    labels.add(label);
    if (entry.id === undefined) {
      complete = false;
      users.push({ label: label as CleanupUserLabel });
      continue;
    }
    if (typeof entry.id !== "string" || !UUID.test(entry.id)) {
      return { ok: false, reason: "manifest_users" };
    }
    users.push({ label: label as CleanupUserLabel, id: entry.id });
  }
  return { ok: true, users, complete };
}

function reviewClients(
  value: unknown,
):
  | { ok: true; clients: CleanupClient[]; complete: boolean }
  | { ok: false; reason: string } {
  if (!Array.isArray(value) || value.length > CLEANUP_CLIENT_LABELS.length) {
    return { ok: false, reason: "manifest_clients" };
  }
  const clients: CleanupClient[] = [];
  const labels = new Set<string>();
  const ids = new Set<string>();
  let complete = true;
  for (const entry of value) {
    if (!isRecord(entry)) return { ok: false, reason: "manifest_clients" };
    const label = entry.label;
    if (
      typeof label !== "string" ||
      !CLEANUP_CLIENT_LABELS.includes(label as CleanupClientLabel) ||
      labels.has(label)
    ) {
      return { ok: false, reason: "manifest_clients" };
    }
    labels.add(label);
    if (entry.id === undefined) {
      complete = false;
      clients.push({ label: label as CleanupClientLabel });
      continue;
    }
    if (
      typeof entry.id !== "string" ||
      !UUID.test(entry.id) ||
      ids.has(entry.id)
    ) {
      return { ok: false, reason: "manifest_clients" };
    }
    ids.add(entry.id);
    clients.push({ label: label as CleanupClientLabel, id: entry.id });
  }
  return { ok: true, clients, complete };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSha(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

function isDigits(value: string): boolean {
  return /^[0-9]+$/.test(value);
}

function isNonce(value: string): boolean {
  return /^[a-f0-9]{32}$/.test(value);
}
