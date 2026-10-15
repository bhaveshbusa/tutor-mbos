/**
 * Development-only hosted acceptance. Secretless CI tests the classifiers
 * and this sequence with a fake transport. The protected workflow is the
 * only caller that sets TUTOR_MBOS_ACCEPTANCE=development, and it is not
 * executed from a coding workspace.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseDotenv } from "./assert-deploy-target.ts";
import { resolveProtectionBypass } from "./smoke-health.ts";
import {
  APP_DATABASE_URL_SECRET,
  EXPECTED_AUTHORIZATION_PATH,
  MANAGEMENT_TOKEN_SECRET,
  PUBLISHABLE_KEY_NAME,
  REAL_CLIENT_GAPS,
  acceptanceCase,
  blockedCases,
  classifyAuthSettings,
  classifyDirectProbe,
  classifyExposedSchemas,
  acceptanceTally,
  classifyIssuedAudience,
  dataApiDenied,
  formatAcceptanceReport,
  jwtAudience,
  openApiExposesApp,
  probeDirectTenantAccess,
  schemaIdentity,
  type AcceptanceCase,
  type AcceptanceReport,
  type AuthConfigSnapshot,
  type DirectProbe,
} from "../src/server/application/hosted-acceptance.ts";
import { pgConnection } from "../src/server/application/pg-connection.ts";
import {
  inspectAppDatabaseUrl,
  resourceUrl,
  siteOriginFor,
} from "../src/server/config/access.ts";
import {
  ENVIRONMENT_BINDINGS,
  looksLikeSecret,
  supabaseUrlFor,
} from "../src/server/config/environments.ts";

const GENERIC_REDIRECT = "https://example.com/oauth/callback";
const SESSION_IDS = [
  "login.tenant_a",
  "login.tenant_b",
  "refresh.platform",
  "refresh.ui_session",
  "refresh.ui_rotation",
  "ui.tenant_a_positive",
  "ui.tenant_b_positive",
  "ui.tenant_a_negative",
  "ui.tenant_b_negative",
  "data_api.app_profile",
  "generic_client.consent",
  "generic_client.audience",
  "generic_client.api_positive",
  "generic_client.api_negative",
  "generic_client.api_no_bearer",
  "generic_client.api_ui_token_as_bearer",
  "generic_client.mcp_positive",
  "generic_client.mcp_negative",
  "generic_client.tenant_b_positive",
  "generic_client.tenant_b_negative",
  "generic_client.revocation",
  "generic_client.reconnection",
  "generic_client.denial",
  "generic_client.bearer_not_upgraded",
  "generic_client.refresh",
  "data_api.authenticated_businesses",
] as const;

const KEY_IDS = [
  "signup.tenant_a",
  "signup.tenant_b",
  "auth.oauth_metadata",
  "data_api.openapi",
  "data_api.anon_businesses",
  ...SESSION_IDS,
] as const;

export interface HostedAcceptanceInput {
  commit: string;
  publishableKey: string | null;
  managementToken: string | null;
  appDatabaseUrl: string | null;
  bypass?: string | null;
  fetchImpl?: typeof fetch;
  randomBytes?: (size: number) => Buffer;
  probeDatabase?: (
    url: string,
    input: { userId: string; ownBusinessId: string; otherBusinessId: string },
  ) => Promise<DirectProbe>;
  schema: string;
}

interface RegisteredClient {
  clientId: string;
  clientSecret: string | null;
  registrationUri: string | null;
  registrationToken: string | null;
}

interface Tenant {
  label: "tenant-a" | "tenant-b";
  email: string;
  password: string;
  userId: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  businessId: string | null;
  delegatedToken: string | null;
  jar: Map<string, string>;
}

interface Reply {
  status: number;
  headers: Headers;
  text: string;
}

export function acceptanceGuard(
  env: Record<string, string | undefined>,
): string | null {
  if (
    env.TUTOR_MBOS_ACCEPTANCE !== "development" ||
    env.GITHUB_ACTIONS !== "true"
  ) {
    return "Hosted acceptance runs only from the protected development workflow.";
  }
  if (env.GITHUB_REF && env.GITHUB_REF !== "refs/heads/main") {
    return "Hosted acceptance runs from main only.";
  }
  return null;
}

export function resolveAcceptanceMaterial(
  env: Record<string, string | undefined>,
  pulled: Record<string, string | undefined>,
): {
  publishableKey: string | null;
  managementToken: string | null;
  appDatabaseUrl: string | null;
} {
  const key =
    usableKey(env[PUBLISHABLE_KEY_NAME]) ??
    usableKey(pulled[PUBLISHABLE_KEY_NAME]);
  const management = usableSecret(env[MANAGEMENT_TOKEN_SECRET]);
  const fromEnv = env[APP_DATABASE_URL_SECRET];
  const database =
    fromEnv && fromEnv !== "[SENSITIVE]"
      ? fromEnv
      : usableSecret(pulled[APP_DATABASE_URL_SECRET]);
  return {
    publishableKey: key,
    managementToken: management,
    appDatabaseUrl: database,
  };
}

function usableKey(value: string | undefined): string | null {
  if (!value || value === "[SENSITIVE]" || looksLikeSecret(value)) return null;
  return /^sb_publishable_[A-Za-z0-9_-]+$/.test(value) ? value : null;
}

function usableSecret(value: string | undefined): string | null {
  if (!value || value === "[SENSITIVE]") return null;
  return value;
}

function developmentTarget(): {
  site: string;
  supabaseUrl: string;
  ref: string;
} {
  const ref = ENVIRONMENT_BINDINGS.development.supabaseProjectRef;
  const productionRef: string =
    ENVIRONMENT_BINDINGS.production.supabaseProjectRef;
  if (ref === productionRef) throw new Error("acceptance_target");
  return {
    site: siteOriginFor("development"),
    supabaseUrl: supabaseUrlFor(ref),
    ref,
  };
}

function reviewedSchema(): string {
  const manifest = JSON.parse(
    readFileSync("supabase/migrations/manifest.json", "utf8"),
  ) as { migrations: { version: string; sha256: string }[] };
  return schemaIdentity(manifest.migrations);
}

export async function runHostedAcceptance(
  input: HostedAcceptanceInput,
): Promise<AcceptanceReport> {
  const target = developmentTarget();
  const results: AcceptanceCase[] = [];
  const fetchImpl = input.fetchImpl ?? fetch;
  const rng = input.randomBytes ?? randomBytes;
  const nonce = rng(8).toString("hex");
  let deployedCommit = "";
  const tenants: Tenant[] = (["tenant-a", "tenant-b"] as const).map(
    (label) => ({
      label,
      email: `tos3-${label}-${nonce}@example.com`,
      password: syntheticPassword(rng(24)),
      userId: null,
      accessToken: null,
      refreshToken: null,
      businessId: null,
      delegatedToken: null,
      jar: new Map<string, string>(),
    }),
  );
  const tenantA = requiredTenant(tenants[0]);
  const tenantB = requiredTenant(tenants[1]);
  let registration: RegisteredClient | null = null;
  let denialRegistration: RegisteredClient | null = null;

  const request = async (
    url: string,
    init: RequestInit & { redirect?: RequestRedirect } = {},
  ): Promise<Reply> => {
    const headers = new Headers(init.headers);
    const onSite = url.startsWith(target.site);
    if (onSite && input.bypass) {
      headers.set("x-vercel-protection-bypass", input.bypass);
    }
    const response = await fetchImpl(url, {
      ...init,
      headers,
      redirect: "manual",
    });
    return {
      status: response.status,
      headers: response.headers,
      text: await response.text(),
    };
  };

  const json = (reply: Reply): unknown => {
    try {
      return JSON.parse(reply.text) as unknown;
    } catch {
      return undefined;
    }
  };

  const authHeaders = (): Record<string, string> => ({
    apikey: input.publishableKey ?? "",
    "content-type": "application/json",
  });

  const rememberCookies = (tenant: Tenant, headers: Headers) => {
    const listed =
      typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];
    for (const line of listed) {
      const pair = line.split(";")[0] ?? "";
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1);
      if (value.length === 0 || /max-age=0/i.test(line))
        tenant.jar.delete(name);
      else tenant.jar.set(name, value);
    }
  };

  const cookieHeader = (tenant: Tenant): string =>
    [...tenant.jar].map(([name, value]) => `${name}=${value}`).join("; ");

  try {
    const health = await request(`${target.site}/api/v1/health`, {
      headers: { accept: "application/json" },
    });
    const healthBody = json(health) as {
      status?: unknown;
      environment?: unknown;
      supabaseProjectRef?: unknown;
      commit?: unknown;
    };
    deployedCommit =
      typeof healthBody?.commit === "string" ? healthBody.commit : "";
    const healthPass =
      health.status === 200 &&
      healthBody?.status === "ok" &&
      healthBody.environment === "development" &&
      healthBody.supabaseProjectRef === target.ref &&
      deployedCommit === input.commit;
    results.push(
      acceptanceCase(
        "health",
        healthPass ? "pass" : "fail",
        healthPass
          ? "development_commit_match"
          : `http_${health.status} commit=${deployedCommit === input.commit ? "match" : "mismatch"}`,
      ),
    );

    const resourceReply = await request(
      `${target.site}/.well-known/oauth-protected-resource`,
      { headers: { accept: "application/json" } },
    );
    const resourceBody = json(resourceReply) as {
      resource?: unknown;
      authorization_servers?: unknown;
    };
    const servers = Array.isArray(resourceBody?.authorization_servers)
      ? resourceBody.authorization_servers
      : [];
    const resourcePass =
      resourceReply.status === 200 &&
      resourceBody?.resource === resourceUrl(target.site) &&
      servers.includes(`${target.supabaseUrl}/auth/v1`);
    results.push(
      acceptanceCase(
        "auth.protected_resource",
        resourcePass ? "pass" : "fail",
        resourcePass ? "match" : `http_${resourceReply.status}`,
      ),
    );
    await foreignOrigin();

    if (!input.publishableKey) {
      await recovery(tenantA);
      results.push(
        ...blockedCases(KEY_IDS, `secret_unreadable:${PUBLISHABLE_KEY_NAME}`),
      );
    } else {
      await runWithKey();
    }
    await runManagement();
    await runDirectDatabase();
  } catch (error) {
    results.push(
      acceptanceCase(
        "runner.exception",
        "fail",
        error instanceof Error ? error.name : "Error",
      ),
    );
  } finally {
    await cleanup();
  }

  for (const gap of REAL_CLIENT_GAPS) {
    if (!results.some((row) => row.id === gap.id)) results.push(gap);
  }
  results.push(
    acceptanceCase(
      "recovery.completion",
      "gap",
      "inbox_unavailable: recovery completion needs the allowlisted message. This workflow does not read mail or call the admin API.",
    ),
  );
  for (const id of [
    "health",
    "auth.protected_resource",
    "auth.oauth_server_enabled",
    "auth.dynamic_registration",
    "auth.authorization_path",
    "auth.site_url",
    "auth.redirect_allow_list",
    "auth.secure_password_change",
    "auth.exposed_schemas",
    "direct.runtime_cannot_read",
    "direct.tenant_isolation",
    "direct.cleanup",
    "cleanup.tenant_a",
    "cleanup.tenant_b",
    "cleanup.generic_client",
    "recovery.completion",
    "recovery.allowlisted",
    "login.foreign_origin",
    ...KEY_IDS,
    ...REAL_CLIENT_GAPS.map((row) => row.id),
  ]) {
    if (!results.some((row) => row.id === id)) {
      results.push(acceptanceCase(id, "fail", "not_executed"));
    }
  }

  return {
    environment: "development",
    source: input.commit,
    deployedCommit,
    schema: input.schema,
    results,
  };

  async function runManagement(): Promise<void> {
    if (!input.managementToken) {
      results.push(
        ...blockedCases(
          [
            "auth.oauth_server_enabled",
            "auth.dynamic_registration",
            "auth.authorization_path",
            "auth.site_url",
            "auth.redirect_allow_list",
            "auth.secure_password_change",
            "auth.exposed_schemas",
          ],
          secretName(MANAGEMENT_TOKEN_SECRET),
        ),
      );
      return;
    }
    const authReply = await request(
      `https://api.supabase.com/v1/projects/${target.ref}/config/auth`,
      { headers: { authorization: `Bearer ${input.managementToken}` } },
    );
    if (authReply.status !== 200) {
      results.push(
        ...blockedCases(
          [
            "auth.oauth_server_enabled",
            "auth.dynamic_registration",
            "auth.authorization_path",
            "auth.site_url",
            "auth.redirect_allow_list",
            "auth.secure_password_change",
          ],
          `management_auth=http_${authReply.status}`,
        ),
      );
    } else {
      results.push(
        ...classifyAuthSettings(authSnapshot(json(authReply)), target.site),
      );
    }
    const restReply = await request(
      `https://api.supabase.com/v1/projects/${target.ref}/postgrest`,
      { headers: { authorization: `Bearer ${input.managementToken}` } },
    );
    if (restReply.status !== 200) {
      results.push(
        acceptanceCase(
          "auth.exposed_schemas",
          "fail",
          `management_postgrest=http_${restReply.status}`,
        ),
      );
      return;
    }
    const schema = (json(restReply) as { db_schema?: unknown } | undefined)
      ?.db_schema;
    results.push(
      classifyExposedSchemas(typeof schema === "string" ? schema : ""),
    );
  }

  async function runWithKey(): Promise<void> {
    const key = input.publishableKey ?? "";
    const settingsReply = await request(
      `${target.supabaseUrl}/auth/v1/settings`,
      {
        headers: { apikey: key },
      },
    );
    const settings = json(settingsReply) as {
      mailer_autoconfirm?: unknown;
      disable_signup?: unknown;
    };
    const metadataReply = await request(
      `${target.supabaseUrl}/auth/v1/.well-known/oauth-authorization-server`,
      { headers: { apikey: key, accept: "application/json" } },
    );
    const metadata = json(metadataReply) as {
      authorization_endpoint?: unknown;
      token_endpoint?: unknown;
      registration_endpoint?: unknown;
    };
    const metadataPass =
      metadataReply.status === 200 &&
      sameOrigin(metadata.authorization_endpoint, target.supabaseUrl) &&
      sameOrigin(metadata.token_endpoint, target.supabaseUrl) &&
      sameOrigin(metadata.registration_endpoint, target.supabaseUrl);
    results.push(
      acceptanceCase(
        "auth.oauth_metadata",
        metadataPass ? "pass" : "fail",
        metadataPass ? "present" : `http_${metadataReply.status}`,
      ),
    );

    const openApi = await request(`${target.supabaseUrl}/rest/v1/`, {
      headers: {
        apikey: key,
        authorization: `Bearer ${key}`,
        accept: "application/openapi+json",
      },
    });
    const openApiBody = json(openApi);
    results.push(
      acceptanceCase(
        "data_api.openapi",
        openApi.status === 200 && !openApiExposesApp(openApiBody)
          ? "pass"
          : "fail",
        openApi.status === 200 && !openApiExposesApp(openApiBody)
          ? "app_absent"
          : `http_${openApi.status}`,
      ),
    );
    const anonRead = await request(`${target.supabaseUrl}/rest/v1/businesses`, {
      headers: { apikey: key, authorization: `Bearer ${key}` },
    });
    results.push(
      acceptanceCase(
        "data_api.anon_businesses",
        dataApiDenied(anonRead.status, json(anonRead)) ? "pass" : "fail",
        `http_${anonRead.status}`,
      ),
    );

    if (settings?.disable_signup === true) {
      results.push(
        ...blockedCases(
          ["signup.tenant_a", "signup.tenant_b"],
          "signup_disabled",
        ),
      );
      results.push(...blockedCases(SESSION_IDS, "signup_disabled"));
      await recovery(tenantA);
      return;
    }

    for (const tenant of tenants) {
      const created = await request(`${target.supabaseUrl}/auth/v1/signup`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          email: tenant.email,
          password: tenant.password,
        }),
      });
      const body = json(created) as {
        access_token?: unknown;
        refresh_token?: unknown;
        user?: { id?: unknown };
        id?: unknown;
      };
      const userId =
        typeof body?.user?.id === "string"
          ? body.user.id
          : typeof body?.id === "string"
            ? body.id
            : null;
      tenant.userId = userId;
      tenant.accessToken =
        typeof body?.access_token === "string" ? body.access_token : null;
      tenant.refreshToken =
        typeof body?.refresh_token === "string" ? body.refresh_token : null;
      const confirmed = created.status < 300 && Boolean(tenant.accessToken);
      results.push(
        acceptanceCase(
          `signup.${tenant.label.replace("tenant-", "tenant_")}`,
          confirmed ? "pass" : "fail",
          confirmed
            ? "session_issued"
            : settings?.mailer_autoconfirm === false
              ? "blocked:mailer_autoconfirm_false"
              : `http_${created.status}`,
        ),
      );
    }

    if (tenants.some((tenant) => !tenant.accessToken)) {
      const reason =
        settings?.mailer_autoconfirm === false
          ? "mailer_autoconfirm_false"
          : "signup_session_absent";
      results.push(...blockedCases(SESSION_IDS, reason));
      await recovery(tenantA);
      return;
    }

    for (const tenant of tenants) {
      await login(tenant);
    }
    await recovery(tenantA);
    await refreshUi(tenantA);
    for (const tenant of tenants) await createOwnBusiness(tenant);
    await negativeUi(tenantA, tenantB);
    await negativeUi(tenantB, tenantA);
    await authenticatedDataApi(tenantA);

    if (!metadataPass) {
      results.push(...blockedCases(GENERIC_IDS, "oauth_metadata"));
      return;
    }
    registration = await register(
      metadata.registration_endpoint as string,
      "tutor-mbos-generic-acceptance",
    );
    if (!registration) {
      results.push(...blockedCases(GENERIC_IDS, "dynamic_registration"));
      return;
    }
    const approvedA = await consent(
      tenantA,
      registration,
      metadata.authorization_endpoint as string,
      metadata.token_endpoint as string,
      "approve",
    );
    results.push(
      acceptanceCase(
        "generic_client.consent",
        approvedA ? "pass" : "fail",
        approvedA ? "approved" : "not_approved",
      ),
    );
    if (!approvedA || !tenantA.delegatedToken) {
      results.push(
        ...blockedCases(
          GENERIC_IDS.filter((id) => id !== "generic_client.consent"),
          "consent",
        ),
      );
      return;
    }
    results.push(
      classifyIssuedAudience(
        jwtAudience(tenantA.delegatedToken),
        resourceUrl(target.site),
      ),
    );
    await delegatedChecks(tenantA, tenantB, "generic_client");
    const approvedB = await consent(
      tenantB,
      registration,
      metadata.authorization_endpoint as string,
      metadata.token_endpoint as string,
      "approve",
    );
    if (!approvedB || !tenantB.delegatedToken) {
      results.push(
        ...blockedCases(
          [
            "generic_client.tenant_b_positive",
            "generic_client.tenant_b_negative",
          ],
          "consent",
        ),
      );
    } else {
      await delegatedChecks(tenantB, tenantA, "generic_client.tenant_b");
    }
    await revokeAndReconnect(
      tenantA,
      registration,
      metadata.authorization_endpoint as string,
      metadata.token_endpoint as string,
    );
    denialRegistration = await register(
      metadata.registration_endpoint as string,
      "tutor-mbos-generic-denial",
    );
    const denied = denialRegistration
      ? await consent(
          tenantA,
          denialRegistration,
          metadata.authorization_endpoint as string,
          metadata.token_endpoint as string,
          "deny",
        )
      : false;
    results.push(
      acceptanceCase(
        "generic_client.denial",
        denied ? "pass" : "fail",
        denied ? "denied" : "not_denied",
      ),
    );
  }

  async function foreignOrigin(): Promise<void> {
    const reply = await request(`${target.site}/api/auth/login`, {
      method: "POST",
      headers: {
        origin: "https://example.com",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        email: tenantA.email,
        password: tenantA.password,
      }).toString(),
    });
    results.push(
      acceptanceCase(
        "login.foreign_origin",
        reply.status === 403 ? "pass" : "fail",
        `http_${reply.status}`,
      ),
    );
  }

  async function login(tenant: Tenant): Promise<void> {
    const reply = await request(`${target.site}/api/auth/login`, {
      method: "POST",
      headers: {
        origin: target.site,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        email: tenant.email,
        password: tenant.password,
        next: "/business",
      }).toString(),
    });
    rememberCookies(tenant, reply.headers);
    const location = reply.headers.get("location") ?? "";
    const pass =
      reply.status === 303 &&
      location.startsWith(`${target.site}/business`) &&
      tenant.jar.size > 0;
    results.push(
      acceptanceCase(
        `login.${tenant.label.replace("tenant-", "tenant_")}`,
        pass ? "pass" : "fail",
        pass ? "cookie_session" : `http_${reply.status}`,
      ),
    );
  }

  async function recovery(tenant: Tenant): Promise<void> {
    const reply = await request(`${target.site}/api/auth/recover`, {
      method: "POST",
      headers: {
        origin: target.site,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        email: tenant.email,
        redirect: "https://example.com/phish",
      }).toString(),
    });
    const location = reply.headers.get("location") ?? "";
    const pass =
      reply.status === 303 &&
      location === `${target.site}/login?recovery=sent` &&
      !location.includes("example.com");
    if (!results.some((row) => row.id === "recovery.allowlisted")) {
      results.push(
        acceptanceCase(
          "recovery.allowlisted",
          pass ? "pass" : "fail",
          pass ? "allowlisted_redirect" : `http_${reply.status}`,
        ),
      );
    }
  }

  async function refreshUi(tenant: Tenant): Promise<void> {
    const reply = await request(
      `${target.supabaseUrl}/auth/v1/token?grant_type=refresh_token`,
      {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ refresh_token: tenant.refreshToken }),
      },
    );
    const body = json(reply) as {
      access_token?: unknown;
      refresh_token?: unknown;
    };
    const rotated =
      reply.status === 200 && typeof body?.access_token === "string";
    if (rotated) {
      tenant.accessToken = body.access_token as string;
      if (typeof body.refresh_token === "string") {
        tenant.refreshToken = body.refresh_token;
      }
    }
    results.push(
      acceptanceCase(
        "refresh.platform",
        rotated ? "pass" : "fail",
        rotated ? "session_refreshed" : `http_${reply.status}`,
      ),
    );
    const session = await request(`${target.site}/api/v1/session`, {
      headers: {
        cookie: cookieHeader(tenant),
        origin: target.site,
        accept: "application/json",
      },
    });
    rememberCookies(tenant, session.headers);
    const sessionBody = json(session) as { path?: unknown };
    results.push(
      acceptanceCase(
        "refresh.ui_session",
        session.status === 200 && sessionBody?.path === "ui-session"
          ? "pass"
          : "fail",
        `http_${session.status}`,
      ),
    );
    const rotatedCookie = session.headers.getSetCookie?.().length ?? 0;
    results.push(
      acceptanceCase(
        "refresh.ui_rotation",
        rotatedCookie > 0 ? "pass" : "gap",
        rotatedCookie > 0
          ? "cookie_rotated"
          : "outside_refresh_window: route handlers rotate only inside 90 seconds of expiry",
      ),
    );
  }

  async function createOwnBusiness(tenant: Tenant): Promise<void> {
    const reply = await request(`${target.site}/api/v1/business`, {
      method: "POST",
      headers: {
        cookie: cookieHeader(tenant),
        origin: target.site,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        displayName:
          tenant.label === "tenant-a" ? "Synthetic A" : "Synthetic B",
        idempotencyKey: `tos3-${tenant.label}-${nonce}`,
      }),
    });
    const createdId = businessId(json(reply));
    tenant.businessId = createdId;
    const read = await request(`${target.site}/api/v1/business`, {
      headers: {
        cookie: cookieHeader(tenant),
        origin: target.site,
        accept: "application/json",
      },
    });
    const readId = businessId(json(read));
    const pass =
      (reply.status === 201 || reply.status === 200) &&
      createdId !== null &&
      read.status === 200 &&
      readId === createdId;
    results.push(
      acceptanceCase(
        `ui.${tenant.label.replace("tenant-", "tenant_")}_positive`,
        pass ? "pass" : "fail",
        pass ? "own_business" : `http_${reply.status}`,
      ),
    );
  }

  async function negativeUi(actor: Tenant, other: Tenant): Promise<void> {
    const otherId = other.businessId ?? "00000000-0000-4000-8000-000000000000";
    const read = await request(
      `${target.site}/api/v1/business?tenantId=${encodeURIComponent(otherId)}`,
      {
        headers: {
          cookie: cookieHeader(actor),
          origin: target.site,
          "x-tenant-id": otherId,
          accept: "application/json",
        },
      },
    );
    const readId = businessId(json(read));
    const write = await request(`${target.site}/api/v1/business`, {
      method: "POST",
      headers: {
        cookie: cookieHeader(actor),
        origin: target.site,
        "content-type": "application/json",
        "x-tenant-id": otherId,
      },
      body: JSON.stringify({
        displayName: "Taken over",
        idempotencyKey: `tos3-${actor.label}-bypass-${nonce}`,
        tenantId: otherId,
        businessId: otherId,
        ownerUserId: other.userId,
      }),
    });
    const writeId = businessId(json(write));
    const pass =
      read.status === 200 &&
      readId === actor.businessId &&
      readId !== other.businessId &&
      writeId === actor.businessId;
    results.push(
      acceptanceCase(
        `ui.${actor.label.replace("tenant-", "tenant_")}_negative`,
        pass ? "pass" : "fail",
        pass ? "forged_tenant_ignored" : `http_${read.status}`,
      ),
    );
  }

  async function authenticatedDataApi(tenant: Tenant): Promise<void> {
    const key = input.publishableKey ?? "";
    const profile = await request(`${target.supabaseUrl}/rest/v1/businesses`, {
      headers: {
        apikey: key,
        authorization: `Bearer ${tenant.accessToken}`,
        "accept-profile": "app",
      },
    });
    results.push(
      acceptanceCase(
        "data_api.app_profile",
        dataApiDenied(profile.status, json(profile)) ? "pass" : "fail",
        `http_${profile.status}`,
      ),
    );
    const plain = await request(`${target.supabaseUrl}/rest/v1/businesses`, {
      headers: {
        apikey: key,
        authorization: `Bearer ${tenant.accessToken}`,
      },
    });
    results.push(
      acceptanceCase(
        "data_api.authenticated_businesses",
        dataApiDenied(plain.status, json(plain)) ? "pass" : "fail",
        `http_${plain.status}`,
      ),
    );
  }

  async function register(
    endpoint: string,
    name: string,
  ): Promise<RegisteredClient | null> {
    const reply = await request(endpoint, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        client_name: name,
        redirect_uris: [GENERIC_REDIRECT],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    });
    const body = json(reply) as {
      client_id?: unknown;
      client_secret?: unknown;
      registration_client_uri?: unknown;
      registration_access_token?: unknown;
    };
    if (reply.status >= 300 || typeof body?.client_id !== "string") return null;
    return {
      clientId: body.client_id,
      clientSecret:
        typeof body.client_secret === "string" ? body.client_secret : null,
      registrationUri:
        typeof body.registration_client_uri === "string"
          ? body.registration_client_uri
          : null,
      registrationToken:
        typeof body.registration_access_token === "string"
          ? body.registration_access_token
          : null,
    };
  }

  async function consent(
    tenant: Tenant,
    client: RegisteredClient,
    authorizationEndpoint: string,
    tokenEndpoint: string,
    decision: "approve" | "deny",
  ): Promise<boolean> {
    const verifier = rng(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authorize = new URL(authorizationEndpoint);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("client_id", client.clientId);
    authorize.searchParams.set("redirect_uri", GENERIC_REDIRECT);
    authorize.searchParams.set("code_challenge", challenge);
    authorize.searchParams.set("code_challenge_method", "S256");
    authorize.searchParams.set("state", rng(16).toString("hex"));
    authorize.searchParams.set("scope", "openid email profile");
    authorize.searchParams.set("resource", resourceUrl(target.site));
    const started = await request(authorize.toString());
    const authorizationId = queryValue(
      started.headers.get("location"),
      "authorization_id",
    );
    const consentUrl = started.headers.get("location") ?? "";
    let onConsent = false;
    try {
      const parsed = new URL(consentUrl);
      onConsent =
        parsed.origin === target.site &&
        parsed.pathname === EXPECTED_AUTHORIZATION_PATH;
    } catch {
      onConsent = false;
    }
    if (!authorizationId || !onConsent) return false;
    const form = new URLSearchParams();
    form.set("authorization_id", authorizationId);
    form.set("decision", decision);
    if (decision === "approve") {
      form.append("permissions", "business.read");
      form.append("permissions", "reports.read");
      form.append("permissions", "business.onboard");
    }
    const decided = await request(`${target.site}/api/oauth/decision`, {
      method: "POST",
      headers: {
        cookie: cookieHeader(tenant),
        origin: target.site,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    });
    if (decided.status !== 303) return false;
    if (decision === "deny") return true;
    const code = queryValue(decided.headers.get("location"), "code");
    if (!code) return false;
    const tokenBody = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: GENERIC_REDIRECT,
      client_id: client.clientId,
      code_verifier: verifier,
    });
    if (client.clientSecret)
      tokenBody.set("client_secret", client.clientSecret);
    const token = await request(tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: tokenBody.toString(),
    });
    const issued = json(token) as {
      access_token?: unknown;
      refresh_token?: unknown;
    };
    if (token.status !== 200 || typeof issued?.access_token !== "string") {
      return false;
    }
    tenant.delegatedToken = issued.access_token;
    if (typeof issued.refresh_token === "string" && decision === "approve") {
      const refreshed = await request(tokenEndpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: issued.refresh_token,
          client_id: client.clientId,
          ...(client.clientSecret
            ? { client_secret: client.clientSecret }
            : {}),
        }).toString(),
      });
      const next = json(refreshed) as { access_token?: unknown };
      const pass =
        refreshed.status === 200 && typeof next?.access_token === "string";
      if (pass) tenant.delegatedToken = next.access_token as string;
      if (!results.some((row) => row.id === "generic_client.refresh")) {
        results.push(
          acceptanceCase(
            "generic_client.refresh",
            pass ? "pass" : "fail",
            pass ? "delegated_refreshed" : `http_${refreshed.status}`,
          ),
        );
      }
    } else if (!results.some((row) => row.id === "generic_client.refresh")) {
      results.push(
        acceptanceCase(
          "generic_client.refresh",
          "fail",
          "refresh_token_absent",
        ),
      );
    }
    return true;
  }

  async function delegatedChecks(
    actor: Tenant,
    other: Tenant,
    prefix: "generic_client" | "generic_client.tenant_b",
  ): Promise<void> {
    const positiveId =
      prefix === "generic_client"
        ? "generic_client.api_positive"
        : "generic_client.tenant_b_positive";
    const negativeId =
      prefix === "generic_client"
        ? "generic_client.api_negative"
        : "generic_client.tenant_b_negative";
    const own = await bearerBusiness(actor, null);
    results.push(
      acceptanceCase(
        positiveId,
        own.status === 200 && own.id === actor.businessId ? "pass" : "fail",
        own.status === 200 && own.id === actor.businessId
          ? "own_business"
          : `http_${own.status}`,
      ),
    );
    const forged = await bearerBusiness(actor, other.businessId);
    results.push(
      acceptanceCase(
        negativeId,
        forged.status === 200 &&
          forged.id === actor.businessId &&
          forged.id !== other.businessId
          ? "pass"
          : "fail",
        forged.id === other.businessId
          ? "other_tenant_visible"
          : `http_${forged.status}`,
      ),
    );
    if (prefix !== "generic_client") return;
    const missing = await request(`${target.site}/api/v1/business`, {
      headers: { accept: "application/json" },
    });
    results.push(
      acceptanceCase(
        "generic_client.api_no_bearer",
        missing.status === 401 ? "pass" : "fail",
        `http_${missing.status}`,
      ),
    );
    const upgraded = await request(`${target.site}/api/v1/business`, {
      headers: {
        authorization: `Bearer ${actor.accessToken}`,
        cookie: cookieHeader(actor),
        accept: "application/json",
      },
    });
    results.push(
      acceptanceCase(
        "generic_client.api_ui_token_as_bearer",
        upgraded.status === 401 ? "pass" : "fail",
        `http_${upgraded.status}`,
      ),
    );
    const mcpOwn = await mcpCreate(actor, actor.businessId);
    results.push(
      acceptanceCase(
        "generic_client.mcp_positive",
        mcpOwn.status === 200 && mcpOwn.id === actor.businessId
          ? "pass"
          : "fail",
        mcpOwn.id === actor.businessId
          ? "own_business"
          : `http_${mcpOwn.status}`,
      ),
    );
    const mcpForged = await mcpCreate(actor, other.businessId);
    results.push(
      acceptanceCase(
        "generic_client.mcp_negative",
        mcpForged.id === actor.businessId && mcpForged.id !== other.businessId
          ? "pass"
          : "fail",
        mcpForged.id === other.businessId
          ? "other_tenant_visible"
          : `http_${mcpForged.status}`,
      ),
    );
  }

  async function bearerBusiness(
    tenant: Tenant,
    forgedId: string | null,
  ): Promise<{ status: number; id: string | null }> {
    const url = forgedId
      ? `${target.site}/api/v1/business?tenantId=${encodeURIComponent(forgedId)}`
      : `${target.site}/api/v1/business`;
    const reply = await request(url, {
      headers: {
        authorization: `Bearer ${tenant.delegatedToken}`,
        ...(forgedId ? { "x-tenant-id": forgedId } : {}),
        accept: "application/json",
      },
    });
    return { status: reply.status, id: businessId(json(reply)) };
  }

  async function mcpCreate(
    tenant: Tenant,
    forgedId: string | null,
  ): Promise<{ status: number; id: string | null }> {
    const reply = await request(`${target.site}/api/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${tenant.delegatedToken}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "create_business",
          arguments: {
            displayName: "Synthetic delegated",
            idempotencyKey: `tos3-mcp-${tenant.label}-${nonce}`,
            ...(forgedId ? { tenantId: forgedId } : {}),
          },
        },
      }),
    });
    const text = (
      json(reply) as {
        result?: { content?: { text?: string }[]; isError?: boolean };
      }
    )?.result;
    let id: string | null = null;
    try {
      id = businessId(JSON.parse(text?.content?.[0]?.text ?? ""));
    } catch {
      id = null;
    }
    return { status: reply.status, id: text?.isError ? null : id };
  }

  async function revokeAndReconnect(
    tenant: Tenant,
    client: RegisteredClient,
    authorizationEndpoint: string,
    tokenEndpoint: string,
  ): Promise<void> {
    const revoked = await request(`${target.site}/api/v1/grants/revoke`, {
      method: "POST",
      headers: {
        cookie: cookieHeader(tenant),
        origin: target.site,
        "content-type": "application/json",
      },
      body: JSON.stringify({ clientId: client.clientId }),
    });
    const after = await bearerBusiness(tenant, null);
    const revokedPass = revoked.status === 200 && after.status === 403;
    results.push(
      acceptanceCase(
        "generic_client.revocation",
        revokedPass ? "pass" : "fail",
        revokedPass ? "next_request_denied" : `http_${revoked.status}`,
      ),
    );
    const mixed = await request(`${target.site}/api/v1/business`, {
      headers: {
        authorization: `Bearer ${tenant.delegatedToken}`,
        cookie: cookieHeader(tenant),
        origin: target.site,
        accept: "application/json",
      },
    });
    results.push(
      acceptanceCase(
        "generic_client.bearer_not_upgraded",
        mixed.status === 403 || mixed.status === 401 ? "pass" : "fail",
        `http_${mixed.status}`,
      ),
    );
    const again = await consent(
      tenant,
      client,
      authorizationEndpoint,
      tokenEndpoint,
      "approve",
    );
    const reread = again ? await bearerBusiness(tenant, null) : null;
    results.push(
      acceptanceCase(
        "generic_client.reconnection",
        reread?.status === 200 && reread.id === tenant.businessId
          ? "pass"
          : "fail",
        reread?.status === 200 ? "grant_restored" : "not_restored",
      ),
    );
  }

  async function runDirectDatabase(): Promise<void> {
    const ids = [
      "direct.runtime_cannot_read",
      "direct.tenant_isolation",
      "direct.cleanup",
    ];
    if (!input.appDatabaseUrl) {
      results.push(...blockedCases(ids, secretName(APP_DATABASE_URL_SECRET)));
      return;
    }
    const inspected = inspectAppDatabaseUrl(
      input.appDatabaseUrl,
      "development",
    );
    if (!inspected.ok) {
      results.push(...blockedCases(ids, `app_database_url=${inspected.code}`));
      return;
    }
    if (!tenantA.userId || !tenantA.businessId || !tenantB.businessId) {
      results.push(...blockedCases(ids, "synthetic_business_absent"));
      return;
    }
    try {
      const probe = input.probeDatabase
        ? await input.probeDatabase(input.appDatabaseUrl, {
            userId: tenantA.userId,
            ownBusinessId: tenantA.businessId,
            otherBusinessId: tenantB.businessId,
          })
        : await probeWithPg();
      results.push(...classifyDirectProbe(probe));
    } catch (error) {
      results.push(
        ...blockedCases(ids, error instanceof Error ? error.name : "Error"),
      );
    }
  }

  async function probeWithPg(): Promise<DirectProbe> {
    const connection = pgConnection(input.appDatabaseUrl ?? "");
    try {
      return await probeDirectTenantAccess(connection, {
        userId: tenantA.userId ?? "",
        ownBusinessId: tenantA.businessId ?? "",
        otherBusinessId: tenantB.businessId ?? "",
      });
    } finally {
      await connection.close();
    }
  }

  async function cleanup(): Promise<void> {
    for (const tenant of tenants) {
      const id = `cleanup.${tenant.label.replace("tenant-", "tenant_")}`;
      if (!tenant.accessToken || !input.publishableKey) {
        results.push(acceptanceCase(id, "fail", "session_absent"));
        continue;
      }
      try {
        const reply = await request(`${target.supabaseUrl}/auth/v1/user`, {
          method: "DELETE",
          headers: {
            apikey: input.publishableKey,
            authorization: `Bearer ${tenant.accessToken}`,
          },
        });
        results.push(
          acceptanceCase(
            id,
            reply.status === 200 || reply.status === 204 ? "pass" : "fail",
            `http_${reply.status}`,
          ),
        );
      } catch (error) {
        results.push(
          acceptanceCase(
            id,
            "fail",
            error instanceof Error ? error.name : "Error",
          ),
        );
      }
    }
    const clients = [registration, denialRegistration].filter(
      (client): client is RegisteredClient => client !== null,
    );
    if (clients.length === 0) {
      results.push(
        acceptanceCase("cleanup.generic_client", "fail", "client_absent"),
      );
      return;
    }
    let removed = true;
    for (const client of clients) {
      if (!client.registrationUri || !client.registrationToken) {
        removed = false;
        continue;
      }
      try {
        const reply = await request(client.registrationUri, {
          method: "DELETE",
          headers: { authorization: `Bearer ${client.registrationToken}` },
        });
        if (reply.status !== 204 && reply.status !== 200) removed = false;
      } catch {
        removed = false;
      }
    }
    results.push(
      acceptanceCase(
        "cleanup.generic_client",
        removed ? "pass" : "fail",
        removed ? "registration_removed" : "registration_remains",
      ),
    );
  }
}

const GENERIC_IDS = [
  "generic_client.consent",
  "generic_client.audience",
  "generic_client.api_positive",
  "generic_client.api_negative",
  "generic_client.api_no_bearer",
  "generic_client.api_ui_token_as_bearer",
  "generic_client.mcp_positive",
  "generic_client.mcp_negative",
  "generic_client.tenant_b_positive",
  "generic_client.tenant_b_negative",
  "generic_client.revocation",
  "generic_client.reconnection",
  "generic_client.denial",
  "generic_client.bearer_not_upgraded",
  "generic_client.refresh",
] as const;

function secretName(name: string): string {
  return `secret_absent:${name}`;
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

function sameOrigin(value: unknown, supabaseUrl: string): boolean {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).origin === new URL(supabaseUrl).origin;
  } catch {
    return false;
  }
}

function queryValue(location: string | null, name: string): string | null {
  if (!location) return null;
  try {
    return new URL(location).searchParams.get(name);
  } catch {
    return null;
  }
}

function businessId(body: unknown): string | null {
  const id = (body as { business?: { id?: unknown } } | null)?.business?.id;
  return typeof id === "string" ? id : null;
}

function requiredTenant(tenant: Tenant | undefined): Tenant {
  if (!tenant) throw new Error("tenants");
  return tenant;
}

function syntheticPassword(bytes: Buffer): string {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let password = "Aa1";
  for (const byte of bytes) password += alphabet[byte % alphabet.length];
  return password.slice(0, 24);
}

function mask(value: string | null | undefined): void {
  if (value && process.env.GITHUB_ACTIONS === "true") {
    console.log(`::add-mask::${value}`);
  }
}

async function main(): Promise<number> {
  const guard = acceptanceGuard(process.env);
  if (guard) {
    console.error(`::error::${guard}`);
    return 2;
  }
  const envFile = ".vercel/.env.production.local";
  const pulled = existsSync(envFile)
    ? parseDotenv(readFileSync(envFile, "utf8"))
    : {};
  const material = resolveAcceptanceMaterial(process.env, pulled);
  mask(material.publishableKey);
  mask(material.managementToken);
  mask(material.appDatabaseUrl);
  const bypass = await resolveProtectionBypass(process.env);
  mask(bypass.value);
  console.log(`Deployment protection bypass: ${bypass.source}.`);
  const report = await runHostedAcceptance({
    commit: process.env.GITHUB_SHA ?? "",
    ...material,
    bypass: bypass.value ?? null,
    schema: reviewedSchema(),
  });
  console.log(formatAcceptanceReport(report));
  return acceptanceTally(report.results).exitCode;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = await main();
}
