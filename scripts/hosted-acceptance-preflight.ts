/**
 * Development-only acceptance preflight. A separate job from business
 * tests and from cleanup. It checks the Auth admin credential with one
 * read-only request, reads Auth and PostgREST settings, and only then
 * mints the run nonce. It does not create users or clients.
 */
import { randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  ADMIN_CAPABILITY_PATH,
  AUTH_ADMIN_KEY_SECRET,
  adminRequestHeaders,
} from "../src/server/application/acceptance-cleanup.ts";
import {
  MANAGEMENT_TOKEN_SECRET,
  blockedCases,
  classifyAuthSettings,
  classifyExposedSchemas,
  encodePreflightCases,
  type AcceptanceCase,
  type AuthConfigSnapshot,
} from "../src/server/application/hosted-acceptance.ts";
import { siteOriginFor } from "../src/server/config/access.ts";
import {
  ENVIRONMENT_BINDINGS,
  supabaseUrlFor,
} from "../src/server/config/environments.ts";

const REQUEST_TIMEOUT_MS = 15_000;
const MANAGEMENT_IDS = [
  "auth.oauth_server_enabled",
  "auth.dynamic_registration",
  "auth.authorization_path",
  "auth.site_url",
  "auth.redirect_allow_list",
  "auth.secure_password_change",
  "auth.exposed_schemas",
] as const;

export interface PreflightResult {
  ok: boolean;
  reason: string;
  nonce: string | null;
  startedAt: string | null;
  cases: AcceptanceCase[];
}

export async function runAcceptancePreflight(input: {
  adminKey: string | null;
  managementToken: string | null;
  supabaseUrl: string;
  site: string;
  projectRef: string;
  fetchImpl?: typeof fetch;
  randomBytes?: (size: number) => Buffer;
  now?: () => Date;
}): Promise<PreflightResult> {
  const empty = (
    reason: string,
    cases: AcceptanceCase[] = [],
  ): PreflightResult => ({
    ok: false,
    reason,
    nonce: null,
    startedAt: null,
    cases,
  });
  if (!input.adminKey) {
    return empty(`secret_absent:${AUTH_ADMIN_KEY_SECRET}`);
  }
  const headers = adminRequestHeaders(input.adminKey);
  if (!headers) return empty("admin_key_type");
  const fetchImpl = input.fetchImpl ?? fetch;
  const capability = await adminGet(
    fetchImpl,
    `${input.supabaseUrl}${ADMIN_CAPABILITY_PATH}`,
    headers,
  );
  if (!capability) return empty("admin_capability_unreachable");
  if (capability.status !== 200) {
    return empty(`admin_capability_http_${capability.status}`);
  }
  const cases = await managementCases(
    fetchImpl,
    input.managementToken,
    input.projectRef,
    input.site,
  );
  const nonce = (input.randomBytes ?? randomBytes)(16).toString("hex");
  const startedAt = (input.now ?? (() => new Date()))().toISOString();
  return {
    ok: true,
    reason: "admin_capability_http_200",
    nonce,
    startedAt,
    cases,
  };
}

async function managementCases(
  fetchImpl: typeof fetch,
  token: string | null,
  projectRef: string,
  site: string,
): Promise<AcceptanceCase[]> {
  if (!token) {
    return blockedCases(
      MANAGEMENT_IDS,
      `secret_absent:${MANAGEMENT_TOKEN_SECRET}`,
    );
  }
  const auth = await managementGet(
    fetchImpl,
    `https://api.supabase.com/v1/projects/${projectRef}/config/auth`,
    token,
  );
  const cases: AcceptanceCase[] = [];
  if (!auth || auth.status !== 200) {
    cases.push(
      ...blockedCases(
        MANAGEMENT_IDS.filter((id) => id !== "auth.exposed_schemas"),
        `management_auth=http_${auth?.status ?? "unreachable"}`,
      ),
    );
  } else {
    cases.push(...classifyAuthSettings(authSnapshot(auth.body), site));
  }
  const rest = await managementGet(
    fetchImpl,
    `https://api.supabase.com/v1/projects/${projectRef}/postgrest`,
    token,
  );
  if (!rest || rest.status !== 200) {
    cases.push({
      id: "auth.exposed_schemas",
      status: "fail",
      detail: `management_postgrest=http_${rest?.status ?? "unreachable"}`,
    });
    return cases;
  }
  const schema = (rest.body as { db_schema?: unknown } | null)?.db_schema;
  cases.push(classifyExposedSchemas(typeof schema === "string" ? schema : ""));
  return cases;
}

function authSnapshot(body: unknown): AuthConfigSnapshot {
  const record =
    typeof body === "object" && body !== null
      ? (body as Record<string, unknown>)
      : {};
  return {
    oauth_server_enabled: record.oauth_server_enabled,
    oauth_server_allow_dynamic_registration:
      record.oauth_server_allow_dynamic_registration,
    oauth_server_authorization_path: record.oauth_server_authorization_path,
    site_url: record.site_url,
    uri_allow_list: record.uri_allow_list,
    security_update_password_require_reauthentication:
      record.security_update_password_require_reauthentication,
  };
}

async function adminGet(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timer.unref?.();
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers,
      redirect: "manual",
      signal: controller.signal,
    });
    await response.text();
    return { status: response.status };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function managementGet(
  fetchImpl: typeof fetch,
  url: string,
  token: string,
): Promise<{ status: number; body: unknown } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timer.unref?.();
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      redirect: "manual",
      signal: controller.signal,
    });
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? (JSON.parse(text) as unknown) : null;
    } catch {
      body = null;
    }
    return { status: response.status, body };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function mask(value: string | null | undefined): void {
  if (value && process.env.GITHUB_ACTIONS === "true") {
    console.log(`::add-mask::${value}`);
  }
}

function writeOutput(name: string, value: string): void {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) return;
  appendFileSync(output, `${name}=${value}\n`);
}

function preflightGuard(
  env: Record<string, string | undefined>,
): string | null {
  if (
    env.TUTOR_MBOS_ACCEPTANCE !== "development" ||
    env.GITHUB_ACTIONS !== "true"
  ) {
    return "Acceptance preflight runs only from the protected development workflow.";
  }
  if (env.GITHUB_REF && env.GITHUB_REF !== "refs/heads/main") {
    return "Acceptance preflight runs from main only.";
  }
  return null;
}

async function main(): Promise<number> {
  const guard = preflightGuard(process.env);
  if (guard) {
    console.error(`::error::${guard}`);
    return 2;
  }
  const adminKey = process.env[AUTH_ADMIN_KEY_SECRET] ?? null;
  const managementToken = process.env[MANAGEMENT_TOKEN_SECRET] ?? null;
  mask(adminKey);
  mask(managementToken);
  const ref = ENVIRONMENT_BINDINGS.development.supabaseProjectRef;
  const result = await runAcceptancePreflight({
    adminKey,
    managementToken,
    supabaseUrl: supabaseUrlFor(ref),
    site: siteOriginFor("development"),
    projectRef: ref,
  });
  if (!result.ok || !result.nonce || !result.startedAt) {
    console.error(`::error::${result.reason}`);
    return 1;
  }
  mask(result.nonce);
  writeOutput("nonce", result.nonce);
  writeOutput("started_at", result.startedAt);
  writeOutput("cases", encodePreflightCases(result.cases));
  console.log(`admin_capability=${result.reason}`);
  console.log(`preflight_cases=${result.cases.length}`);
  return 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = await main();
}
