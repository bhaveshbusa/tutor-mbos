import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  acceptanceGuard,
  resolveAcceptanceMaterial,
  runHostedAcceptance,
} from "../scripts/hosted-acceptance.ts";
import {
  APP_DATABASE_URL_SECRET,
  MANAGEMENT_TOKEN_SECRET,
  PUBLISHABLE_KEY_NAME,
  acceptanceTally,
  classifyAuthSettings,
  classifyExposedSchemas,
  classifyIssuedAudience,
  formatAcceptanceReport,
  probeDirectTenantAccess,
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
}

function developmentDouble(options: DoubleOptions = {}) {
  const urls: string[] = [];
  const users = new Map<
    string,
    { id: string; access: string; refresh: string }
  >();
  const businesses = new Map<string, string>();
  const authorizations = new Map<
    string,
    { clientId: string; userId?: string }
  >();
  const codes = new Map<string, { userId: string; clientId: string }>();
  const revoked = new Set<string>();
  let userCount = 0;
  let clientCount = 0;
  let authCount = 0;

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
      return json(200, {
        status: "ok",
        environment: "development",
        supabaseProjectRef: ENVIRONMENT_BINDINGS.development.supabaseProjectRef,
        commit,
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
      const clientId =
        clientCount === 1
          ? "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee5"
          : "ffffffff-ffff-4fff-8fff-fffffffffff6";
      return json(201, {
        client_id: clientId,
        registration_client_uri: `${supabaseUrl}/auth/v1/oauth/clients/${clientId}`,
        registration_access_token: `registration-${clientCount}`,
      });
    }
    if (url.pathname === "/auth/v1/oauth/authorize") {
      authCount += 1;
      const id = `auth-${authCount}`;
      authorizations.set(id, {
        clientId: url.searchParams.get("client_id") ?? "",
      });
      return redirect(302, `${site}/oauth/consent?authorization_id=${id}`);
    }
    if (url.pathname === "/api/oauth/decision") {
      const decision = form().get("decision");
      const authorizationId = form().get("authorization_id") ?? "";
      const pending = authorizations.get(authorizationId);
      if (!pending) return json(400, { title: "Bad request" });
      if (decision === "deny") {
        return redirect(
          303,
          "https://example.com/oauth/callback?error=access_denied",
        );
      }
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
    if (url.pathname === "/api/mcp") {
      const bearer = header("authorization").replace(/^Bearer\s+/i, "");
      const claims = payloadOf(bearer);
      const own = businessFor(String(claims.sub));
      const other = [...businesses.values()].find((id) => id !== own) ?? own;
      const id = options.leak ? other : own;
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
      return new Response(null, { status: 204 });
    }
    if (
      url.pathname.startsWith("/auth/v1/oauth/clients/") &&
      init?.method === "DELETE"
    ) {
      return new Response(null, { status: 204 });
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

  return { fetchImpl, urls };
}

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
    probeDatabase: async () => ({
      runtimeReadDenied: true,
      ownVisible: true,
      otherVisible: false,
      deleted: true,
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
      report.results.find((row) => row.id === "cleanup.tenant_a")?.status,
    ).toBe("pass");
    const text = formatAcceptanceReport(report);
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
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    expect(text).not.toContain(ENVIRONMENT_BINDINGS.production.vercelProjectId);
    expect(text).not.toContain("pull_request");
    expect(text).not.toContain("migrate:development");
    expect(text).not.toContain("deploy --prebuilt");
    expect(text).toContain(
      "SUPABASE_DEVELOPMENT_ACCESS_TOKEN is absent. Expected secret scope: GitHub environment development",
    );
    expect(text).toContain(
      "TUTOR_MBOS_APP_DATABASE_URL is absent. Expected secret scope: GitHub environment development",
    );
    const script = readFileSync("scripts/hosted-acceptance.ts", "utf8");
    expect(script).not.toContain("/auth/v1/admin");
    expect(script).not.toContain("auth.users");
    expect(script).not.toMatch(/method:\s*"PATCH"/);
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
    const probe = await probeDirectTenantAccess(connection, {
      userId: userA,
      ownBusinessId: createdA.business.id,
      otherBusinessId: createdB.business.id,
    });
    expect(probe.runtimeReadDenied).toBe(true);
    expect(probe.ownVisible).toBe(true);
    expect(probe.otherVisible).toBe(false);
    expect(probe.deleted).toBe(true);
    await connection.exec("reset session authorization");
    expect((await store.readBusiness(actor(userB)))?.id).toBe(
      createdB.business.id,
    );
    expect(await store.readBusiness(actor(userA))).toBeNull();
    await db.close();
  });
});
