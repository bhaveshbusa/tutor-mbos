/**
 * Classifiers for the development hosted-acceptance harness.
 * This module does not open connections or read credentials.
 */
import type { Sql, SqlConnection } from "./sql";

export type AcceptanceStatus = "pass" | "fail" | "gap";

export interface AcceptanceCase {
  id: string;
  status: AcceptanceStatus;
  detail: string;
}

export interface AcceptanceReport {
  environment: "development";
  source: string;
  deployedCommit: string;
  closingCommit: string;
  schema: string;
  results: AcceptanceCase[];
}

export const MANAGEMENT_TOKEN_SECRET = "SUPABASE_DEVELOPMENT_ACCESS_TOKEN";
export const APP_DATABASE_URL_SECRET = "TUTOR_MBOS_APP_DATABASE_URL";
export const PUBLISHABLE_KEY_NAME = "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY";

/** GitHub environment secret location. Values are never read by this module. */
export const DEVELOPMENT_SECRET_LOCATION =
  "GitHub → Settings → Environments → development → Secrets";

/**
 * Read-only Management API token for development project
 * idvzjqrkgnihvxoswuxu. Required permissions: auth_config_read and
 * data_api_config_read. The harness calls GET only. It must not be a
 * service-role key and it must not include auth_config_write.
 */
export const MANAGEMENT_TOKEN_PURPOSE =
  "Read development Auth settings and PostgREST exposed schemas. GET only.";

/**
 * The development app_runtime connection already used by the deployed app.
 * The harness sets the synthetic user's JWT claims and SET LOCAL ROLE
 * app_request. It is not the migration URL and it is not a privileged login.
 */
export const APP_DATABASE_URL_PURPOSE =
  "Development app_runtime connection for direct tenant reads and scoped business-row cleanup.";

export const EXPECTED_AUTHORIZATION_PATH = "/oauth/consent";

export const REAL_CLIENT_GAPS: readonly AcceptanceCase[] = [
  {
    id: "client.chatgpt",
    status: "gap",
    detail:
      "Supabase MCP authentication requires the ChatGPT product to discover the protected resource, dynamically register, and complete consent in a ChatGPT account (https://supabase.com/docs/guides/auth/oauth-server/mcp-authentication). GitHub Actions and the Management API have no method that authorizes that product. generic_client evidence is not ChatGPT.",
  },
  {
    id: "client.second_mcp",
    status: "gap",
    detail:
      "A second real MCP product has the same account-consent limitation. No supported cloud API completes that product's authorization. Another generic registration would still be generic_client.",
  },
];

const APP_PATH_MARKERS = [
  "businesses",
  "client_grants",
  "oauth_consents",
  "access_audit",
  "business_creation_keys",
  "setup_report",
];

export function secretAbsent(name: string): string {
  return `secret_absent:${name} location=GitHub environment development`;
}

export function acceptanceCase(
  id: string,
  status: AcceptanceStatus,
  detail: string,
): AcceptanceCase {
  return { id, status, detail: sanitizeDetail(detail) };
}

export function sanitizeDetail(value: string): string {
  return value
    .replace(/[\r\n]+/g, " ")
    .replace(/sb_secret_[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/sb_publishable_[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/sbp_[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted]")
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[redacted]")
    .replace(/SCRAM-SHA-256\$\S+/g, "[redacted]")
    .trim();
}

export function schemaIdentity(
  migrations: readonly { version: string; sha256: string }[],
): string {
  return migrations.map((row) => `${row.version}:${row.sha256}`).join(" ");
}

export function acceptanceTally(results: readonly AcceptanceCase[]): {
  result: "pass" | "incomplete" | "fail";
  passed: number;
  failed: number;
  gaps: number;
  exitCode: number;
} {
  const passed = results.filter((row) => row.status === "pass").length;
  const failed = results.filter((row) => row.status === "fail").length;
  const gaps = results.filter((row) => row.status === "gap").length;
  const result = failed > 0 ? "fail" : gaps > 0 ? "incomplete" : "pass";
  return { result, passed, failed, gaps, exitCode: failed > 0 ? 1 : 0 };
}

export const MANAGEMENT_CASE_IDS = [
  "auth.oauth_server_enabled",
  "auth.dynamic_registration",
  "auth.authorization_path",
  "auth.site_url",
  "auth.redirect_allow_list",
  "auth.secure_password_change",
  "auth.exposed_schemas",
] as const;

/** Job-output encoding for preflight cases. The business job does not call the Management API. */
export function encodePreflightCases(cases: readonly AcceptanceCase[]): string {
  return Buffer.from(JSON.stringify(cases), "utf8").toString("base64");
}

export function decodePreflightCases(encoded: string): AcceptanceCase[] | null {
  try {
    const parsed = JSON.parse(
      Buffer.from(encoded, "base64").toString("utf8"),
    ) as unknown;
    if (!Array.isArray(parsed)) return null;
    const cases: AcceptanceCase[] = [];
    for (const entry of parsed) {
      if (typeof entry !== "object" || entry === null) return null;
      const row = entry as Record<string, unknown>;
      if (
        typeof row.id !== "string" ||
        !MANAGEMENT_CASE_IDS.includes(
          row.id as (typeof MANAGEMENT_CASE_IDS)[number],
        ) ||
        (row.status !== "pass" &&
          row.status !== "fail" &&
          row.status !== "gap") ||
        typeof row.detail !== "string"
      ) {
        return null;
      }
      cases.push({
        id: row.id,
        status: row.status,
        detail: sanitizeDetail(row.detail),
      });
    }
    const ids = new Set(cases.map((row) => row.id));
    if (ids.size !== cases.length || ids.size !== MANAGEMENT_CASE_IDS.length) {
      return null;
    }
    return cases;
  } catch {
    return null;
  }
}

export function formatAcceptanceReport(report: AcceptanceReport): string {
  const tally = acceptanceTally(report.results);
  const lines = [
    "environment=development",
    `source=${sanitizeDetail(report.source) || "absent"}`,
    `deployed_commit=${sanitizeDetail(report.deployedCommit) || "absent"}`,
    `closing_commit=${sanitizeDetail(report.closingCommit) || "absent"}`,
    "schema_source=reviewed_manifest",
    `schema=${sanitizeDetail(report.schema)}`,
    ...report.results.map(
      (row) => `case ${row.id} ${row.status} ${sanitizeDetail(row.detail)}`,
    ),
    `acceptance_result=${tally.result}`,
    `passed=${tally.passed} failed=${tally.failed} gaps=${tally.gaps}`,
    "generic_client_is_not_chatgpt=true",
    "generic_client_is_not_second_mcp_client=true",
  ];
  return lines.join("\n");
}

export interface AuthConfigSnapshot {
  oauth_server_enabled?: unknown;
  oauth_server_allow_dynamic_registration?: unknown;
  oauth_server_authorization_path?: unknown;
  site_url?: unknown;
  uri_allow_list?: unknown;
  security_update_password_require_reauthentication?: unknown;
}

function sameUrl(left: string, right: string): boolean {
  return left.replace(/\/+$/, "") === right.replace(/\/+$/, "");
}

function allowList(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function classifyAuthSettings(
  config: AuthConfigSnapshot,
  siteOrigin: string,
): AcceptanceCase[] {
  const callback = `${siteOrigin}/auth/callback`;
  const recovery = `${siteOrigin}/auth/recovery`;
  const listed =
    typeof config.uri_allow_list === "string"
      ? allowList(config.uri_allow_list)
      : [];
  const missing = [
    listed.some((entry) => sameUrl(entry, callback)) ? "" : "auth_callback",
    listed.some((entry) => sameUrl(entry, recovery)) ? "" : "auth_recovery",
  ].filter(Boolean);
  const secure = config.security_update_password_require_reauthentication;
  return [
    acceptanceCase(
      "auth.oauth_server_enabled",
      config.oauth_server_enabled === true ? "pass" : "fail",
      config.oauth_server_enabled === true ? "enabled" : "disabled",
    ),
    acceptanceCase(
      "auth.dynamic_registration",
      config.oauth_server_allow_dynamic_registration === true ? "pass" : "fail",
      config.oauth_server_allow_dynamic_registration === true
        ? "enabled"
        : "disabled",
    ),
    acceptanceCase(
      "auth.authorization_path",
      config.oauth_server_authorization_path === EXPECTED_AUTHORIZATION_PATH
        ? "pass"
        : "fail",
      config.oauth_server_authorization_path === EXPECTED_AUTHORIZATION_PATH
        ? "path=/oauth/consent"
        : "path=mismatch",
    ),
    acceptanceCase(
      "auth.site_url",
      typeof config.site_url === "string" &&
        sameUrl(config.site_url, siteOrigin)
        ? "pass"
        : "fail",
      typeof config.site_url === "string" &&
        sameUrl(config.site_url, siteOrigin)
        ? "match"
        : "mismatch",
    ),
    acceptanceCase(
      "auth.redirect_allow_list",
      missing.length === 0 ? "pass" : "fail",
      missing.length === 0 ? "match" : `missing=${missing.join(",")}`,
    ),
    acceptanceCase(
      "auth.secure_password_change",
      typeof secure === "boolean" ? "pass" : "fail",
      typeof secure === "boolean"
        ? `security_update_password_require_reauthentication=${secure}`
        : "security_update_password_require_reauthentication=absent",
    ),
  ];
}

export function classifyExposedSchemas(dbSchema: string): AcceptanceCase {
  const names = dbSchema
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  const exposed = names.join(",") || "absent";
  const pass = names.length === 1 && names[0] === "public";
  return acceptanceCase(
    "auth.exposed_schemas",
    pass ? "pass" : "fail",
    `db_schema=${exposed}`,
  );
}

export function jwtAudience(token: string): unknown {
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const parsed = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as { aud?: unknown };
    return parsed.aud;
  } catch {
    return undefined;
  }
}

function audienceLabel(value: string, resource: string): string {
  if (value === "authenticated") return "authenticated";
  if (value === resource) return "resource";
  return "other";
}

export function classifyIssuedAudience(
  aud: unknown,
  resource: string,
): AcceptanceCase {
  const values = Array.isArray(aud) ? aud : [aud];
  if (
    values.length === 0 ||
    values.some((value) => typeof value !== "string" || value.length === 0)
  ) {
    return acceptanceCase(
      "generic_client.audience",
      "fail",
      "issued_audience=unreadable",
    );
  }
  const labels = values.map((value) =>
    audienceLabel(value as string, resource),
  );
  const accepted = labels.every(
    (label) => label === "authenticated" || label === "resource",
  );
  const resourceAudience = labels.includes("resource") ? "present" : "absent";
  return acceptanceCase(
    "generic_client.audience",
    accepted ? "pass" : "fail",
    `issued_audience=${labels.join(",")} resource_audience=${resourceAudience}`,
  );
}

/**
 * Publishable-key reads of the Data API root are not proof that `app` is
 * exposed. The gateway withholds that document from publishable keys.
 * Management `db_schema` and the direct probes remain the schema authority.
 * A body that still names `app` fails.
 */
export function classifyOpenApiDocument(
  status: number,
  body: unknown,
): AcceptanceCase {
  if (openApiExposesApp(body)) {
    return acceptanceCase("data_api.openapi", "fail", "app_exposed");
  }
  if (status === 200) {
    return acceptanceCase("data_api.openapi", "pass", "app_absent");
  }
  if (status === 401 || status === 403) {
    return acceptanceCase(
      "data_api.openapi",
      "pass",
      `http_${status} withheld`,
    );
  }
  return acceptanceCase("data_api.openapi", "fail", `http_${status}`);
}

export function openApiExposesApp(document: unknown): boolean {
  const text = JSON.stringify(document ?? {});
  if (text.includes("app.businesses") || text.includes('"schema":"app"')) {
    return true;
  }
  const paths = (document as { paths?: Record<string, unknown> } | null)?.paths;
  if (!paths || typeof paths !== "object") return false;
  return Object.keys(paths).some((path) =>
    APP_PATH_MARKERS.some((marker) => path.includes(marker)),
  );
}

const DATA_API_REFUSALS: Record<number, readonly string[]> = {
  401: ["PGRST301", "PGRST302", "PGRST303", "42501"],
  403: ["42501"],
  404: ["PGRST205"],
  406: ["PGRST106"],
};

/**
 * A Data API isolation denial is only an expected authorization or schema
 * refusal. 500, 503, and 504, including PGRST000–PGRST003, are outages.
 */
export function dataApiDenied(status: number, body: unknown): boolean {
  const allowed = DATA_API_REFUSALS[status];
  if (!allowed) return false;
  const code = (body as { code?: unknown } | null)?.code;
  return typeof code === "string" && allowed.includes(code);
}

export interface DirectProbe {
  runtimeReadDenied: boolean;
  ownVisible: boolean;
  otherVisible: boolean;
  deleted: boolean;
  aborted: boolean;
  abortReason: "visibility" | "count" | null;
}

export interface DirectProbeInput {
  userId: string;
  ownBusinessId: string;
  otherBusinessId: string;
  clientIds?: readonly string[];
}

class CleanupCountError extends Error {
  constructor() {
    super("cleanup_count");
    this.name = "cleanup_count";
  }
}

function permissionDenied(error: unknown): boolean {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : "";
  if (code === "42501") return true;
  const message = error instanceof Error ? error.message : "";
  return /permission denied/i.test(message);
}

async function asRequest<T>(
  db: SqlConnection,
  userId: string,
  fn: (tx: Sql) => Promise<T>,
): Promise<T> {
  const claims = JSON.stringify({
    sub: userId,
    role: "authenticated",
    aud: "authenticated",
  });
  return db.transaction(async (tx) => {
    await tx.query("select set_config('request.jwt.claims', $1, true)", [
      claims,
    ]);
    await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [
      userId,
    ]);
    await tx.exec("set local role app_request");
    return fn(tx);
  });
}

async function visibleIds(tx: Sql): Promise<string[]> {
  const result = await tx.query<{ id: string }>(
    "select id::text as id from app.businesses",
  );
  return result.rows.map((row) => row.id);
}

/**
 * Direct database bypass for one synthetic owner. The connection must already
 * be the app_runtime login. Mutations name that owner's business, user, and
 * client ids. Unexpected visibility returns before any write. Creation keys
 * for that owner and business must come back as one to four rows. Any other
 * count throws, and the transaction rolls back. The function never prints
 * SQL errors.
 */
export async function probeDirectTenantAccess(
  db: SqlConnection,
  input: DirectProbeInput,
): Promise<DirectProbe> {
  const clientIds = [...(input.clientIds ?? [])];
  let runtimeReadDenied = false;
  try {
    await db.query("select id::text as id from app.businesses");
  } catch (error) {
    runtimeReadDenied = permissionDenied(error);
  }
  const visible = await asRequest(db, input.userId, visibleIds);
  const ownVisible =
    visible.includes(input.ownBusinessId) &&
    !visible.includes(input.otherBusinessId);
  const otherVisible = visible.includes(input.otherBusinessId);
  const exact = visible.length === 1 && visible[0] === input.ownBusinessId;
  if (!exact || clientIds.length > 3) {
    return {
      runtimeReadDenied,
      ownVisible,
      otherVisible,
      deleted: false,
      aborted: true,
      abortReason: "visibility",
    };
  }
  let removed = false;
  try {
    await asRequest(db, input.userId, async (tx) => {
      await deleteOwnedRows(tx, input, clientIds);
    });
    removed = true;
  } catch {
    removed = false;
  }
  const remaining = await asRequest(db, input.userId, visibleIds);
  const deleted =
    removed &&
    !remaining.includes(input.ownBusinessId) &&
    !remaining.includes(input.otherBusinessId);
  return {
    runtimeReadDenied,
    ownVisible,
    otherVisible,
    deleted,
    aborted: !deleted,
    abortReason: deleted ? null : "count",
  };
}

interface TenantView {
  input: DirectProbeInput;
  clientIds: string[];
  ownVisible: boolean;
  otherVisible: boolean;
  exact: boolean;
}

/**
 * Reads every tenant's visible businesses before any cleanup. A tenant who
 * can see anything except exactly their own business aborts the whole set,
 * so one delete cannot hide the other tenant's row from the next check.
 */
export async function probeDirectTenants(
  db: SqlConnection,
  inputs: readonly DirectProbeInput[],
): Promise<DirectProbe[]> {
  let runtimeReadDenied = false;
  try {
    await db.query("select id::text as id from app.businesses");
  } catch (error) {
    runtimeReadDenied = permissionDenied(error);
  }
  const views: TenantView[] = [];
  for (const input of inputs) {
    const clientIds = [...(input.clientIds ?? [])];
    const visible = await asRequest(db, input.userId, visibleIds);
    views.push({
      input,
      clientIds,
      ownVisible:
        visible.includes(input.ownBusinessId) &&
        !visible.includes(input.otherBusinessId),
      otherVisible: visible.includes(input.otherBusinessId),
      exact: visible.length === 1 && visible[0] === input.ownBusinessId,
    });
  }
  if (views.some((view) => !view.exact || view.clientIds.length > 3)) {
    return views.map((view) => ({
      runtimeReadDenied,
      ownVisible: view.ownVisible,
      otherVisible: view.otherVisible,
      deleted: false,
      aborted: true,
      abortReason: "visibility",
    }));
  }
  const probes: DirectProbe[] = [];
  let stopped = false;
  for (const view of views) {
    if (stopped) {
      probes.push({
        runtimeReadDenied,
        ownVisible: view.ownVisible,
        otherVisible: view.otherVisible,
        deleted: false,
        aborted: true,
        abortReason: "count",
      });
      continue;
    }
    let removed = false;
    try {
      await asRequest(db, view.input.userId, async (tx) => {
        await deleteOwnedRows(tx, view.input, view.clientIds);
      });
      removed = true;
    } catch {
      removed = false;
    }
    const remaining = await asRequest(db, view.input.userId, visibleIds);
    const deleted =
      removed &&
      !remaining.includes(view.input.ownBusinessId) &&
      !remaining.includes(view.input.otherBusinessId);
    if (!deleted) stopped = true;
    probes.push({
      runtimeReadDenied,
      ownVisible: view.ownVisible,
      otherVisible: view.otherVisible,
      deleted,
      aborted: !deleted,
      abortReason: deleted ? null : "count",
    });
  }
  return probes;
}

/**
 * The business job writes the create key, the forged-id retry key, and the
 * MCP key for one owner and business. One extra key on that same business
 * is still this run. A wider set is not this cleanup.
 */
const MIN_OWNED_CREATION_KEYS = 1;
const MAX_OWNED_CREATION_KEYS = 4;

async function deleteOwnedRows(
  tx: Sql,
  input: DirectProbeInput,
  clientIds: readonly string[],
): Promise<void> {
  const keys = await tx.query<{ business_id: string }>(
    `delete from app.business_creation_keys
     where business_id = $1::uuid and owner_user_id = $2::uuid
     returning business_id::text`,
    [input.ownBusinessId, input.userId],
  );
  if (
    keys.rows.length < MIN_OWNED_CREATION_KEYS ||
    keys.rows.length > MAX_OWNED_CREATION_KEYS ||
    keys.rows.some((row) => row.business_id !== input.ownBusinessId)
  ) {
    throw new CleanupCountError();
  }
  if (clientIds.length > 0) {
    const consents = await tx.query<{ oauth_client_id: string }>(
      `delete from app.oauth_consents
       where owner_user_id = $1::uuid
         and oauth_client_id = any($2::text[])
       returning oauth_client_id`,
      [input.userId, clientIds],
    );
    if (
      consents.rows.length > clientIds.length * 8 ||
      consents.rows.some((row) => !clientIds.includes(row.oauth_client_id))
    ) {
      throw new CleanupCountError();
    }
    const grants = await tx.query<{ oauth_client_id: string }>(
      `update app.client_grants
       set business_id = null
       where owner_user_id = $1::uuid
         and business_id = $2::uuid
         and oauth_client_id = any($3::text[])
       returning oauth_client_id`,
      [input.userId, input.ownBusinessId, clientIds],
    );
    if (
      grants.rows.length > clientIds.length ||
      grants.rows.some((row) => !clientIds.includes(row.oauth_client_id))
    ) {
      throw new CleanupCountError();
    }
  }
  const businesses = await tx.query<{ id: string }>(
    `delete from app.businesses
     where id = $1::uuid and owner_user_id = $2::uuid
     returning id::text`,
    [input.ownBusinessId, input.userId],
  );
  if (
    businesses.rows.length !== 1 ||
    businesses.rows[0]?.id !== input.ownBusinessId
  ) {
    throw new CleanupCountError();
  }
}

export function classifyDirectProbe(probe: DirectProbe): AcceptanceCase[] {
  return classifyDirectProbes([probe]);
}

/**
 * Both synthetic tenants. Cleanup passes only when each probe removed
 * only its own business. An abort leaves app rows in place: Auth user
 * deletion has no foreign key into app, and this path does not send
 * unqualified SQL.
 */
export function classifyDirectProbes(
  probes: readonly DirectProbe[],
): AcceptanceCase[] {
  const runtime =
    probes.length > 0 && probes.every((probe) => probe.runtimeReadDenied);
  const otherVisible = probes.some((probe) => probe.otherVisible);
  const ownOnly =
    probes.length > 0 &&
    probes.every((probe) => probe.ownVisible && !probe.otherVisible);
  const deleted = probes.length > 0 && probes.every((probe) => probe.deleted);
  const countAbort = probes.some((probe) => probe.abortReason === "count");
  const visibilityAbort = probes.some(
    (probe) => probe.abortReason === "visibility",
  );
  const cases = [
    acceptanceCase(
      "direct.runtime_cannot_read",
      runtime ? "pass" : "fail",
      runtime ? "permission_denied" : "rows_visible",
    ),
    acceptanceCase(
      "direct.tenant_isolation",
      ownOnly && !otherVisible ? "pass" : "fail",
      otherVisible
        ? "other_tenant_visible"
        : ownOnly
          ? "own_tenant_only"
          : "own_tenant_absent",
    ),
    acceptanceCase(
      "direct.cleanup",
      deleted ? "pass" : "fail",
      deleted
        ? "own_rows_removed"
        : countAbort
          ? "aborted_row_count"
          : visibilityAbort
            ? "aborted_unexpected_visibility"
            : "own_rows_remain",
    ),
  ];
  if (probes.some((probe) => probe.aborted || !probe.deleted)) {
    cases.push(
      acceptanceCase(
        "direct.orphan_rows",
        "gap",
        "Auth user deletion does not cascade into app.businesses, app.business_creation_keys, or app.oauth_consents. Scoped cleanup aborted, so those rows may remain for one or both synthetic owners. This workflow will not send unqualified SQL or an elevated business request. A reviewed follow-up deletes the remaining rows by primary key as a role this business job does not have.",
      ),
    );
  }
  return cases;
}

export function blockedCases(
  ids: readonly string[],
  reason: string,
): AcceptanceCase[] {
  return ids.map((id) => acceptanceCase(id, "fail", `blocked:${reason}`));
}
