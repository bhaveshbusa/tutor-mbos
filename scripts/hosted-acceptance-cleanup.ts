/**
 * Development-only Auth admin cleanup. A separate job from the business
 * acceptance tests. It checks out the reviewed SHA itself, installs from
 * the lockfile, and receives the admin key plus the run identity minted
 * by the preflight job. It does not receive the app database URL, the
 * Management API token, or the business job's workspace. The manifest is
 * untrusted data. Ids are deleted only after GET confirms the email or
 * client name derived from the trusted nonce, the redirect, and a
 * created_at inside this run's window.
 */
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  AUTH_ADMIN_KEY_SECRET,
  CLEANUP_CLIENT_LABELS,
  CLEANUP_REDIRECT_URI,
  CLEANUP_USER_LABELS,
  adminRequestHeaders,
  createdAtInRunWindow,
  expectedCleanupEmail,
  expectedClientName,
  reviewCleanupManifest,
  type CleanupClient,
  type CleanupClientLabel,
  type CleanupIdentity,
  type CleanupManifest,
  type CleanupUser,
  type CleanupUserLabel,
} from "../src/server/application/acceptance-cleanup.ts";
import {
  ENVIRONMENT_BINDINGS,
  supabaseUrlFor,
} from "../src/server/config/environments.ts";

const MANIFEST_PATH = "acceptance-cleanup-manifest.json";
const REQUEST_TIMEOUT_MS = 15_000;

export interface CleanupExecution {
  status: "pass" | "fail";
  usersDeleted: number;
  clientsDeleted: number;
  detail: string;
}

interface AdminReply {
  status: number;
  body: unknown;
}

export async function runAcceptanceCleanup(input: {
  manifestText: string | null;
  adminKey: string | null;
  identity: CleanupIdentity;
  supabaseUrl: string;
  fetchImpl?: typeof fetch;
  nowMs?: number;
}): Promise<CleanupExecution> {
  const none = (detail: string): CleanupExecution => ({
    status: "fail",
    usersDeleted: 0,
    clientsDeleted: 0,
    detail,
  });
  if (!/^[a-f0-9]{32}$/.test(input.identity.runNonce))
    return none("nonce_absent");
  if (!/^[0-9]+$/.test(input.identity.runAttempt)) {
    return none("run_attempt_absent");
  }
  if (!Number.isFinite(Date.parse(input.identity.startedAt))) {
    return none("started_at_absent");
  }
  if (!input.adminKey) return none(`secret_absent:${AUTH_ADMIN_KEY_SECRET}`);
  const headers = adminRequestHeaders(input.adminKey);
  if (!headers) return none("admin_key_type");
  const fetchImpl = input.fetchImpl ?? fetch;
  const nowMs = input.nowMs ?? Date.now();
  const context = {
    fetchImpl,
    supabaseUrl: input.supabaseUrl,
    headers,
    identity: input.identity,
    nowMs,
  };

  const loaded = loadManifest(input.manifestText, input.identity);
  if (!loaded.ok) {
    const recovered = await recoverByNonce(context);
    return {
      status: "fail",
      usersDeleted: recovered.usersDeleted,
      clientsDeleted: recovered.clientsDeleted,
      detail: joinDetail(loaded.reason, recovered),
    };
  }

  const users = await deleteListedUsers(context, loaded.manifest.users);
  const clients = await deleteListedClients(context, loaded.manifest.clients);
  const failures = [...users.failures, ...clients.failures];
  if (!loaded.complete) {
    const missing = failures.some((failure) => failure.startsWith("not_found"));
    return {
      status: "fail",
      usersDeleted: users.deleted,
      clientsDeleted: clients.deleted,
      detail: missing
        ? "response_lost_unrecovered"
        : `response_lost recovered_users=${users.deleted} recovered_clients=${clients.deleted}`,
    };
  }
  const pass =
    users.deleted === loaded.manifest.users.length &&
    clients.deleted === loaded.manifest.clients.length &&
    failures.length === 0;
  return {
    status: pass ? "pass" : "fail",
    usersDeleted: users.deleted,
    clientsDeleted: clients.deleted,
    detail: pass
      ? "verified_run_resources_removed"
      : failures.join(",") || "cleanup_incomplete",
  };
}

function loadManifest(
  manifestText: string | null,
  identity: CleanupIdentity,
):
  | { ok: true; manifest: CleanupManifest; complete: boolean }
  | { ok: false; reason: string } {
  if (!manifestText) return { ok: false, reason: "manifest_absent" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestText) as unknown;
  } catch {
    return { ok: false, reason: "manifest_invalid" };
  }
  const reviewed = reviewCleanupManifest(parsed, identity);
  if (!reviewed.ok) return reviewed;
  return { ok: true, manifest: reviewed.manifest, complete: reviewed.complete };
}

interface RequestContext {
  fetchImpl: typeof fetch;
  supabaseUrl: string;
  headers: Record<string, string>;
  identity: CleanupIdentity;
  nowMs: number;
}

async function deleteListedUsers(
  context: RequestContext,
  users: readonly CleanupUser[],
): Promise<{ deleted: number; failures: string[] }> {
  let deleted = 0;
  const failures: string[] = [];
  for (const user of users) {
    const outcome = user.id
      ? await deleteUserById(context, user.label, user.id, true)
      : await deleteUserByEmail(context, user.label);
    if (outcome === "deleted") deleted += 1;
    else failures.push(`${outcome}:${user.label}`);
  }
  return { deleted, failures };
}

async function deleteListedClients(
  context: RequestContext,
  clients: readonly CleanupClient[],
): Promise<{ deleted: number; failures: string[] }> {
  let deleted = 0;
  const failures: string[] = [];
  for (const client of clients) {
    const outcome = client.id
      ? await deleteClientById(context, client.label, client.id, true)
      : await deleteClientByName(context, client.label);
    if (outcome === "deleted") deleted += 1;
    else failures.push(`${outcome}:${client.label}`);
  }
  return { deleted, failures };
}

async function recoverByNonce(context: RequestContext): Promise<{
  usersDeleted: number;
  clientsDeleted: number;
  notes: string[];
}> {
  const notes: string[] = [];
  let usersDeleted = 0;
  let clientsDeleted = 0;
  for (const label of CLEANUP_USER_LABELS) {
    const outcome = await deleteUserByEmail(context, label);
    if (outcome === "deleted") usersDeleted += 1;
    else if (outcome !== "not_found") notes.push(`${outcome}:${label}`);
  }
  for (const label of CLEANUP_CLIENT_LABELS) {
    const outcome = await deleteClientByName(context, label);
    if (outcome === "deleted") clientsDeleted += 1;
    else if (outcome !== "not_found") notes.push(`${outcome}:${label}`);
  }
  return { usersDeleted, clientsDeleted, notes };
}

function joinDetail(
  reason: string,
  recovered: { usersDeleted: number; clientsDeleted: number; notes: string[] },
): string {
  const counts = `recovered_users=${recovered.usersDeleted} recovered_clients=${recovered.clientsDeleted}`;
  const notes =
    recovered.notes.length > 0 ? ` ${recovered.notes.join(",")}` : "";
  return `${reason} ${counts}${notes}`;
}

async function deleteUserById(
  context: RequestContext,
  label: CleanupUserLabel,
  id: string,
  discover: boolean,
): Promise<
  | "deleted"
  | "email_mismatch"
  | "not_found"
  | "user_ambiguous"
  | "user_get_failed"
  | "user_delete_failed"
  | "created_at_absent"
  | "created_at_outside_window"
> {
  const url = `${context.supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(id)}`;
  const found = await adminRequest(context, url, "GET");
  if (!found) return "user_get_failed";
  if (found.status === 404) {
    if (!discover) return "deleted";
    const located = await deleteUserByEmail(context, label);
    return located === "not_found" ? "deleted" : located;
  }
  if (found.status !== 200) return "user_get_failed";
  const record = asRecord(found.body);
  if (
    record?.email !== expectedCleanupEmail(label, context.identity.runNonce)
  ) {
    return "email_mismatch";
  }
  const window = createdAtInRunWindow(
    record?.created_at,
    context.identity.startedAt,
    context.nowMs,
  );
  if (window !== "in_window") return window;
  const removed = await deleteVerified(context, url);
  return removed ? "deleted" : "user_delete_failed";
}

async function deleteUserByEmail(
  context: RequestContext,
  label: CleanupUserLabel,
): Promise<
  | "deleted"
  | "not_found"
  | "email_mismatch"
  | "user_ambiguous"
  | "user_get_failed"
  | "user_delete_failed"
  | "created_at_absent"
  | "created_at_outside_window"
> {
  const email = expectedCleanupEmail(label, context.identity.runNonce);
  const listed = await adminRequest(
    context,
    `${context.supabaseUrl}/auth/v1/admin/users?page=1&per_page=2&filter=${encodeURIComponent(email)}`,
    "GET",
  );
  if (!listed || listed.status !== 200) return "user_get_failed";
  const matches = listRecords(listed.body, "users").filter(
    (user) => user.email === email && typeof user.id === "string",
  );
  if (matches.length === 0) return "not_found";
  if (matches.length !== 1) return "user_ambiguous";
  const id = matches[0]?.id;
  if (typeof id !== "string") return "user_get_failed";
  return deleteUserById(context, label, id, false);
}

async function deleteClientById(
  context: RequestContext,
  label: CleanupClientLabel,
  id: string,
  discover: boolean,
): Promise<
  | "deleted"
  | "not_found"
  | "client_ambiguous"
  | "client_mismatch"
  | "client_get_failed"
  | "client_delete_failed"
  | "created_at_absent"
  | "created_at_outside_window"
> {
  const url = `${context.supabaseUrl}/auth/v1/admin/oauth/clients/${encodeURIComponent(id)}`;
  const found = await adminRequest(context, url, "GET");
  if (!found) return "client_get_failed";
  if (found.status === 404) {
    if (!discover) return "deleted";
    const located = await deleteClientByName(context, label);
    return located === "not_found" ? "deleted" : located;
  }
  if (found.status !== 200) return "client_get_failed";
  if (!clientMatchesRun(found.body, label, context)) return "client_mismatch";
  const window = createdAtInRunWindow(
    asRecord(found.body)?.created_at,
    context.identity.startedAt,
    context.nowMs,
  );
  if (window !== "in_window") return window;
  const removed = await deleteVerified(context, url, 204);
  return removed ? "deleted" : "client_delete_failed";
}

async function deleteClientByName(
  context: RequestContext,
  label: CleanupClientLabel,
): Promise<
  | "deleted"
  | "not_found"
  | "client_ambiguous"
  | "client_get_failed"
  | "client_delete_failed"
  | "client_mismatch"
  | "created_at_absent"
  | "created_at_outside_window"
> {
  const listed = await adminRequest(
    context,
    `${context.supabaseUrl}/auth/v1/admin/oauth/clients`,
    "GET",
  );
  if (!listed || listed.status !== 200) return "client_get_failed";
  const expected = expectedClientName(label, context.identity.runNonce);
  const matches = listRecords(listed.body, "clients").filter(
    (client) =>
      client.client_name === expected && typeof client.id === "string",
  );
  if (matches.length === 0) return "not_found";
  if (matches.length !== 1) return "client_ambiguous";
  const id = matches[0]?.id;
  if (typeof id !== "string") return "client_get_failed";
  return deleteClientById(context, label, id, false);
}

function clientMatchesRun(
  body: unknown,
  label: CleanupClientLabel,
  context: RequestContext,
): boolean {
  const record = asRecord(body);
  const redirects = Array.isArray(record?.redirect_uris)
    ? record.redirect_uris
    : [];
  return (
    record?.client_name ===
      expectedClientName(label, context.identity.runNonce) &&
    redirects.length === 1 &&
    redirects[0] === CLEANUP_REDIRECT_URI
  );
}

async function deleteVerified(
  context: RequestContext,
  url: string,
  onlyStatus?: number,
): Promise<boolean> {
  const removed = await adminRequest(context, url, "DELETE");
  if (!removed) return false;
  if (removed.status === 404) return true;
  if (onlyStatus !== undefined) return removed.status === onlyStatus;
  return removed.status === 200 || removed.status === 204;
}

function listRecords(
  body: unknown,
  key: "users" | "clients",
): Record<string, unknown>[] {
  const source = Array.isArray(body) ? body : asRecord(body)?.[key];
  if (!Array.isArray(source)) return [];
  return source.map((entry) => {
    const record = asRecord(entry) ?? {};
    const id =
      typeof record.id === "string"
        ? record.id
        : typeof record.client_id === "string"
          ? record.client_id
          : undefined;
    return id ? { ...record, id } : record;
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function adminRequest(
  context: RequestContext,
  url: string,
  method: "GET" | "DELETE",
): Promise<AdminReply | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timer.unref?.();
  try {
    const response = await context.fetchImpl(url, {
      method,
      headers: context.headers,
      redirect: "manual",
      signal: controller.signal,
    });
    const text = await response.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = null;
      }
    }
    return { status: response.status, body };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function formatCleanupExecution(result: CleanupExecution): string {
  return [
    `cleanup_result=${result.status}`,
    `users_deleted=${result.usersDeleted}`,
    `clients_deleted=${result.clientsDeleted}`,
    `detail=${result.detail}`,
    "sessions_removed_by_user_delete=true",
  ].join("\n");
}

function mask(value: string | null | undefined): void {
  if (value && process.env.GITHUB_ACTIONS === "true") {
    console.log(`::add-mask::${value}`);
  }
}

function cleanupGuard(env: Record<string, string | undefined>): string | null {
  if (
    env.TUTOR_MBOS_ACCEPTANCE !== "development" ||
    env.GITHUB_ACTIONS !== "true"
  ) {
    return "Auth admin cleanup runs only from the protected development workflow.";
  }
  if (env.GITHUB_REF && env.GITHUB_REF !== "refs/heads/main") {
    return "Auth admin cleanup runs from main only.";
  }
  return null;
}

async function main(): Promise<number> {
  const guard = cleanupGuard(process.env);
  if (guard) {
    console.error(`::error::${guard}`);
    return 2;
  }
  const adminKey = process.env[AUTH_ADMIN_KEY_SECRET] ?? null;
  mask(adminKey);
  const identity: CleanupIdentity = {
    projectRef: ENVIRONMENT_BINDINGS.development.supabaseProjectRef,
    commit: process.env.GITHUB_SHA ?? "",
    runId: process.env.GITHUB_RUN_ID ?? "",
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? "",
    runNonce: process.env.ACCEPTANCE_RUN_NONCE ?? "",
    startedAt: process.env.ACCEPTANCE_STARTED_AT ?? "",
  };
  const manifestText = existsSync(MANIFEST_PATH)
    ? readFileSync(MANIFEST_PATH, "utf8")
    : null;
  const result = await runAcceptanceCleanup({
    manifestText,
    adminKey,
    identity,
    supabaseUrl: supabaseUrlFor(identity.projectRef),
  });
  console.log(formatCleanupExecution(result));
  return result.status === "pass" ? 0 : 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = await main();
}
