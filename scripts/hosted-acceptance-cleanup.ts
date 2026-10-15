/**
 * Development-only Auth admin cleanup. A separate process from the
 * business acceptance tests. It receives the admin key and the run
 * identity. It does not receive the app database URL or the Management
 * API token. The manifest is untrusted: ids are deleted only after GET
 * confirms the email, client name, and redirect registered for this run.
 */
import { readFileSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  AUTH_ADMIN_KEY_SECRET,
  CLEANUP_REDIRECT_URI,
  expectedCleanupEmail,
  reviewCleanupManifest,
  type CleanupClient,
  type CleanupIdentity,
  type CleanupManifest,
  type CleanupUser,
} from "../src/server/application/acceptance-cleanup.ts";
import {
  ENVIRONMENT_BINDINGS,
  supabaseUrlFor,
} from "../src/server/config/environments.ts";

const MANIFEST_PATH = "acceptance-cleanup-manifest.json";

export interface CleanupExecution {
  status: "pass" | "fail";
  usersDeleted: number;
  clientsDeleted: number;
  detail: string;
}

export async function runAcceptanceCleanup(input: {
  manifestText: string | null;
  adminKey: string | null;
  identity: CleanupIdentity;
  supabaseUrl: string;
  fetchImpl?: typeof fetch;
}): Promise<CleanupExecution> {
  const none = (detail: string): CleanupExecution => ({
    status: "fail",
    usersDeleted: 0,
    clientsDeleted: 0,
    detail,
  });
  if (!input.manifestText) return none("manifest_absent");
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.manifestText) as unknown;
  } catch {
    return none("manifest_invalid");
  }
  const reviewed = reviewCleanupManifest(parsed, input.identity);
  if (!reviewed.ok) return none(reviewed.reason);
  if (!input.adminKey) return none(`secret_absent:${AUTH_ADMIN_KEY_SECRET}`);
  const fetchImpl = input.fetchImpl ?? fetch;
  const usersDeleted = await deleteUsers(
    fetchImpl,
    input.supabaseUrl,
    input.adminKey,
    input.identity.runNonce,
    reviewed.manifest,
  );
  const clientsDeleted = await deleteClients(
    fetchImpl,
    input.supabaseUrl,
    input.adminKey,
    reviewed.manifest,
  );
  const pass =
    usersDeleted.deleted === reviewed.manifest.users.length &&
    clientsDeleted.deleted === reviewed.manifest.clients.length &&
    usersDeleted.failures.length === 0 &&
    clientsDeleted.failures.length === 0;
  const detail = pass
    ? "verified_run_resources_removed"
    : [...usersDeleted.failures, ...clientsDeleted.failures].join(",") ||
      "cleanup_incomplete";
  return {
    status: pass ? "pass" : "fail",
    usersDeleted: usersDeleted.deleted,
    clientsDeleted: clientsDeleted.deleted,
    detail,
  };
}

async function deleteUsers(
  fetchImpl: typeof fetch,
  supabaseUrl: string,
  adminKey: string,
  nonce: string,
  manifest: CleanupManifest,
): Promise<{ deleted: number; failures: string[] }> {
  let deleted = 0;
  const failures: string[] = [];
  for (const user of manifest.users) {
    const outcome = await deleteUser(
      fetchImpl,
      supabaseUrl,
      adminKey,
      nonce,
      user,
    );
    if (outcome === "deleted") deleted += 1;
    else failures.push(`${outcome}:${user.label}`);
  }
  return { deleted, failures };
}

async function deleteUser(
  fetchImpl: typeof fetch,
  supabaseUrl: string,
  adminKey: string,
  nonce: string,
  user: CleanupUser,
): Promise<
  "deleted" | "email_mismatch" | "user_get_failed" | "user_delete_failed"
> {
  const url = `${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(user.id)}`;
  const found = await adminRequest(fetchImpl, url, "GET", adminKey);
  if (!found || found.status !== 200) return "user_get_failed";
  const email = (found.body as { email?: unknown } | null)?.email;
  if (email !== expectedCleanupEmail(user.label, nonce))
    return "email_mismatch";
  const removed = await adminRequest(fetchImpl, url, "DELETE", adminKey);
  if (!removed || (removed.status !== 200 && removed.status !== 204)) {
    return "user_delete_failed";
  }
  return "deleted";
}

async function deleteClients(
  fetchImpl: typeof fetch,
  supabaseUrl: string,
  adminKey: string,
  manifest: CleanupManifest,
): Promise<{ deleted: number; failures: string[] }> {
  let deleted = 0;
  const failures: string[] = [];
  for (const client of manifest.clients) {
    const outcome = await deleteClient(
      fetchImpl,
      supabaseUrl,
      adminKey,
      client,
    );
    if (outcome === "deleted") deleted += 1;
    else failures.push(`${outcome}:${client.name}`);
  }
  return { deleted, failures };
}

async function deleteClient(
  fetchImpl: typeof fetch,
  supabaseUrl: string,
  adminKey: string,
  client: CleanupClient,
): Promise<
  "deleted" | "client_mismatch" | "client_get_failed" | "client_delete_failed"
> {
  const url = `${supabaseUrl}/auth/v1/admin/oauth/clients/${encodeURIComponent(client.id)}`;
  const found = await adminRequest(fetchImpl, url, "GET", adminKey);
  if (!found || found.status !== 200) return "client_get_failed";
  const body = found.body as {
    client_name?: unknown;
    redirect_uris?: unknown;
  } | null;
  const redirects = Array.isArray(body?.redirect_uris)
    ? body.redirect_uris
    : [];
  if (
    body?.client_name !== client.name ||
    redirects.length !== 1 ||
    redirects[0] !== CLEANUP_REDIRECT_URI
  ) {
    return "client_mismatch";
  }
  const removed = await adminRequest(fetchImpl, url, "DELETE", adminKey);
  if (!removed || removed.status !== 204) return "client_delete_failed";
  return "deleted";
}

async function adminRequest(
  fetchImpl: typeof fetch,
  url: string,
  method: "GET" | "DELETE",
  adminKey: string,
): Promise<{ status: number; body: unknown } | null> {
  try {
    const response = await fetchImpl(url, {
      method,
      headers: {
        apikey: adminKey,
        authorization: `Bearer ${adminKey}`,
        accept: "application/json",
      },
      redirect: "manual",
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
    runNonce: process.env.ACCEPTANCE_RUN_NONCE ?? "",
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
