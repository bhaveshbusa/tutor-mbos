import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  acceptanceGuard,
  resolveAcceptanceMaterial,
  runHostedAcceptance,
} from "../scripts/hosted-acceptance.ts";
import { DEVELOPMENT_HEALTH_STEP_NAME } from "../scripts/probe-development-health.ts";
import {
  APP_DATABASE_URL_SECRET,
  MANAGEMENT_TOKEN_SECRET,
  PUBLISHABLE_KEY_NAME,
  acceptanceCase,
  acceptanceTally,
  classifyAuthSettings,
  classifyExposedSchemas,
  classifyIssuedAudience,
  dataApiDenied,
  formatAcceptanceReport,
  probeDirectTenantAccess,
  probeDirectTenants,
  sanitizeDetail,
} from "@/server/application/hosted-acceptance";
import { siteOriginFor } from "@/server/config/access";
import {
  ENVIRONMENT_BINDINGS,
  supabaseUrlFor,
} from "@/server/config/environments";
import { migratedDatabase } from "./helpers/database";

const site = siteOriginFor("development");
const supabaseUrl = supabaseUrlFor(
  ENVIRONMENT_BINDINGS.development.supabaseProjectRef,
);
const commit = "a".repeat(40);
const publishableKey = "sb_publishable_ci";
const managementToken = "mgmt-token";
const jwtSecret = "do-not-print-jwt-secret";

function token(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "ES256" })).toString(
    "base64url",
  );
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}

function payloadOf(value: string): Record<string, unknown> {
  const part = value.split(".")[1] ?? "";
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;
}

interface DoubleOptions {
  leak?: boolean;
  autoconfirm?: boolean;
  oauth?: boolean;
  rotateCookie?: boolean;
  healthStatus?: number;
  healthCommit?: string;
  closingCommit?: string;
  denyLocation?: string;
  dataApi?: { status: number; code: string };
}

function developmentDouble(options: DoubleOptions = {}) {
  const urls: string[] = [];
  const calls: {
    origin: string;
    bypass: string;
    redirect: RequestRedirect | undefined;
  }[] = [];
  const users = new Map<
    string,
    { id: string; access: string; refresh: string }
  >();
  const businesses = new Map<string, string>();
  const authorizations = new Map<string, { clientId: string; state: string }>();
  const codes = new Map<string, { userId: string; clientId: string }>();
  const revoked = new Set<string>();
  const clientPerms = new Map<string, string[]>();
  let userCount = 0;
  let clientCount = 0;
  let authCount = 0;
  let healthReads = 0;
  const clientIds = [
    "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee5",
    "ffffffff-ffff-4fff-8fff-fffffffffff6",
    "99999999-9999-4999-8999-999999999997",
  ];

  const userIdFor = (email: string) => {
    const existing = users.get(email);
    if (existing) return existing;
    userCount += 1;
    const id =
      userCount === 1
        ? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1"
        : "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
    const created = {
      id,
      access: token({ sub: id, aud: "authenticated", role: "authenticated" }),
      refresh: `refresh-${userCount}`,
    };
    users.set(email, created);
    return created;
  };

  const businessFor = (userId: string) => {
    const existing = businesses.get(userId);
    if (existing) return existing;
    const id = userId.startsWith("aaaa")
      ? "cccccccc-cccc-4ccc-8ccc-ccccccccccc3"
      : "dddddddd-dddd-4ddd-8ddd-ddddddddddd4";
    businesses.set(userId, id);
    return id;
  };

  const emailFromCookie = (cookie: string | null) => {
    const match = /sb-user=([^;]+)/.exec(cookie ?? "");
    return match?.[1] ? decodeURIComponent(match[1]) : "";
  };

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    urls.push(`${init?.method ?? "GET"} ${url.pathname}`);
    calls.push({
      origin: url.origin,
      bypass:
        new Headers(init?.headers).get("x-vercel-protection-bypass") ?? "",
      redirect: init?.redirect,
    });
    const header = (name: string) => new Headers(init?.headers).get(name) ?? "";
    const bodyText = typeof init?.body === "string" ? init.body : "";
    const form = () => new URLSearchParams(bodyText);
    const jsonBody = () =>
      bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : {};
    const json = (status: number, body: unknown, extra?: Headers) =>
      new Response(JSON.stringify(body), {
        status,
        headers: extra ?? { "content-type": "application/json" },
      });
    const redirect = (status: number, location: string, cookie?: string) => {
      const headers = new Headers({ location });
      if (cookie) headers.append("set-cookie", cookie);
      return new Response(null, { status, headers });
    };

    if (url.pathname === "/api/v1/health") {
      healthReads += 1;
      if (
        healthReads === 1 &&
        options.healthStatus &&
        options.healthStatus !== 200
      ) {
        return json(options.healthStatus, { status: "down" });
      }
      const bodyCommit =
        healthReads === 1
          ? (options.healthCommit ?? commit)
          : (options.closingCommit ?? options.healthCommit ?? commit);
      return json(200, {
        status: "ok",
        environment: "development",
        supabaseProjectRef: ENVIRONMENT_BINDINGS.development.supabaseProjectRef,
        commit: bodyCommit,
      });
    }
    if (url.pathname === "/login") {
      return new Response(
        "<main><h1>Sign in</h1><h2>Account recovery</h2></main>",
        { status: 200, headers: { "content-type": "text/html" } },
      );
    }
    if (url.pathname === "/business") {
      const email = emailFromCookie(header("cookie"));
      const own = email.includes("tenant-a") ? "Synthetic A" : "Synthetic B";
      const other = own === "Synthetic A" ? "Synthetic B" : "Synthetic A";
      const shown = options.leak ? other : own;
      return new Response(`<main><h1>${shown}</h1></main>`, {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }
    if (url.pathname === "/oauth/consent") {
      return new Response("<main><h1>Authorize a client</h1></main>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }
    if (url.pathname === "/.well-known/oauth-protected-resource") {
      return json(200, {
        resource: `${site}/api/mcp`,
        authorization_servers: [`${supabaseUrl}/auth/v1`],
      });
    }
    if (url.pathname === "/api/auth/login") {
      if (header("origin") !== site) return json(403, { title: "Forbidden" });
      const email = form().get("email") ?? "";
      return redirect(
        303,
        `${site}/business`,
        `sb-user=${encodeURIComponent(email)}; Path=/; HttpOnly`,
      );
    }
    if (url.pathname === "/api/auth/recover") {
      return redirect(303, `${site}/login?recovery=sent`);
    }
    if (url.pathname === "/auth/v1/settings") {
      return json(200, {
        mailer_autoconfirm: options.autoconfirm !== false,
        disable_signup: false,
      });
    }
    if (url.pathname === "/auth/v1/.well-known/oauth-authorization-server") {
      if (options.oauth === false) return json(404, { error: "disabled" });
      return json(200, {
        authorization_endpoint: `${supabaseUrl}/auth/v1/oauth/authorize`,
        token_endpoint: `${supabaseUrl}/auth/v1/oauth/token`,
        registration_endpoint: `${supabaseUrl}/auth/v1/oauth/register`,
      });
    }
    if (url.pathname === "/rest/v1/" || url.pathname === "/rest/v1") {
      return json(200, { paths: { "/": {} } });
    }
    if (url.pathname === "/rest/v1/businesses") {
      if (options.dataApi) {
        return json(options.dataApi.status, { code: options.dataApi.code });
      }
      return json(404, { code: "PGRST205" });
    }
    if (url.pathname === "/auth/v1/signup") {
      const email = String(jsonBody().email ?? "");
      const user = userIdFor(email);
      if (options.autoconfirm === false)
        return json(200, { user: { id: user.id } });
      return json(200, {
        access_token: user.access,
        refresh_token: user.refresh,
        user: { id: user.id },
      });
    }
    if (url.pathname === "/auth/v1/token") {
      const user = [...users.values()][0];
      return json(200, {
        access_token: user?.access,
        refresh_token: "refresh-rotated",
      });
    }
    if (url.pathname === "/api/v1/session") {
      const headers = new Headers({ "content-type": "application/json" });
      if (options.rotateCookie) {
        headers.append("set-cookie", "sb-user=rotated; Path=/; HttpOnly");
      }
      return new Response(JSON.stringify({ path: "ui-session" }), {
        status: 200,
        headers,
      });
    }
    if (url.pathname === "/api/v1/business") {
      const bearer = header("authorization").replace(/^Bearer\s+/i, "");
      if (bearer.split(".").length === 3) {
        const claims = payloadOf(bearer);
        if (typeof claims.client_id !== "string") {
          return json(401, { title: "Unauthorized" });
        }
        const key = `${String(claims.sub)}:${claims.client_id}`;
        if (revoked.has(key)) return json(403, { title: "Forbidden" });
        const perms = clientPerms.get(claims.client_id) ?? [];
        if (!perms.includes("business.read")) {
          return json(403, { title: "Forbidden" });
        }
        const own = businessFor(String(claims.sub));
        const other = [...businesses.values()].find((id) => id !== own) ?? own;
        const id = options.leak ? other : own;
        return json(200, { business: { id, displayName: "Synthetic" } });
      }
      const email = emailFromCookie(header("cookie"));
      const user = users.get(email);
      if (!user) return json(401, { title: "Unauthorized" });
      const own = businessFor(user.id);
      const other = [...businesses.values()].find((id) => id !== own);
      const id = options.leak && other ? other : own;
      return json(init?.method === "POST" ? 201 : 200, {
        business: { id, displayName: "Synthetic" },
      });
    }
    if (url.pathname === "/auth/v1/oauth/register") {
      clientCount += 1;
      const clientId = clientIds[clientCount - 1] ?? clientIds[0]!;
      return json(201, { client_id: clientId });
    }
    if (url.pathname === "/auth/v1/oauth/authorize") {
      authCount += 1;
      const id = `auth-${authCount}`;
      authorizations.set(id, {
        clientId: url.searchParams.get("client_id") ?? "",
        state: url.searchParams.get("state") ?? "",
      });
      return redirect(302, `${site}/oauth/consent?authorization_id=${id}`);
    }
    if (url.pathname === "/api/oauth/decision") {
      const decision = form().get("decision");
      const authorizationId = form().get("authorization_id") ?? "";
      const pending = authorizations.get(authorizationId);
      if (!pending) return json(400, { title: "Bad request" });
      if (decision === "deny") {
        const location =
          options.denyLocation ??
          `https://example.com/oauth/callback?error=access_denied&state=${encodeURIComponent(pending.state)}`;
        return redirect(303, location);
      }
      clientPerms.set(pending.clientId, form().getAll("permissions"));
      const email = emailFromCookie(header("cookie"));
      const user = users.get(email);
      if (!user) return json(401, { title: "Unauthorized" });
      const code = `code-${authorizationId}`;
      codes.set(code, { userId: user.id, clientId: pending.clientId });
      revoked.delete(`${user.id}:${pending.clientId}`);
      return redirect(303, `https://example.com/oauth/callback?code=${code}`);
    }
    if (url.pathname === "/auth/v1/oauth/token") {
      const grant = form().get("grant_type");
      const code = form().get("code") ?? "";
      const issued = codes.get(code);
      const refreshUser = (form().get("refresh_token") ?? "").replace(
        /^oauth-refresh-/,
        "",
      );
      const userId =
        grant === "refresh_token" && refreshUser ? refreshUser : issued?.userId;
      const clientId = form().get("client_id") ?? issued?.clientId ?? "";
      if (!userId) return json(400, { error: "invalid_grant" });
      return json(200, {
        access_token: token({
          sub: userId,
          aud: "authenticated",
          role: "authenticated",
          client_id: clientId,
        }),
        refresh_token: `oauth-refresh-${userId}`,
      });
    }
    if (url.pathname === "/api/v1/reports/setup") {
      const bearer = header("authorization").replace(/^Bearer\s+/i, "");
      if (bearer.split(".").length !== 3) {
        return json(401, { title: "Unauthorized" });
      }
      const claims = payloadOf(bearer);
      if (typeof claims.client_id !== "string") {
        return json(401, { title: "Unauthorized" });
      }
      const perms = clientPerms.get(claims.client_id) ?? [];
      if (!perms.includes("reports.read")) return json(403, { code: "42501" });
      const own = businessFor(String(claims.sub));
      const other = [...businesses.values()].find((id) => id !== own) ?? own;
      return json(200, {
        dataset: "setup",
        businessId: options.leak ? other : own,
        ready: true,
      });
    }
    if (url.pathname === "/api/mcp") {
      const bearer = header("authorization").replace(/^Bearer\s+/i, "");
      const claims = payloadOf(bearer);
      const perms =
        typeof claims.client_id === "string"
          ? (clientPerms.get(claims.client_id) ?? [])
          : [];
      const own = businessFor(String(claims.sub));
      const other = [...businesses.values()].find((id) => id !== own) ?? own;
      const id = options.leak ? other : own;
      const tool = String(
        (jsonBody().params as { name?: string } | undefined)?.name ?? "",
      );
      if (tool === "setup_status") {
        const allowed = perms.includes("reports.read");
        return json(200, {
          jsonrpc: "2.0",
          id: 1,
          result: {
            isError: !allowed,
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  allowed
                    ? { dataset: "setup", businessId: id, ready: true }
                    : { code: "forbidden" },
                ),
              },
            ],
          },
        });
      }
      return json(200, {
        jsonrpc: "2.0",
        id: 1,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                business: { id, displayName: "Synthetic" },
              }),
            },
          ],
        },
      });
    }
    if (url.pathname === "/api/v1/grants/revoke") {
      const clientId = String(jsonBody().clientId ?? "");
      const email = emailFromCookie(header("cookie"));
      const user = users.get(email);
      if (user) revoked.add(`${user.id}:${clientId}`);
      return json(200, { revoked: true });
    }
    if (url.pathname === "/auth/v1/user" && init?.method === "DELETE") {
      return json(405, { error: "method_not_allowed" });
    }
    if (
      url.pathname.startsWith("/auth/v1/oauth/clients/") &&
      init?.method === "DELETE"
    ) {
      return json(405, { error: "method_not_allowed" });
    }
    if (
      url.pathname ===
      `/v1/projects/${ENVIRONMENT_BINDINGS.development.supabaseProjectRef}/config/auth`
    ) {
      return json(200, {
        oauth_server_enabled: true,
        oauth_server_allow_dynamic_registration: true,
        oauth_server_authorization_path: "/oauth/consent",
        site_url: site,
        uri_allow_list: `${site}/auth/callback,${site}/auth/recovery`,
        security_update_password_require_reauthentication: false,
        smtp_pass: jwtSecret,
      });
    }
    if (
      url.pathname ===
      `/v1/projects/${ENVIRONMENT_BINDINGS.development.supabaseProjectRef}/postgrest`
    ) {
      return json(200, { db_schema: "public", jwt_secret: jwtSecret });
    }
    return json(404, { missing: url.pathname });
  };

  return { fetchImpl, urls, calls };
}

const SYNTHETIC_BYPASS = "synthetic-bypass";
const password = "pw";
const appDatabaseUrl = `postgresql://app_runtime.${ENVIRONMENT_BINDINGS.development.supabaseProjectRef}:${password}@aws-0-eu-west-2.pooler.supabase.com:5432/postgres`;

function input(
  fetchImpl: typeof fetch,
  overrides: Partial<Parameters<typeof runHostedAcceptance>[0]> = {},
) {
  return {
    commit,
    publishableKey,
    managementToken,
    appDatabaseUrl,
    schema: "20261015120000:abc",
    fetchImpl,
    randomBytes: (size: number) => Buffer.alloc(size, 7),
    runId: "4242",
    runAttempt: "1",
    runNonce: "07".repeat(16),
    startedAt: "2026-10-15T20:00:00.000Z",
    bypass: SYNTHETIC_BYPASS,
    probeDatabase: async () => ({
      runtimeReadDenied: true,
      ownVisible: true,
      otherVisible: false,
      deleted: true,
      aborted: false,
      abortReason: null,
    }),
    ...overrides,
  };
}

describe("hosted acceptance harness", () => {
  it("records two synthetic tenants, generic-client audience, and real-client gaps", async () => {
    const doubled = developmentDouble();
    const report = await runHostedAcceptance(input(doubled.fetchImpl));
    const failed = report.results.filter((row) => row.status === "fail");
    expect(failed.map((row) => `${row.id} ${row.detail}`)).toEqual([]);
    const ids = report.results.map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(acceptanceTally(report.results).result).toBe("incomplete");
    expect(
      report.results.find((row) => row.id === "client.chatgpt")?.status,
    ).toBe("gap");
    expect(
      report.results.find((row) => row.id === "client.second_mcp")?.status,
    ).toBe("gap");
    expect(
      report.results.find((row) => row.id === "generic_client.audience")
        ?.detail,
    ).toBe("issued_audience=authenticated resource_audience=absent");
    expect(
      report.results.find((row) => row.id === "auth.secure_password_change")
        ?.detail,
    ).toBe("security_update_password_require_reauthentication=false");
    expect(
      report.results.find((row) => row.id === "cleanup.manifest")?.detail,
    ).toBe("deferred_admin_cleanup");
    expect(
      report.results.find(
        (row) => row.id === "generic_client.tenant_b_mcp_positive",
      )?.status,
    ).toBe("pass");
    expect(
      report.results.find(
        (row) => row.id === "generic_client.restricted_report",
      )?.status,
    ).toBe("pass");
    expect(
      report.results.find((row) => row.id === "ui.login_page")?.status,
    ).toBe("pass");
    expect(
      report.results.find((row) => row.id === "ui.tenant_b_page")?.status,
    ).toBe("pass");
    expect(
      report.results.find((row) => row.id === "ui.consent_page")?.status,
    ).toBe("pass");
    expect(
      report.results.find((row) => row.id === "recovery.request_accepted")
        ?.detail,
    ).toBe("request_initiated");
    expect(
      report.results.find((row) => row.id === "recovery.email_callback")
        ?.status,
    ).toBe("gap");
    expect(
      report.results.find((row) => row.id === "ui.browser_interaction")?.status,
    ).toBe("gap");
    expect(report.closingCommit).toBe(commit);
    expect(doubled.urls.some((url) => url === "DELETE /auth/v1/user")).toBe(
      false,
    );
    const text = formatAcceptanceReport(report);
    const siteCalls = doubled.calls.filter((call) => call.origin === site);
    const otherCalls = doubled.calls.filter((call) => call.origin !== site);
    expect(siteCalls.length).toBeGreaterThan(0);
    expect(otherCalls.length).toBeGreaterThan(0);
    expect(siteCalls.every((call) => call.bypass === SYNTHETIC_BYPASS)).toBe(
      true,
    );
    expect(otherCalls.every((call) => call.bypass === "")).toBe(true);
    expect(doubled.calls.every((call) => call.redirect === "manual")).toBe(
      true,
    );
    expect(text).not.toContain(SYNTHETIC_BYPASS);
    expect(JSON.stringify(report)).not.toContain(SYNTHETIC_BYPASS);
    expect(text).toContain("generic_client_is_not_chatgpt=true");
    expect(text).toContain("schema_source=reviewed_manifest");
    expect(text).not.toContain(jwtSecret);
    expect(text).not.toContain("@example.com");
    expect(text).not.toContain(publishableKey);
    expect(doubled.urls.some((url) => url.includes("/admin"))).toBe(false);
    expect(doubled.urls.some((url) => url.startsWith("PATCH"))).toBe(false);
  });

  it("fails a forged tenant read instead of treating it as isolation", async () => {
    const doubled = developmentDouble({ leak: true });
    const report = await runHostedAcceptance(input(doubled.fetchImpl));
    expect(
      report.results.find((row) => row.id === "ui.tenant_a_negative")?.status,
    ).toBe("fail");
    expect(acceptanceTally(report.results).result).toBe("fail");
  });

  it("fails closed when signup does not issue a session", async () => {
    const doubled = developmentDouble({ autoconfirm: false });
    const report = await runHostedAcceptance(input(doubled.fetchImpl));
    expect(
      report.results.find((row) => row.id === "signup.tenant_a")?.detail,
    ).toBe("blocked:mailer_autoconfirm_false");
    expect(
      report.results.find((row) => row.id === "ui.tenant_a_positive")?.detail,
    ).toContain("blocked:mailer_autoconfirm_false");
    expect(doubled.urls.some((url) => url.includes("/admin"))).toBe(false);
  });

  it("names a missing management token and does not call the Management API", async () => {
    const doubled = developmentDouble();
    const report = await runHostedAcceptance(
      input(doubled.fetchImpl, { managementToken: null }),
    );
    expect(
      report.results.find((row) => row.id === "auth.site_url")?.detail,
    ).toContain(`secret_absent:${MANAGEMENT_TOKEN_SECRET}`);
    expect(doubled.urls.some((url) => url.includes("/v1/projects/"))).toBe(
      false,
    );
  });

  it("refuses a privileged database URL before connecting", async () => {
    let called = false;
    const privileged = `postgresql://postgres:${password}@db.${ENVIRONMENT_BINDINGS.development.supabaseProjectRef}.supabase.co:5432/postgres`;
    const report = await runHostedAcceptance(
      input(developmentDouble().fetchImpl, {
        appDatabaseUrl: privileged,
        probeDatabase: async () => {
          called = true;
          return {
            runtimeReadDenied: true,
            ownVisible: true,
            otherVisible: false,
            deleted: true,
            aborted: false,
            abortReason: null,
          };
        },
      }),
    );
    expect(called).toBe(false);
    expect(
      report.results.find((row) => row.id === "direct.runtime_cannot_read")
        ?.detail,
    ).toContain("privileged_user");
  });

  it("keeps the protected workflow off pull requests and production", () => {
    const text = readFileSync(
      ".github/workflows/accept-development.yml",
      "utf8",
    );
    const workflow = parse(text) as { on: Record<string, unknown> };
    expect(Object.keys(workflow.on)).toEqual([
      "workflow_dispatch",
      "issue_comment",
    ]);
    expect(workflow.on.issue_comment).toEqual({ types: ["created"] });
    expect(text).not.toContain(ENVIRONMENT_BINDINGS.production.vercelProjectId);
    expect(text).not.toContain("pull_request:");
    expect(text).not.toContain("pull_request_target");
    expect(text).not.toContain("pull_request.head");
    expect(text).not.toContain("migrate:development");
    expect(text).not.toContain("deploy --prebuilt");
    expect(text).toContain(
      "SUPABASE_DEVELOPMENT_ACCESS_TOKEN is absent. Expected secret scope: GitHub environment development",
    );
    const businessSecrets = readFileSync(
      "scripts/assert-business-acceptance-secrets.mjs",
      "utf8",
    );
    expect(businessSecrets).toContain("TUTOR_MBOS_APP_DATABASE_URL");
    expect(businessSecrets).toContain(
      "Expected secret scope: GitHub environment development (Settings → Environments → development → Secrets). Purpose: development app_runtime connection for direct tenant reads and scoped business-row cleanup. Not the migration URL.",
    );
    expect(businessSecrets).toContain("VERCEL_AUTOMATION_BYPASS_SECRET");
    expect(businessSecrets).toContain("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
    expect(businessSecrets).toContain(
      "The business job sends it as x-vercel-protection-bypass and does not receive VERCEL_TOKEN.",
    );
    expect(businessSecrets).not.toContain("GITHUB_OUTPUT");
    expect(businessSecrets).not.toContain(".trim(");
    expect(businessSecrets).not.toContain("console.log(process.env");
    expect(text).toContain(
      "github.event_name == 'workflow_dispatch' && 'development-delivery'",
    );
    expect(text).toContain("github.actor_id == 3823973");
    expect(text).toContain("acceptance-ignore-");
    expect(text).toContain(
      "startsWith(github.event.comment.body, '/tutor-mbos accept-development ')",
    );
    expect(text).toContain(
      "startsWith(github.event.comment.body, '/tutor-mbos recover-development ')",
    );
    expect(text).toContain("queue: max");
    expect(text).not.toContain("development-acceptance");
    expect(text).toContain(
      "SUPABASE_DEVELOPMENT_AUTH_ADMIN_KEY is absent. Expected secret scope: GitHub environment development",
    );
    const parsed = parse(text) as {
      env?: Record<string, string>;
      permissions?: Record<string, string>;
      concurrency?: { group?: string };
      jobs: Record<
        string,
        {
          needs?: string | string[];
          if?: string;
          timeout?: number;
          "timeout-minutes"?: number;
          environment?: string;
          outputs?: Record<string, string>;
          permissions?: Record<string, string>;
          "continue-on-error"?: boolean;
          steps: {
            id?: string;
            name?: string;
            run?: string;
            if?: string;
            uses?: string;
            with?: Record<string, string>;
            env?: Record<string, string>;
            "timeout-minutes"?: number;
            "continue-on-error"?: boolean;
            "working-directory"?: string;
          }[];
          env?: Record<string, string>;
        }
      >;
    };
    expect(parsed.permissions).toEqual({ contents: "read" });
    expect(text).not.toContain("actions: write");
    expect(Object.keys(parsed.jobs)).toEqual([
      "authorize",
      "preflight",
      "accept",
      "cleanup",
    ]);
    expect(String(parsed.concurrency?.group)).toContain("development-delivery");
    expect(text).not.toContain("GITHUB_ENV");
    expect(text).not.toContain("cron:");
    expect(text).not.toContain("workflow_run");
    const authorize = parsed.jobs.authorize!;
    const preflight = parsed.jobs.preflight!;
    const accept = parsed.jobs.accept!;
    const cleanup = parsed.jobs.cleanup!;
    expect(authorize.environment).toBeUndefined();
    expect(authorize.if).toContain("github.event_name == 'issue_comment'");
    expect(authorize.if).toContain("github.actor_id == 3823973");
    expect(authorize.if).toContain("github.run_attempt == 1");
    expect(authorize.if).toContain(
      "startsWith(github.event.comment.body, '/tutor-mbos accept-development ')",
    );
    expect(authorize.if).toContain(
      "startsWith(github.event.comment.body, '/tutor-mbos recover-development ')",
    );
    expect(authorize.permissions).toEqual({
      contents: "read",
      "pull-requests": "read",
      actions: "read",
    });
    expect(JSON.stringify(authorize.permissions)).not.toContain("write");
    expect(JSON.stringify(authorize)).not.toContain("SUPABASE_");
    expect(JSON.stringify(authorize)).not.toContain("VERCEL_");
    const authorizeRun = authorize.steps.find((step) =>
      step.run?.includes("accept:development:authorize"),
    );
    expect(authorizeRun?.run).toBe("pnpm accept:development:authorize");
    expect(authorizeRun?.run).not.toContain("${{");
    expect(authorizeRun?.env?.ACCEPTANCE_COMMENT_BODY).toBe(
      "${{ github.event.comment.body }}",
    );
    expect(authorize.outputs?.candidate).toBe(
      "${{ steps.gate.outputs.candidate }}",
    );
    expect(preflight.needs).toBe("authorize");
    expect(preflight.if).toContain("github.event_name == 'workflow_dispatch'");
    expect(preflight.if).toContain("needs.authorize.result == 'success'");
    expect(preflight.if).toContain("!cancelled()");
    expect(preflight.if).toContain("github.run_attempt == 1");
    expect(preflight.if).not.toContain("always()");
    expect(preflight.environment).toBe("development");
    expect(accept.environment).toBe("development");
    expect(cleanup.environment).toBe("development");
    expect(accept.needs).toBe("preflight");
    expect(accept.if).toContain("!cancelled()");
    expect(accept.if).toContain("needs.preflight.result == 'success'");
    expect(accept.if).toContain("github.event_name == 'workflow_dispatch'");
    expect(accept.if).toContain("github.run_attempt == 1");
    expect(accept.if).not.toContain("always()");
    expect(accept.if).not.toContain("needs.authorize.outputs");
    expect(cleanup.needs).toEqual(["preflight", "accept"]);
    expect(cleanup.if).toContain("always()");
    expect(cleanup.if).toContain("needs.preflight.result == 'success'");
    expect(cleanup.if).not.toContain("run_attempt");
    expect(preflight["timeout-minutes"]).toBe(5);
    expect(accept["timeout-minutes"]).toBe(15);
    expect(cleanup["timeout-minutes"]).toBe(5);
    for (const job of [authorize, preflight, accept, cleanup]) {
      const checkout = job.steps.find((step) =>
        step.uses?.startsWith("actions/checkout@"),
      );
      expect(checkout?.with?.ref).toBe("${{ github.sha }}");
      expect(checkout?.with?.["persist-credentials"]).toBe(false);
      const setup = job.steps.find(
        (step) => step.uses === "./.github/actions/setup",
      );
      expect(setup?.with?.["pnpm-cache"]).toBe("false");
    }
    const candidate = preflight.steps.find((step) =>
      step.run?.includes("assert-acceptance-candidate.mjs"),
    );
    const preflightAttempt = preflight.steps.find((step) =>
      step.run?.includes("assert-acceptance-attempt.mjs"),
    );
    expect(preflightAttempt?.if).toBe("github.event_name == 'issue_comment'");
    expect(preflightAttempt?.env?.ACCEPTANCE_RUN_ATTEMPT).toBe(
      "${{ github.run_attempt }}",
    );
    expect(preflightAttempt?.env?.ACCEPTANCE_EVENT_NAME).toBe(
      "${{ github.event_name }}",
    );
    expect(candidate?.if).toBe("github.event_name == 'issue_comment'");
    expect(candidate?.run).toBe("node scripts/assert-acceptance-candidate.mjs");
    expect(candidate?.run).not.toContain("${{");
    expect(candidate?.env?.ACCEPTANCE_CANDIDATE).toBe(
      "${{ needs.authorize.outputs.candidate }}",
    );
    const candidateAt = preflight.steps.indexOf(candidate!);
    const preflightAttemptAt = preflight.steps.indexOf(preflightAttempt!);
    const preflightCheckoutAt = preflight.steps.findIndex((step) =>
      step.uses?.startsWith("actions/checkout@"),
    );
    const secretAt = preflight.steps.findIndex((step) =>
      step.run?.includes("accept:development:preflight"),
    );
    expect(preflightAttemptAt).toBeGreaterThan(preflightCheckoutAt);
    expect(candidateAt).toBeGreaterThan(preflightAttemptAt);
    expect(secretAt).toBeGreaterThan(candidateAt);
    const identityAt = preflight.steps.findIndex(
      (step) => step.run === "pnpm accept:development:preflight",
    );
    const pullAt = preflight.steps.findIndex((step) =>
      step.run?.includes("pnpm dlx"),
    );
    expect(identityAt).toBeGreaterThan(-1);
    expect(pullAt).toBeGreaterThan(identityAt);
    const presence = preflight.steps.find((step) =>
      step.run?.includes("assert-business-acceptance-secrets.mjs"),
    );
    expect(presence?.run).toBe(
      "node scripts/assert-business-acceptance-secrets.mjs",
    );
    expect(presence?.run).not.toContain("${{");
    expect(presence?.id).toBeUndefined();
    expect(presence?.["continue-on-error"] ?? false).toBe(false);
    expect(presence?.env).toEqual({
      VERCEL_AUTOMATION_BYPASS_SECRET:
        "${{ secrets.VERCEL_AUTOMATION_BYPASS_SECRET }}",
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:
        "${{ secrets.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY }}",
      TUTOR_MBOS_APP_DATABASE_URL: "${{ secrets.TUTOR_MBOS_APP_DATABASE_URL }}",
    });
    expect(preflight.steps.indexOf(presence!)).toBeLessThan(identityAt);
    const health = preflight.steps.find(
      (step) => step.name === DEVELOPMENT_HEALTH_STEP_NAME,
    );
    expect(health?.run).toBe("pnpm accept:development:health");
    expect(health?.run).not.toContain("${{");
    expect(health?.id).toBeUndefined();
    expect(health?.if).toBeUndefined();
    expect(health?.["continue-on-error"]).toBeUndefined();
    expect(preflight["continue-on-error"]).toBeUndefined();
    const healthAt = preflight.steps.indexOf(health!);
    for (const step of preflight.steps.slice(healthAt + 1)) {
      expect(step.if).toBeUndefined();
      expect(step["continue-on-error"]).toBeUndefined();
    }
    expect(health?.env).toEqual({
      VERCEL_AUTOMATION_BYPASS_SECRET:
        "${{ secrets.VERCEL_AUTOMATION_BYPASS_SECRET }}",
    });
    expect(healthAt).toBeGreaterThan(preflight.steps.indexOf(presence!));
    expect(identityAt).toBeGreaterThan(healthAt);
    expect(
      accept.steps.some((step) =>
        step.run?.includes("accept:development:health"),
      ),
    ).toBe(false);
    expect(
      cleanup.steps.some((step) =>
        step.run?.includes("accept:development:health"),
      ),
    ).toBe(false);
    const probeSource = readFileSync(
      "scripts/probe-development-health.ts",
      "utf8",
    );
    expect(probeSource).not.toContain("VERCEL_TOKEN");
    expect(probeSource).not.toContain("api.vercel.com");
    expect(probeSource).not.toContain("TUTOR_MBOS_APP_DATABASE_URL");
    expect(probeSource).not.toContain("GITHUB_OUTPUT");
    expect(probeSource).not.toContain("NEXT_PUBLIC_SUPABASE");
    expect(probeSource).toContain('redirect: "manual"');
    const inheritedNames = [
      "VERCEL_AUTOMATION_BYPASS_SECRET",
      "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
      "TUTOR_MBOS_APP_DATABASE_URL",
      "VERCEL_TOKEN",
    ];
    for (const name of inheritedNames) {
      expect(parsed.env ?? {}).not.toHaveProperty(name);
      expect(preflight.env ?? {}).not.toHaveProperty(name);
      expect(accept.env ?? {}).not.toHaveProperty(name);
    }
    expect(preflight.env).toEqual({
      DEPLOY_ENVIRONMENT: "development",
      TUTOR_MBOS_ACCEPTANCE: "development",
      VERCEL_ORG_ID: "team_2QehRm248FPmHJTzKS0rvS6b",
      VERCEL_PROJECT_ID: "prj_ysIJHdIKYk2MQwvOKermUvIMuGVa",
      VERCEL_CLI_VERSION: "63.1.2",
      VERCEL_TELEMETRY_DISABLED: "1",
    });
    expect(accept.env).toEqual({
      TUTOR_MBOS_ACCEPTANCE: "development",
      ACCEPTANCE_RUN_NONCE: "${{ needs.preflight.outputs.nonce }}",
      ACCEPTANCE_STARTED_AT: "${{ needs.preflight.outputs.started_at }}",
      ACCEPTANCE_PREFLIGHT_CASES: "${{ needs.preflight.outputs.cases }}",
    });
    const businessSecretNames = [
      "VERCEL_AUTOMATION_BYPASS_SECRET",
      "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
      "TUTOR_MBOS_APP_DATABASE_URL",
    ];
    for (const step of preflight.steps) {
      if (step === presence || step === health) continue;
      for (const name of businessSecretNames) {
        expect(step.env ?? {}).not.toHaveProperty(name);
      }
    }
    expect(health?.env ?? {}).not.toHaveProperty(
      "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    );
    expect(health?.env ?? {}).not.toHaveProperty("TUTOR_MBOS_APP_DATABASE_URL");
    expect(health?.env ?? {}).not.toHaveProperty("VERCEL_TOKEN");
    expect(preflight.steps[identityAt]?.env).toEqual({
      SUPABASE_DEVELOPMENT_AUTH_ADMIN_KEY:
        "${{ secrets.SUPABASE_DEVELOPMENT_AUTH_ADMIN_KEY }}",
      SUPABASE_DEVELOPMENT_ACCESS_TOKEN:
        "${{ secrets.SUPABASE_DEVELOPMENT_ACCESS_TOKEN }}",
    });
    const pull = preflight.steps[pullAt]!;
    expect(pull.env).toEqual({
      VERCEL_TOKEN: "${{ secrets.VERCEL_TOKEN }}",
    });
    expect(JSON.stringify(preflight.outputs)).not.toContain(
      "VERCEL_AUTOMATION_BYPASS_SECRET",
    );
    expect(JSON.stringify(preflight.outputs)).not.toContain(
      "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    );
    expect(JSON.stringify(preflight.outputs)).not.toContain(
      "TUTOR_MBOS_APP_DATABASE_URL",
    );
    expect(Object.keys(preflight.outputs ?? {}).sort()).toEqual([
      "cases",
      "nonce",
      "started_at",
    ]);
    expect(preflight.steps[identityAt]?.id).toBe("identity");
    expect(preflight.outputs?.nonce).toBe(
      "${{ steps.identity.outputs.nonce }}",
    );
    expect(preflight.outputs?.started_at).toBe(
      "${{ steps.identity.outputs.started_at }}",
    );
    const preflightScript = readFileSync(
      "scripts/hosted-acceptance-preflight.ts",
      "utf8",
    );
    expect(preflightScript).toContain("mask(adminKey)");
    expect(preflightScript).toContain("mask(managementToken)");
    expect(preflightScript.match(/mask\(/g)).toHaveLength(3);
    expect(preflightScript).toContain('writeOutput("nonce", result.nonce)');
    expect(preflightScript).not.toContain("mask(result.nonce)");
    expect(accept.steps.some((step) => step.run?.includes("vercel"))).toBe(
      false,
    );
    expect(cleanup.steps.some((step) => step.run?.includes("vercel"))).toBe(
      false,
    );
    const acceptRun = accept.steps.find(
      (step) => step.run === "pnpm accept:development",
    );
    const acceptAttempt = accept.steps.find((step) =>
      step.run?.includes("assert-acceptance-attempt.mjs"),
    );
    expect(acceptAttempt?.if).toBe("github.event_name == 'issue_comment'");
    expect(acceptAttempt?.env?.ACCEPTANCE_RUN_ATTEMPT).toBe(
      "${{ github.run_attempt }}",
    );
    expect(accept.steps.indexOf(acceptAttempt!)).toBeLessThan(
      accept.steps.indexOf(acceptRun!),
    );
    expect(
      cleanup.steps.some((step) =>
        step.run?.includes("assert-acceptance-attempt.mjs"),
      ),
    ).toBe(false);
    expect(acceptRun?.["timeout-minutes"]).toBe(12);
    expect(acceptRun?.env).toEqual({
      VERCEL_AUTOMATION_BYPASS_SECRET:
        "${{ secrets.VERCEL_AUTOMATION_BYPASS_SECRET }}",
      TUTOR_MBOS_APP_DATABASE_URL: "${{ secrets.TUTOR_MBOS_APP_DATABASE_URL }}",
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:
        "${{ secrets.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY }}",
    });
    for (const step of accept.steps) {
      if (step === acceptRun) continue;
      for (const name of [
        "VERCEL_AUTOMATION_BYPASS_SECRET",
        "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
        "TUTOR_MBOS_APP_DATABASE_URL",
        "VERCEL_TOKEN",
      ]) {
        expect(step.env ?? {}).not.toHaveProperty(name);
      }
    }
    expect(accept.env?.ACCEPTANCE_RUN_NONCE).toBe(
      "${{ needs.preflight.outputs.nonce }}",
    );
    expect(JSON.stringify(accept)).not.toContain(
      "SUPABASE_DEVELOPMENT_AUTH_ADMIN_KEY",
    );
    expect(JSON.stringify(accept)).not.toContain(
      "SUPABASE_DEVELOPMENT_ACCESS_TOKEN",
    );
    expect(JSON.stringify(accept)).not.toContain("VERCEL_TOKEN");
    expect(accept.outputs?.manifest).toBe(
      "${{ steps.acceptance.outputs.manifest }}",
    );
    expect(acceptRun?.id).toBe("acceptance");
    expect(text).not.toContain("actions/upload-artifact");
    expect(text).not.toContain("actions/download-artifact");
    expect(text).not.toContain("runner.temp");
    const cleanupRun = cleanup.steps.find((step) =>
      step.run?.includes("accept:development:cleanup"),
    );
    expect(cleanupRun?.run).toBe("pnpm accept:development:cleanup");
    expect(cleanupRun?.run).not.toContain("${{");
    expect(cleanupRun?.["working-directory"]).toBeUndefined();
    expect(cleanupRun?.id).toBe("cleanup");
    expect(cleanupRun?.env).toEqual({
      SUPABASE_DEVELOPMENT_AUTH_ADMIN_KEY:
        "${{ secrets.SUPABASE_DEVELOPMENT_AUTH_ADMIN_KEY }}",
      ACCEPTANCE_MANIFEST: "${{ needs.accept.outputs.manifest }}",
    });
    const emptyResources = cleanup.steps.find(
      (step) => step.name === "Record empty acceptance resources",
    );
    expect(emptyResources?.if).toBe(
      "steps.cleanup.outputs.hosted_resources == 'none'",
    );
    expect(emptyResources?.run).toBe("echo hosted_resources=none");
    expect(emptyResources?.env).toBeUndefined();
    expect(cleanup.steps.indexOf(emptyResources!)).toBe(
      cleanup.steps.indexOf(cleanupRun!) + 1,
    );
    expect(cleanup.env?.ACCEPTANCE_RUN_NONCE).toBe(
      "${{ needs.preflight.outputs.nonce }}",
    );
    expect(JSON.stringify(cleanup)).not.toContain(
      "TUTOR_MBOS_APP_DATABASE_URL",
    );
    expect(JSON.stringify(cleanup)).not.toContain(
      "SUPABASE_DEVELOPMENT_ACCESS_TOKEN",
    );
    expect(JSON.stringify(cleanup)).not.toContain("VERCEL_TOKEN");
    expect(cleanup.steps.some((step) => step.uses?.includes("artifact"))).toBe(
      false,
    );
    const script = readFileSync("scripts/hosted-acceptance.ts", "utf8");
    expect(script).toContain("bypass: bypass.value ?? null");
    expect(script).toContain("if (!input.bypass)");
    expect(script).toContain("new URL(url).origin === target.site");
    expect(script).not.toContain("url.startsWith(target.site)");
    expect(script).toContain("protection_bypass_absent");
    expect(script).toContain(
      "VERCEL_AUTOMATION_BYPASS_SECRET is absent. Copy the project's existing Protection Bypass for Automation value to GitHub → Settings → Environments → development → Secrets.",
    );
    expect(script).toContain("mask(runNonce)");
    expect(script).toContain("probeDirectTenants");
    expect(script).toContain(
      "writeManifestOutput(body, process.env.GITHUB_OUTPUT)",
    );
    expect(script).not.toContain("mask(body)");
    expect(script).not.toContain("writeManifestAtomic");
    const cleanupScript = readFileSync(
      "scripts/hosted-acceptance-cleanup.ts",
      "utf8",
    );
    expect(cleanupScript).toContain("mask(identity.runNonce)");
    expect(cleanupScript).toContain("ACCEPTANCE_MANIFEST");
    expect(cleanupScript).not.toContain("ACCEPTANCE_MANIFEST_PATH");
    expect(cleanupScript).not.toContain("O_NOFOLLOW");
    expect(cleanupScript).not.toContain("readFileSync");
    expect(cleanupScript).not.toContain("import(");
    expect(cleanupScript).not.toContain("download-artifact");
    expect(script).not.toContain("/auth/v1/admin");
    expect(script).not.toContain("auth.users");
    expect(script).not.toContain("SUPABASE_DEVELOPMENT_AUTH_ADMIN_KEY");
    expect(script).not.toContain("registration_client_uri");
    expect(script).not.toContain(".vercel/.env.production.local");
    expect(script).not.toMatch(/method:\s*"PATCH"/);
    expect(script).not.toMatch(/method:\s*"DELETE"/);
  });

  it("reports every missing business secret name and prints no value", () => {
    const script = "scripts/assert-business-acceptance-secrets.mjs";
    const run = (env: Record<string, string>) =>
      spawnSync(process.execPath, [script], {
        env: {
          PATH: process.env.PATH ?? "",
          NODE_ENV: "test",
          ...env,
        } as unknown as NodeJS.ProcessEnv,
        encoding: "utf8",
      });
    const bypass = "synthetic-bypass-value";
    const publishable = "synthetic-publishable-value";
    const database = "synthetic-database-value";
    const absent = run({});
    expect(absent.status).toBe(1);
    const absentText = `${absent.stdout}${absent.stderr}`;
    expect(absentText).toContain("VERCEL_AUTOMATION_BYPASS_SECRET is absent.");
    expect(absentText).toContain(
      "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY is absent.",
    );
    expect(absentText).toContain("TUTOR_MBOS_APP_DATABASE_URL is absent.");
    expect(absentText).toContain(
      "stops before the admin capability check until each absent business secret above is present",
    );
    const one = run({
      VERCEL_AUTOMATION_BYPASS_SECRET: bypass,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: publishable,
      TUTOR_MBOS_APP_DATABASE_URL: "",
    });
    expect(one.status).toBe(1);
    const oneText = `${one.stdout}${one.stderr}`;
    expect(oneText).toContain(
      "VERCEL_AUTOMATION_BYPASS_SECRET is present. Expected secret scope: GitHub environment development.",
    );
    expect(oneText).toContain(
      "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY is present. Expected secret scope: GitHub environment development.",
    );
    expect(oneText).toContain("TUTOR_MBOS_APP_DATABASE_URL is absent.");
    expect(oneText).not.toContain("VERCEL_AUTOMATION_BYPASS_SECRET is absent.");
    expect(oneText).not.toContain(bypass);
    expect(oneText).not.toContain(publishable);
    const ready = run({
      VERCEL_AUTOMATION_BYPASS_SECRET: bypass,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: publishable,
      TUTOR_MBOS_APP_DATABASE_URL: database,
    });
    expect(ready.status).toBe(0);
    const readyText = `${ready.stdout}${ready.stderr}`;
    expect(readyText).toContain("VERCEL_AUTOMATION_BYPASS_SECRET is present.");
    expect(readyText).toContain(
      "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY is present.",
    );
    expect(readyText).toContain("TUTOR_MBOS_APP_DATABASE_URL is present.");
    expect(readyText).not.toContain(bypass);
    expect(readyText).not.toContain(publishable);
    expect(readyText).not.toContain(database);
    expect(ready.stderr).toBe("");
    const whitespace = " \n\t ";
    const untrimmed = run({
      VERCEL_AUTOMATION_BYPASS_SECRET: whitespace,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: whitespace,
      TUTOR_MBOS_APP_DATABASE_URL: whitespace,
    });
    expect(untrimmed.status).toBe(0);
    const untrimmedText = `${untrimmed.stdout}${untrimmed.stderr}`;
    expect(untrimmedText).toContain(
      "VERCEL_AUTOMATION_BYPASS_SECRET is present.",
    );
    expect(untrimmedText).toContain(
      "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY is present.",
    );
    expect(untrimmedText).toContain("TUTOR_MBOS_APP_DATABASE_URL is present.");
    expect(untrimmedText).not.toContain("is absent");
  });

  it("publishes an empty manifest when signup throws after the user is committed", async () => {
    const doubled = developmentDouble();
    const bodies: string[] = [];
    const fetchImpl: typeof fetch = async (requestInput, init) => {
      const url = new URL(
        typeof requestInput === "string"
          ? requestInput
          : requestInput.toString(),
      );
      if (url.pathname === "/auth/v1/signup") {
        await doubled.fetchImpl(requestInput, init);
        throw new TypeError("fetch failed");
      }
      return doubled.fetchImpl(requestInput, init);
    };
    const report = await runHostedAcceptance(
      input(fetchImpl, {
        writeManifest: (body) => {
          bodies.push(body);
        },
      }),
    );
    expect(
      report.results.find((row) => row.id === "runner.exception")?.detail,
    ).toBe("TypeError");
    expect(
      report.results.find((row) => row.id === "cleanup.manifest")?.detail,
    ).toBe("no_hosted_users");
    const last = bodies.at(-1);
    expect(last).toBeDefined();
    const parsed = JSON.parse(last ?? "{}") as {
      users: unknown[];
      clients: unknown[];
    };
    expect(parsed.users).toEqual([]);
    expect(parsed.clients).toEqual([]);
    expect(last).not.toContain("@example.com");
  });

  it("exports a bounded manifest when the business run fails before signup", async () => {
    const bodies: string[] = [];
    const doubled = developmentDouble({ healthStatus: 503 });
    const report = await runHostedAcceptance(
      input(doubled.fetchImpl, {
        writeManifest: (body) => {
          bodies.push(body);
        },
      }),
    );
    expect(
      report.results.find((row) => row.id === "cleanup.manifest")?.detail,
    ).toBe("no_hosted_users");
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) {
      expect(Buffer.byteLength(body)).toBeLessThanOrEqual(4096);
      expect(body).not.toContain("@example.com");
      expect(body).not.toContain("07".repeat(16));
      const parsed = JSON.parse(body) as {
        users: unknown[];
        clients: unknown[];
      };
      expect(parsed.users).toEqual([]);
      expect(parsed.clients).toEqual([]);
    }
  });

  it("stops before signup when health does not match the source", async () => {
    let probed = false;
    const doubled = developmentDouble({ healthStatus: 503 });
    const report = await runHostedAcceptance(
      input(doubled.fetchImpl, {
        probeDatabase: async () => {
          probed = true;
          return {
            runtimeReadDenied: true,
            ownVisible: true,
            otherVisible: false,
            deleted: true,
            aborted: false,
            abortReason: null,
          };
        },
      }),
    );
    expect(report.results.find((row) => row.id === "health")?.status).toBe(
      "fail",
    );
    expect(
      report.results.find((row) => row.id === "signup.tenant_a")?.detail,
    ).toBe("not_executed");
    expect(doubled.urls.some((url) => url.includes("/auth/v1/signup"))).toBe(
      false,
    );
    expect(
      doubled.urls.some((url) => url.includes("/api/oauth/decision")),
    ).toBe(false);
    expect(probed).toBe(false);
  });

  it("does not request the site when the automation bypass is absent", async () => {
    let called = false;
    const bodies: string[] = [];
    const report = await runHostedAcceptance(
      input(
        async () => {
          called = true;
          throw new Error("protected site must not be called");
        },
        {
          bypass: null,
          writeManifest: (body) => {
            bodies.push(body);
          },
        },
      ),
    );
    expect(called).toBe(false);
    expect(report.deployedCommit).toBe("");
    expect(report.results.find((row) => row.id === "health")?.detail).toBe(
      "protection_bypass_absent",
    );
    expect(
      report.results.find((row) => row.id === "signup.tenant_a")?.detail,
    ).toBe("not_executed");
    expect(
      report.results.find((row) => row.id === "cleanup.manifest")?.detail,
    ).toBe("no_hosted_users");
    expect(bodies).toHaveLength(2);
    expect(JSON.parse(bodies[0]!).users).toEqual([]);
  });

  it.each([undefined, ""])(
    "does not request the site when the bypass is %j",
    async (bypass) => {
      let called = false;
      const report = await runHostedAcceptance(
        input(
          async () => {
            called = true;
            throw new Error("protected site must not be called");
          },
          { bypass },
        ),
      );
      expect(called).toBe(false);
      expect(report.results.find((row) => row.id === "health")?.detail).toBe(
        "protection_bypass_absent",
      );
      expect(
        report.results.find((row) => row.id === "signup.tenant_a")?.detail,
      ).toBe("not_executed");
    },
  );

  it("records a protection page with no health commit as commit absent", async () => {
    const seen: string[] = [];
    const report = await runHostedAcceptance(
      input(
        async (_url, init) => {
          seen.push(
            new Headers(init?.headers).get("x-vercel-protection-bypass") ?? "",
          );
          return new Response("<html>Authentication Required</html>", {
            status: 401,
            headers: { "content-type": "text/html" },
          });
        },
        { bypass: "synthetic-bypass" },
      ),
    );
    expect(seen).toEqual(["synthetic-bypass"]);
    expect(report.deployedCommit).toBe("");
    expect(report.results.find((row) => row.id === "health")?.detail).toBe(
      "http_401 commit=absent",
    );
    expect(
      report.results.find((row) => row.id === "signup.tenant_a")?.detail,
    ).toBe("not_executed");
    expect(formatAcceptanceReport(report)).toContain("deployed_commit=absent");
  });

  it("records a different health commit as a mismatch after the bypass is sent", async () => {
    const other = "b".repeat(40);
    const seen: string[] = [];
    const report = await runHostedAcceptance(
      input(async (_url, init) => {
        seen.push(
          new Headers(init?.headers).get("x-vercel-protection-bypass") ?? "",
        );
        return new Response(
          JSON.stringify({
            status: "ok",
            environment: "development",
            supabaseProjectRef:
              ENVIRONMENT_BINDINGS.development.supabaseProjectRef,
            commit: other,
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }),
    );
    expect(seen).toEqual([SYNTHETIC_BYPASS]);
    expect(report.deployedCommit).toBe(other);
    expect(report.results.find((row) => row.id === "health")?.detail).toBe(
      "http_200 commit=mismatch",
    );
    expect(
      report.results.find((row) => row.id === "signup.tenant_a")?.detail,
    ).toBe("not_executed");
  });

  it("fails when the closing health commit differs from the source", async () => {
    const doubled = developmentDouble({ closingCommit: "c".repeat(40) });
    const report = await runHostedAcceptance(input(doubled.fetchImpl));
    expect(report.source).toBe(commit);
    expect(report.deployedCommit).toBe(commit);
    expect(report.closingCommit).toBe("c".repeat(40));
    expect(
      report.results.find((row) => row.id === "health.closing")?.status,
    ).toBe("fail");
    const text = formatAcceptanceReport(report);
    expect(text).toContain(`source=${commit}`);
    expect(text).toContain(`deployed_commit=${commit}`);
    expect(text).toContain(`closing_commit=${"c".repeat(40)}`);
  });

  it("rejects an OAuth denial that is only a redirect", async () => {
    const doubled = developmentDouble({ denyLocation: `${site}/business` });
    const report = await runHostedAcceptance(input(doubled.fetchImpl));
    expect(
      report.results.find((row) => row.id === "generic_client.denial")?.status,
    ).toBe("fail");
  });

  it("does not treat a PostgREST outage as an isolation denial", async () => {
    const doubled = developmentDouble({
      dataApi: { status: 503, code: "PGRST002" },
    });
    const report = await runHostedAcceptance(input(doubled.fetchImpl));
    expect(
      report.results.find((row) => row.id === "data_api.anon_businesses")
        ?.status,
    ).toBe("fail");
  });

  it("uses preflight cases and does not call the Management API", async () => {
    const doubled = developmentDouble();
    const report = await runHostedAcceptance(
      input(doubled.fetchImpl, {
        managementToken: null,
        preflightCases: [
          "auth.oauth_server_enabled",
          "auth.dynamic_registration",
          "auth.authorization_path",
          "auth.site_url",
          "auth.redirect_allow_list",
          "auth.secure_password_change",
          "auth.exposed_schemas",
        ].map((id) => acceptanceCase(id, "pass", "preflight")),
      }),
    );
    expect(report.results.filter((row) => row.status === "fail")).toEqual([]);
    expect(doubled.urls.some((url) => url.includes("api.supabase.com"))).toBe(
      false,
    );
  });

  it("probes both synthetic tenants", async () => {
    const doubled = developmentDouble();
    const seen: string[] = [];
    await runHostedAcceptance(
      input(doubled.fetchImpl, {
        probeDatabase: async (_url, probe) => {
          seen.push(probe.userId);
          return {
            runtimeReadDenied: true,
            ownVisible: true,
            otherVisible: false,
            deleted: true,
            aborted: false,
            abortReason: null,
          };
        },
      }),
    );
    expect(new Set(seen).size).toBe(2);
  });

  it("records orphan rows when a tenant probe aborts", async () => {
    const doubled = developmentDouble();
    const report = await runHostedAcceptance(
      input(doubled.fetchImpl, {
        probeDatabase: async () => ({
          runtimeReadDenied: true,
          ownVisible: true,
          otherVisible: true,
          deleted: false,
          aborted: true,
          abortReason: "visibility",
        }),
      }),
    );
    expect(
      report.results.find((row) => row.id === "direct.cleanup")?.detail,
    ).toBe("aborted_unexpected_visibility");
    expect(
      report.results.find((row) => row.id === "direct.orphan_rows")?.status,
    ).toBe("gap");
    expect(
      report.results.find((row) => row.id === "direct.audit_and_grants")
        ?.status,
    ).toBe("gap");
    expect(
      report.results.find((row) => row.id === "cleanup.hard_kill")?.status,
    ).toBe("gap");
  });

  it("records a lost signup response and does not continue to consent", async () => {
    const doubled = developmentDouble();
    const fetchImpl: typeof fetch = async (url, init) => {
      const target = typeof url === "string" ? url : url.toString();
      if (target.includes("/auth/v1/signup")) {
        await new Promise((_, reject) => {
          const signal = init?.signal;
          const fail = () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          };
          if (!signal) {
            fail();
            return;
          }
          if (signal.aborted) fail();
          else signal.addEventListener("abort", fail, { once: true });
        });
      }
      return doubled.fetchImpl(url, init);
    };
    const report = await runHostedAcceptance(
      input(fetchImpl, { requestTimeoutMs: 30 }),
    );
    expect(
      report.results.find((row) => row.id === "signup.tenant_a")?.detail,
    ).toBe("signup.response_lost");
    expect(
      report.results.find((row) => row.id === "signup.response_lost")?.status,
    ).toBe("gap");
    expect(
      doubled.urls.some((url) => url.includes("/api/oauth/decision")),
    ).toBe(false);
    expect(
      report.results.some(
        (row) => row.id === "generic_client.consent" && row.status === "pass",
      ),
    ).toBe(false);
  });
});

describe("acceptance classifiers", () => {
  it("redacts secrets and records the secure password change value", () => {
    expect(
      sanitizeDetail(`user@example.com ${publishableKey} ${jwtSecret}`),
    ).not.toContain("@example.com");
    expect(sanitizeDetail(publishableKey)).toBe("[redacted]");
    const cases = classifyAuthSettings(
      {
        oauth_server_enabled: true,
        oauth_server_allow_dynamic_registration: true,
        oauth_server_authorization_path: "/oauth/consent",
        site_url: site,
        uri_allow_list: `${site}/auth/callback ${site}/auth/recovery`,
        security_update_password_require_reauthentication: true,
      },
      site,
    );
    expect(cases.every((row) => row.status === "pass")).toBe(true);
    expect(classifyExposedSchemas("public, app").detail).toBe(
      "db_schema=public,app",
    );
    expect(dataApiDenied(404, { code: "PGRST205" })).toBe(true);
    expect(dataApiDenied(406, { code: "PGRST106" })).toBe(true);
    expect(dataApiDenied(401, { code: "PGRST301" })).toBe(true);
    expect(dataApiDenied(401, { code: "PGRST302" })).toBe(true);
    expect(dataApiDenied(401, { code: "PGRST303" })).toBe(true);
    expect(dataApiDenied(403, { code: "42501" })).toBe(true);
    expect(dataApiDenied(401, { code: "42501" })).toBe(true);
    expect(dataApiDenied(503, { code: "PGRST002" })).toBe(false);
    expect(dataApiDenied(504, { code: "PGRST003" })).toBe(false);
    expect(dataApiDenied(500, { code: "PGRST000" })).toBe(false);
    expect(dataApiDenied(404, { code: "PGRST116" })).toBe(false);
    expect(dataApiDenied(200, { code: "PGRST205" })).toBe(false);
    expect(dataApiDenied(403, { code: "PGRST301" })).toBe(false);
    expect(
      classifyIssuedAudience("authenticated", `${site}/api/mcp`).detail,
    ).toContain("resource_audience=absent");
  });

  it("resolves material without treating a sensitive pull as a password", () => {
    expect(
      acceptanceGuard({
        TUTOR_MBOS_ACCEPTANCE: "development",
        GITHUB_ACTIONS: "true",
        GITHUB_REF: "refs/heads/main",
      }),
    ).toBeNull();
    expect(acceptanceGuard({})).toContain("protected development workflow");
    const material = resolveAcceptanceMaterial(
      { [PUBLISHABLE_KEY_NAME]: publishableKey },
      { [APP_DATABASE_URL_SECRET]: "[SENSITIVE]" },
    );
    expect(material.publishableKey).toBe(publishableKey);
    expect(material.appDatabaseUrl).toBeNull();
    expect(material.managementToken).toBeNull();
  });
});

describe("direct tenant probe", () => {
  it("lets app_runtime read only the caller's business and then delete it", async () => {
    const { db, connection, store } = await migratedDatabase();
    const userA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
    const userB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
    const actor = (userId: string) => ({
      path: "ui-session" as const,
      userId,
      clientId: null,
    });
    const createdA = await store.createBusiness(actor(userA), {
      displayName: "Synthetic A",
      idempotencyKey: "tos3-a",
    });
    const createdB = await store.createBusiness(actor(userB), {
      displayName: "Synthetic B",
      idempotencyKey: "tos3-b",
    });
    await connection.exec("create role app_runtime login noinherit");
    await connection.exec(
      "grant app_request to app_runtime with inherit false, set true",
    );
    await connection.exec("set session authorization app_runtime");
    const [probe, probeB] = await probeDirectTenants(connection, [
      {
        userId: userA,
        ownBusinessId: createdA.business.id,
        otherBusinessId: createdB.business.id,
        clientIds: [],
      },
      {
        userId: userB,
        ownBusinessId: createdB.business.id,
        otherBusinessId: createdA.business.id,
        clientIds: [],
      },
    ]);
    expect(probe?.runtimeReadDenied).toBe(true);
    expect(probe?.ownVisible).toBe(true);
    expect(probe?.otherVisible).toBe(false);
    expect(probe?.deleted).toBe(true);
    expect(probeB?.ownVisible).toBe(true);
    expect(probeB?.otherVisible).toBe(false);
    expect(probeB?.deleted).toBe(true);
    await connection.exec("reset session authorization");
    expect(await store.readBusiness(actor(userB))).toBeNull();
    expect(await store.readBusiness(actor(userA))).toBeNull();
    await db.close();
  });

  it("stops before any write when a permissive policy makes other tenants visible", async () => {
    const { db, connection, store } = await migratedDatabase();
    const userA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
    const userB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
    const userC = "12121212-1212-4121-8121-121212121212";
    const actor = (userId: string) => ({
      path: "ui-session" as const,
      userId,
      clientId: null,
    });
    const createdA = await store.createBusiness(actor(userA), {
      displayName: "Synthetic A",
      idempotencyKey: "tos3-a",
    });
    const createdB = await store.createBusiness(actor(userB), {
      displayName: "Synthetic B",
      idempotencyKey: "tos3-b",
    });
    const createdC = await store.createBusiness(actor(userC), {
      displayName: "Synthetic C",
      idempotencyKey: "tos3-c",
    });
    await connection.exec(
      "alter policy businesses_owner on app.businesses using (true) with check (true)",
    );
    await connection.exec(
      "alter policy creation_keys_owner on app.business_creation_keys using (true) with check (true)",
    );
    await connection.exec("create role app_runtime login noinherit");
    await connection.exec(
      "grant app_request to app_runtime with inherit false, set true",
    );
    await connection.exec("set session authorization app_runtime");
    const probe = await probeDirectTenantAccess(connection, {
      userId: userA,
      ownBusinessId: createdA.business.id,
      otherBusinessId: createdB.business.id,
      clientIds: [],
    });
    expect(probe.otherVisible).toBe(true);
    expect(probe.deleted).toBe(false);
    expect(probe.aborted).toBe(true);
    expect(probe.abortReason).toBe("visibility");
    const claims = JSON.stringify({
      sub: userA,
      role: "authenticated",
      aud: "authenticated",
    });
    const remaining = await connection.transaction(async (tx) => {
      await tx.query("select set_config('request.jwt.claims', $1, true)", [
        claims,
      ]);
      await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [
        userA,
      ]);
      await tx.exec("set local role app_request");
      return tx.query<{ id: string }>(
        "select id::text as id from app.businesses",
      );
    });
    expect(remaining.rows.map((row) => row.id).sort()).toEqual(
      [createdA.business.id, createdB.business.id, createdC.business.id].sort(),
    );
    await db.close();
  });

  it("stops before any write when tenant B can see the other businesses", async () => {
    const { db, connection, store } = await migratedDatabase();
    const userA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
    const userB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
    const userC = "12121212-1212-4121-8121-121212121212";
    const actor = (userId: string) => ({
      path: "ui-session" as const,
      userId,
      clientId: null,
    });
    const createdA = await store.createBusiness(actor(userA), {
      displayName: "Synthetic A",
      idempotencyKey: "tos3-a",
    });
    const createdB = await store.createBusiness(actor(userB), {
      displayName: "Synthetic B",
      idempotencyKey: "tos3-b",
    });
    const createdC = await store.createBusiness(actor(userC), {
      displayName: "Synthetic C",
      idempotencyKey: "tos3-c",
    });
    await connection.exec(
      "alter policy businesses_owner on app.businesses using (true) with check (true)",
    );
    await connection.exec(
      "alter policy creation_keys_owner on app.business_creation_keys using (true) with check (true)",
    );
    await connection.exec("create role app_runtime login noinherit");
    await connection.exec(
      "grant app_request to app_runtime with inherit false, set true",
    );
    await connection.exec("set session authorization app_runtime");
    const probe = await probeDirectTenantAccess(connection, {
      userId: userB,
      ownBusinessId: createdB.business.id,
      otherBusinessId: createdA.business.id,
      clientIds: [],
    });
    expect(probe.otherVisible).toBe(true);
    expect(probe.deleted).toBe(false);
    expect(probe.aborted).toBe(true);
    expect(probe.abortReason).toBe("visibility");
    const claims = JSON.stringify({
      sub: userB,
      role: "authenticated",
      aud: "authenticated",
    });
    const remaining = await connection.transaction(async (tx) => {
      await tx.query("select set_config('request.jwt.claims', $1, true)", [
        claims,
      ]);
      await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [
        userB,
      ]);
      await tx.exec("set local role app_request");
      return tx.query<{ id: string }>(
        "select id::text as id from app.businesses",
      );
    });
    expect(remaining.rows.map((row) => row.id).sort()).toEqual(
      [createdA.business.id, createdB.business.id, createdC.business.id].sort(),
    );
    await db.close();
  });

  it("reads both tenants before either cleanup when the owner policy is permissive", async () => {
    const { db, connection, store } = await migratedDatabase();
    const userA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
    const userB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
    const userC = "12121212-1212-4121-8121-121212121212";
    const actor = (userId: string) => ({
      path: "ui-session" as const,
      userId,
      clientId: null,
    });
    const createdA = await store.createBusiness(actor(userA), {
      displayName: "Synthetic A",
      idempotencyKey: "tos3-a",
    });
    const createdB = await store.createBusiness(actor(userB), {
      displayName: "Synthetic B",
      idempotencyKey: "tos3-b",
    });
    const createdC = await store.createBusiness(actor(userC), {
      displayName: "Synthetic C",
      idempotencyKey: "tos3-c",
    });
    await connection.exec(
      "alter policy businesses_owner on app.businesses using (true) with check (true)",
    );
    await connection.exec(
      "alter policy creation_keys_owner on app.business_creation_keys using (true) with check (true)",
    );
    await connection.exec("create role app_runtime login noinherit");
    await connection.exec(
      "grant app_request to app_runtime with inherit false, set true",
    );
    await connection.exec("set session authorization app_runtime");
    const probes = await probeDirectTenants(connection, [
      {
        userId: userA,
        ownBusinessId: createdA.business.id,
        otherBusinessId: createdB.business.id,
        clientIds: [],
      },
      {
        userId: userB,
        ownBusinessId: createdB.business.id,
        otherBusinessId: createdA.business.id,
        clientIds: [],
      },
    ]);
    expect(probes.map((probe) => probe.otherVisible)).toEqual([true, true]);
    expect(probes.every((probe) => probe.deleted === false)).toBe(true);
    expect(probes.every((probe) => probe.abortReason === "visibility")).toBe(
      true,
    );
    const claims = JSON.stringify({
      sub: userA,
      role: "authenticated",
      aud: "authenticated",
    });
    const remaining = await connection.transaction(async (tx) => {
      await tx.query("select set_config('request.jwt.claims', $1, true)", [
        claims,
      ]);
      await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [
        userA,
      ]);
      await tx.exec("set local role app_request");
      const businesses = await tx.query<{ id: string }>(
        "select id::text as id from app.businesses",
      );
      const keys = await tx.query<{ business_id: string }>(
        "select business_id::text as business_id from app.business_creation_keys",
      );
      return { businesses, keys };
    });
    expect(remaining.businesses.rows.map((row) => row.id).sort()).toEqual(
      [createdA.business.id, createdB.business.id, createdC.business.id].sort(),
    );
    expect(remaining.keys.rows.map((row) => row.business_id).sort()).toEqual(
      [createdA.business.id, createdB.business.id, createdC.business.id].sort(),
    );
    await db.close();
  });

  it("rolls back when the scoped creation-key count is not exactly one", async () => {
    const { db, connection, store } = await migratedDatabase();
    const userA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
    const userB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
    const actor = (userId: string) => ({
      path: "ui-session" as const,
      userId,
      clientId: null,
    });
    const createdA = await store.createBusiness(actor(userA), {
      displayName: "Synthetic A",
      idempotencyKey: "tos3-a",
    });
    const createdB = await store.createBusiness(actor(userB), {
      displayName: "Synthetic B",
      idempotencyKey: "tos3-b",
    });
    await connection.query(
      `insert into app.business_creation_keys (owner_user_id, idempotency_key, business_id)
       values ($1::uuid, 'extra', $2::uuid)`,
      [userA, createdA.business.id],
    );
    await connection.exec("create role app_runtime login noinherit");
    await connection.exec(
      "grant app_request to app_runtime with inherit false, set true",
    );
    await connection.exec("set session authorization app_runtime");
    const probe = await probeDirectTenantAccess(connection, {
      userId: userA,
      ownBusinessId: createdA.business.id,
      otherBusinessId: createdB.business.id,
      clientIds: [],
    });
    expect(probe.deleted).toBe(false);
    expect(probe.abortReason).toBe("count");
    await connection.exec("reset session authorization");
    expect((await store.readBusiness(actor(userA)))?.id).toBe(
      createdA.business.id,
    );
    expect((await store.readBusiness(actor(userB)))?.id).toBe(
      createdB.business.id,
    );
    await db.close();
  });

  it("does not delete the second tenant after the first cleanup rolls back", async () => {
    const { db, connection, store } = await migratedDatabase();
    const userA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
    const userB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
    const actor = (userId: string) => ({
      path: "ui-session" as const,
      userId,
      clientId: null,
    });
    const createdA = await store.createBusiness(actor(userA), {
      displayName: "Synthetic A",
      idempotencyKey: "tos3-a",
    });
    const createdB = await store.createBusiness(actor(userB), {
      displayName: "Synthetic B",
      idempotencyKey: "tos3-b",
    });
    await connection.query(
      `insert into app.business_creation_keys (owner_user_id, idempotency_key, business_id)
       values ($1::uuid, 'extra', $2::uuid)`,
      [userA, createdA.business.id],
    );
    await connection.exec("create role app_runtime login noinherit");
    await connection.exec(
      "grant app_request to app_runtime with inherit false, set true",
    );
    await connection.exec("set session authorization app_runtime");
    const probes = await probeDirectTenants(connection, [
      {
        userId: userA,
        ownBusinessId: createdA.business.id,
        otherBusinessId: createdB.business.id,
        clientIds: [],
      },
      {
        userId: userB,
        ownBusinessId: createdB.business.id,
        otherBusinessId: createdA.business.id,
        clientIds: [],
      },
    ]);
    expect(probes[0]?.abortReason).toBe("count");
    expect(probes[0]?.deleted).toBe(false);
    expect(probes[1]?.deleted).toBe(false);
    expect(probes[0]?.otherVisible).toBe(false);
    expect(probes[1]?.otherVisible).toBe(false);
    await connection.exec("reset session authorization");
    expect((await store.readBusiness(actor(userA)))?.id).toBe(
      createdA.business.id,
    );
    expect((await store.readBusiness(actor(userB)))?.id).toBe(
      createdB.business.id,
    );
    await db.close();
  });
});
