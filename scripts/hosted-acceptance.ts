/**
 * Development-only hosted acceptance. Secretless CI tests the classifiers
 * and this sequence with a fake transport. The protected workflow is the
 * only caller that sets TUTOR_MBOS_ACCEPTANCE=development, and it is not
 * executed from a coding workspace.
 */
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolveProtectionBypass } from "./smoke-health.ts";
import {
  CLEANUP_CLIENT_LABELS,
  expectedCleanupEmail,
  expectedClientName,
  reviewCleanupManifest,
  writeManifestOutput,
  type CleanupClientLabel,
  type CleanupIdentity,
  type CleanupManifest,
} from "../src/server/application/acceptance-cleanup.ts";
import {
  readCheckpoint,
  readMailResult,
  writeCheckpoint,
  writeRecoveryWindow,
  type AcceptanceCheckpoint,
  type AcceptanceStage,
} from "../src/server/application/acceptance-checkpoint.ts";
import {
  RECEIVING_API_KEY_SECRET,
  authStorageKey,
  pkceVerifierCookie,
  readSessionTokens,
} from "../src/server/application/acceptance-mail.ts";
import {
  APP_DATABASE_URL_SECRET,
  EXPECTED_AUTHORIZATION_PATH,
  MANAGEMENT_CASE_IDS,
  MANAGEMENT_TOKEN_SECRET,
  PUBLISHABLE_KEY_NAME,
  REAL_CLIENT_GAPS,
  acceptanceCase,
  blockedCases,
  classifyAuthSettings,
  classifyDirectProbes,
  classifyExposedSchemas,
  classifyOpenApiDocument,
  acceptanceTally,
  classifyIssuedAudience,
  dataApiDenied,
  decodePreflightCases,
  formatAcceptanceReport,
  jwtAudience,
  probeDirectTenants,
  secretAbsent,
  schemaIdentity,
  type AcceptanceCase,
  type AcceptanceReport,
  type AuthConfigSnapshot,
  type DirectProbe,
  type DirectProbeInput,
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
const APPROVE_PERMISSIONS = [
  "business.read",
  "reports.read",
  "business.onboard",
] as const;
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
  "ui.tenant_a_page",
  "ui.tenant_b_page",
  "ui.consent_page",
  "data_api.app_profile",
  "generic_client.consent",
  "generic_client.audience",
  "generic_client.api_positive",
  "generic_client.api_negative",
  "generic_client.api_no_bearer",
  "generic_client.api_ui_token_as_bearer",
  "generic_client.mcp_positive",
  "generic_client.mcp_negative",
  "generic_client.setup_report",
  "generic_client.setup_status",
  "generic_client.tenant_b_positive",
  "generic_client.tenant_b_negative",
  "generic_client.tenant_b_api_no_bearer",
  "generic_client.tenant_b_api_ui_token_as_bearer",
  "generic_client.tenant_b_mcp_positive",
  "generic_client.tenant_b_mcp_negative",
  "generic_client.tenant_b_setup_report",
  "generic_client.tenant_b_setup_status",
  "generic_client.restricted_business",
  "generic_client.restricted_report",
  "generic_client.restricted_setup_status",
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

export type HostedPhase = "all" | "signup" | "continue" | "finish";

export interface HostedAcceptanceInput {
  commit: string;
  publishableKey: string | null;
  managementToken: string | null;
  appDatabaseUrl: string | null;
  bypass?: string | null;
  fetchImpl?: typeof fetch;
  randomBytes?: (size: number) => Buffer;
  runId: string;
  runAttempt: string;
  runNonce: string;
  startedAt: string;
  preflightCases?: AcceptanceCase[] | null;
  requestTimeoutMs?: number;
  phase?: HostedPhase;
  mailMode?: "required";
  stateDir?: string;
  writePhaseOutput?: (name: string, value: string) => void;
  writeManifest?: (body: string) => void;
  probeDatabase?: (
    url: string,
    input: DirectProbeInput,
  ) => Promise<DirectProbe>;
  schema: string;
}

interface RegisteredClient {
  label: CleanupClientLabel;
  clientId: string;
  clientSecret: string | null;
}

interface ConsentOptions {
  permissions?: readonly string[];
  remember?: boolean;
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
  responseLost: boolean;
  confirmed: boolean;
  verifier: string;
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

function commitEvidence(
  actual: string,
  expected: string,
): "absent" | "match" | "mismatch" {
  if (actual.length === 0) return "absent";
  if (actual === expected) return "match";
  return "mismatch";
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
  const nonce = input.runNonce;
  let deployedCommit = "";
  let closingCommit = "";
  let openingOk = false;
  let closingChecked = false;
  const phase = input.phase ?? "all";
  const mailRequired = input.mailMode === "required" || phase !== "all";
  const stateDir = input.stateDir;
  const restored =
    phase === "continue" || phase === "finish"
      ? stateDir
        ? readCheckpoint(stateDir, nonce)
        : null
      : null;
  let phasePaused = false;
  let metadataPass = false;
  let authorizationEndpoint: string | null = null;
  let tokenEndpoint: string | null = null;
  let registrationEndpoint: string | null = null;
  let mailerAutoconfirmFalse = false;
  let recoveryRequestedAt: string | null = null;
  const recoveryJar = new Map<string, string>();
  const tenants: Tenant[] = (["tenant-a", "tenant-b"] as const).map((label) => {
    const verifier = rng(32).toString("base64url");
    return {
      label,
      email: expectedCleanupEmail(label, nonce),
      password: syntheticPassword(rng(24)),
      userId: null,
      accessToken: null,
      refreshToken: null,
      businessId: null,
      delegatedToken: null,
      responseLost: false,
      confirmed: false,
      verifier,
      jar: new Map<string, string>(),
    };
  });
  const tenantA = requiredTenant(tenants[0]);
  const tenantB = requiredTenant(tenants[1]);
  const registered: RegisteredClient[] = [];
  let registration: RegisteredClient | null = null;
  let denialRegistration: RegisteredClient | null = null;
  let restrictedRegistration: RegisteredClient | null = null;
  let manifestState: { ok: boolean; reason: string } = {
    ok: false,
    reason: "manifest_absent",
  };

  const request = async (
    url: string,
    init: RequestInit & { redirect?: RequestRedirect } = {},
  ): Promise<Reply> => {
    const headers = new Headers(init.headers);
    let onSite = false;
    try {
      onSite = new URL(url).origin === target.site;
    } catch {
      onSite = false;
    }
    if (onSite && input.bypass) {
      headers.set("x-vercel-protection-bypass", input.bypass);
    }
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      input.requestTimeoutMs ?? 15_000,
    );
    timer.unref?.();
    try {
      const response = await fetchImpl(url, {
        ...init,
        headers,
        redirect: "manual",
        signal: controller.signal,
      });
      return {
        status: response.status,
        headers: response.headers,
        text: await response.text(),
      };
    } catch (error) {
      if (controller.signal.aborted) throw new RequestTimeoutError();
      throw error;
    } finally {
      clearTimeout(timer);
    }
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

  const rememberCookiesOn = (jar: Map<string, string>, headers: Headers) => {
    const listed =
      typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];
    for (const line of listed) {
      const pair = line.split(";")[0] ?? "";
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1);
      if (value.length === 0 || /max-age=0/i.test(line)) jar.delete(name);
      else jar.set(name, value);
    }
  };

  const rememberCookies = (tenant: Tenant, headers: Headers) => {
    rememberCookiesOn(tenant.jar, headers);
  };

  const cookieHeader = (tenant: Tenant): string =>
    [...tenant.jar].map(([name, value]) => `${name}=${value}`).join("; ");

  if (restored) applyCheckpoint(restored);

  try {
    if (phase === "continue" || phase === "finish") {
      if (!restored) {
        results.push(
          acceptanceCase("runner.checkpoint", "fail", "checkpoint_absent"),
        );
      } else if (restored.stage === "blocked") {
        openingOk = false;
      } else if (phase === "finish" && restored.stage === "signed_up") {
        openingOk = true;
        results.push(
          acceptanceCase(
            "runner.checkpoint",
            "fail",
            "acceptance_stage_incomplete",
          ),
        );
      } else {
        openingOk = true;
        await resumeAcceptedWork(restored.stage);
      }
    } else {
      await openAndRun();
    }
  } catch (error) {
    results.push(
      acceptanceCase(
        "runner.exception",
        "fail",
        error instanceof Error ? error.name : "Error",
      ),
    );
  } finally {
    if (!phasePaused && openingOk && !closingChecked) {
      try {
        await closingHealth();
      } catch (error) {
        results.push(
          acceptanceCase(
            "health.closing",
            "fail",
            error instanceof Error ? error.name : "Error",
          ),
        );
      }
    }
    if (!phasePaused) publishManifest();
  }

  if (phasePaused) {
    return {
      environment: "development",
      source: input.commit,
      deployedCommit,
      closingCommit,
      schema: input.schema,
      results,
    };
  }

  results.push(
    acceptanceCase(
      "cleanup.manifest",
      manifestState.ok ? "pass" : "fail",
      manifestState.reason,
    ),
  );

  for (const gap of EVIDENCE_GAPS) {
    if (!results.some((row) => row.id === gap.id)) results.push(gap);
  }
  for (const id of [
    "health",
    "health.closing",
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
    "cleanup.manifest",
    "recovery.request_accepted",
    "recovery.email_callback",
    "recovery.completion",
    "ui.browser_interaction",
    "ui.login_page",
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
    closingCommit,
    schema: input.schema,
    results,
  };

  function applyCheckpoint(saved: AcceptanceCheckpoint): void {
    deployedCommit = saved.deployedCommit;
    results.push(...saved.results);
    mailerAutoconfirmFalse = saved.mailerAutoconfirmFalse;
    metadataPass = saved.metadataPass;
    authorizationEndpoint = saved.authorizationEndpoint;
    tokenEndpoint = saved.tokenEndpoint;
    registrationEndpoint = saved.registrationEndpoint;
    recoveryRequestedAt = saved.recoveryRequestedAt;
    recoveryJar.clear();
    for (const [name, value] of saved.recoveryJar) recoveryJar.set(name, value);
    for (const tenant of tenants) {
      const savedTenant = saved.tenants.find(
        (row) => row.label === tenant.label,
      );
      if (!savedTenant) continue;
      tenant.email = savedTenant.email;
      tenant.password = savedTenant.password;
      tenant.userId = savedTenant.userId;
      tenant.accessToken = savedTenant.accessToken;
      tenant.refreshToken = savedTenant.refreshToken;
      tenant.businessId = savedTenant.businessId;
      tenant.delegatedToken = savedTenant.delegatedToken;
      tenant.responseLost = savedTenant.responseLost;
      tenant.confirmed = savedTenant.confirmed;
      tenant.verifier = savedTenant.verifier;
      tenant.jar = new Map(savedTenant.jar);
    }
  }

  function pause(stage: AcceptanceStage): void {
    phasePaused = true;
    if (!stateDir) return;
    const checkpoint: AcceptanceCheckpoint = {
      version: 1,
      stage,
      deployedCommit,
      results: [...results],
      mailerAutoconfirmFalse,
      metadataPass,
      authorizationEndpoint,
      tokenEndpoint,
      registrationEndpoint,
      recoveryRequestedAt,
      recoveryJar: [...recoveryJar],
      tenants: tenants.map((tenant) => ({
        label: tenant.label,
        email: tenant.email,
        password: tenant.password,
        userId: tenant.userId,
        accessToken: tenant.accessToken,
        refreshToken: tenant.refreshToken,
        businessId: tenant.businessId,
        delegatedToken: tenant.delegatedToken,
        responseLost: tenant.responseLost,
        confirmed: tenant.confirmed,
        verifier: tenant.verifier,
        jar: [...tenant.jar],
      })),
    };
    writeCheckpoint(stateDir, checkpoint);
    if (stage === "recovery_requested" && recoveryRequestedAt) {
      writeRecoveryWindow(stateDir, recoveryRequestedAt);
    }
    if (stage === "signed_up") input.writePhaseOutput?.("continue", "true");
    if (stage === "blocked") input.writePhaseOutput?.("continue", "false");
  }

  async function openAndRun(): Promise<void> {
    const nonceReady = /^[a-f0-9]{32}$/.test(nonce);
    const attemptReady = /^[0-9]+$/.test(input.runAttempt);
    const startedReady = Number.isFinite(Date.parse(input.startedAt));
    const localDetail = !nonceReady
      ? "run_nonce_absent"
      : !attemptReady
        ? "run_attempt_absent"
        : !startedReady
          ? "started_at_absent"
          : "";
    if (!input.bypass) {
      openingOk = false;
      results.push(
        acceptanceCase(
          "health",
          "fail",
          localDetail || "protection_bypass_absent",
        ),
      );
    } else {
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
      openingOk = healthPass && nonceReady && attemptReady && startedReady;
      results.push(
        acceptanceCase(
          "health",
          openingOk ? "pass" : "fail",
          openingOk
            ? "development_commit_match"
            : localDetail ||
                `http_${health.status} commit=${commitEvidence(deployedCommit, input.commit)}`,
        ),
      );
    }
    if (!openingOk) {
      publishManifest();
      if (phase === "signup") pause("blocked");
      return;
    }
    await runMutableChecks();
  }

  async function resumeAcceptedWork(stage: AcceptanceStage): Promise<void> {
    if (phase === "continue") {
      await sessionGate();
      return;
    }
    if (stage === "recovery_requested") {
      await completeRecovery(tenantA);
      const sessionsBlocked = results.some(
        (row) =>
          row.id === "login.tenant_a" && row.detail.startsWith("blocked:"),
      );
      if (!sessionsBlocked) await finishAcceptedWork();
      await runManagement();
      await runDirectDatabase();
      await closingHealth();
    }
  }

  async function runMutableChecks(): Promise<void> {
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
    await loginPage();

    if (!input.publishableKey) {
      await recovery(tenantA);
      results.push(
        ...blockedCases(KEY_IDS, `secret_unreadable:${PUBLISHABLE_KEY_NAME}`),
      );
    } else {
      await runWithKey();
    }
    if (phasePaused) return;
    if (phase === "signup") {
      pause(openingOk ? "signed_up" : "blocked");
      return;
    }
    await runManagement();
    await runDirectDatabase();
    await closingHealth();
  }

  async function runManagement(): Promise<void> {
    if (input.preflightCases) {
      results.push(...input.preflightCases);
      return;
    }
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
    metadataPass =
      metadataReply.status === 200 &&
      sameOrigin(metadata.authorization_endpoint, target.supabaseUrl) &&
      sameOrigin(metadata.token_endpoint, target.supabaseUrl) &&
      sameOrigin(metadata.registration_endpoint, target.supabaseUrl);
    authorizationEndpoint =
      typeof metadata.authorization_endpoint === "string"
        ? metadata.authorization_endpoint
        : null;
    tokenEndpoint =
      typeof metadata.token_endpoint === "string"
        ? metadata.token_endpoint
        : null;
    registrationEndpoint =
      typeof metadata.registration_endpoint === "string"
        ? metadata.registration_endpoint
        : null;
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
    results.push(classifyOpenApiDocument(openApi.status, json(openApi)));
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

    mailerAutoconfirmFalse = settings?.mailer_autoconfirm === false;

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
      let created: Reply;
      try {
        const redirectTo = `${target.site}/auth/callback`;
        const challenge = createHash("sha256")
          .update(tenant.verifier)
          .digest("base64url");
        created = await request(
          `${target.supabaseUrl}/auth/v1/signup?redirect_to=${encodeURIComponent(redirectTo)}`,
          {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify({
              email: tenant.email,
              password: tenant.password,
              code_challenge: challenge,
              code_challenge_method: "s256",
            }),
          },
        );
      } catch (error) {
        if (!(error instanceof RequestTimeoutError)) throw error;
        tenant.responseLost = true;
        publishManifest();
        results.push(
          acceptanceCase(
            `signup.${tenant.label.replace("tenant-", "tenant_")}`,
            "fail",
            "signup.response_lost",
          ),
        );
        if (!results.some((row) => row.id === "signup.response_lost")) {
          results.push(
            acceptanceCase(
              "signup.response_lost",
              "gap",
              "The signup request ended without a response, so no user id was recorded. Cleanup looks up the exact tos3 address derived from the trusted preflight nonce, deletes only one match inside the run window, and still fails rather than reporting a pass.",
            ),
          );
        }
        continue;
      }
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
      const sessionIssued = created.status < 300 && Boolean(tenant.accessToken);
      publishManifest();
      results.push(
        acceptanceCase(
          `signup.${tenant.label.replace("tenant-", "tenant_")}`,
          sessionIssued ? "pass" : "fail",
          sessionIssued
            ? "session_issued"
            : created.status >= 300
              ? `http_${created.status}`
              : mailerAutoconfirmFalse
                ? `http_${created.status} confirmation_required`
                : `http_${created.status}`,
        ),
      );
    }

    if (phase === "signup") {
      pause("signed_up");
      return;
    }
    await sessionGate();
  }

  function mailFailureDetail(purpose: "confirmation" | "recovery"): string {
    if (!stateDir) return "mail_result_absent";
    const mail = readMailResult(stateDir, purpose);
    if (!mail) return "mail_result_absent";
    if (mail.status === "secret_absent") {
      return secretAbsent(RECEIVING_API_KEY_SECRET);
    }
    if (mail.status === "receiving_http") {
      return `receiving_http_${mail.httpStatus ?? 0}`;
    }
    return mail.status;
  }

  async function exchangeAppCode(
    tenant: Tenant,
    path: "/auth/callback" | "/auth/recovery",
    code: string,
    expectedLocation: string,
  ): Promise<boolean> {
    const cookie = pkceVerifierCookie(
      authStorageKey(target.supabaseUrl),
      tenant.verifier,
    );
    tenant.jar.set(cookie.name, cookie.value);
    const reply = await request(
      `${target.site}${path}?code=${encodeURIComponent(code)}`,
      {
        headers: { cookie: cookieHeader(tenant), accept: "text/html" },
      },
    );
    rememberCookies(tenant, reply.headers);
    const location = reply.headers.get("location") ?? "";
    if (reply.status !== 303 || location !== expectedLocation) return false;
    tenant.confirmed = true;
    const tokens = readSessionTokens(
      authStorageKey(target.supabaseUrl),
      tenant.jar,
    );
    if (tokens) {
      tenant.accessToken = tokens.accessToken;
      tenant.refreshToken = tokens.refreshToken;
    }
    return true;
  }

  async function applyConfirmation(): Promise<void> {
    const pending = tenants.filter(
      (tenant) =>
        !tenant.responseLost && !tenant.accessToken && !tenant.confirmed,
    );
    if (pending.length === 0 || !mailerAutoconfirmFalse || !mailRequired)
      return;
    const mail = stateDir ? readMailResult(stateDir, "confirmation") : null;
    for (const tenant of pending) {
      const id = `signup.confirmation.${tenant.label.replace("tenant-", "tenant_")}`;
      const action =
        mail?.status === "ready"
          ? mail.actions.find(
              (row) =>
                row.label === tenant.label && row.path === "/auth/callback",
            )
          : undefined;
      if (!action) {
        results.push(
          acceptanceCase(
            id,
            "fail",
            mail?.status === "ready"
              ? "link_rejected"
              : mailFailureDetail("confirmation"),
          ),
        );
        continue;
      }
      const exchanged = await exchangeAppCode(
        tenant,
        action.path,
        action.code,
        `${target.site}/business`,
      );
      results.push(
        acceptanceCase(
          id,
          exchanged ? "pass" : "fail",
          exchanged ? "confirmed" : "callback_rejected",
        ),
      );
    }
  }

  async function completeRecovery(tenant: Tenant): Promise<void> {
    if (!mailRequired || phase === "continue" || phase === "signup") return;
    const mail = stateDir ? readMailResult(stateDir, "recovery") : null;
    const action =
      mail?.status === "ready"
        ? mail.actions.find(
            (row) =>
              row.label === tenant.label && row.path === "/auth/recovery",
          )
        : undefined;
    if (!action) {
      const detail =
        mail?.status === "ready"
          ? "link_rejected"
          : mailFailureDetail("recovery");
      results.push(acceptanceCase("recovery.email_callback", "fail", detail));
      results.push(acceptanceCase("recovery.completion", "fail", detail));
      return;
    }
    const reply = await request(
      `${target.site}/auth/recovery?code=${encodeURIComponent(action.code)}`,
      {
        headers: {
          cookie: [...recoveryJar]
            .map(([name, value]) => `${name}=${value}`)
            .join("; "),
          accept: "text/html",
        },
      },
    );
    rememberCookiesOn(recoveryJar, reply.headers);
    const location = reply.headers.get("location") ?? "";
    const callbackPass =
      reply.status === 303 &&
      location === `${target.site}/auth/update-password`;
    results.push(
      acceptanceCase(
        "recovery.email_callback",
        callbackPass ? "pass" : "fail",
        callbackPass ? "recovery_callback" : "callback_rejected",
      ),
    );
    if (!callbackPass) {
      results.push(
        acceptanceCase("recovery.completion", "fail", "callback_rejected"),
      );
      return;
    }
    const updated = await request(`${target.site}/api/auth/password`, {
      method: "POST",
      headers: {
        origin: target.site,
        "content-type": "application/x-www-form-urlencoded",
        cookie: [...recoveryJar]
          .map(([name, value]) => `${name}=${value}`)
          .join("; "),
      },
      body: new URLSearchParams({
        password: syntheticPassword(rng(24)),
      }).toString(),
    });
    const updatedLocation = updated.headers.get("location") ?? "";
    const pass =
      updated.status === 303 && updatedLocation === `${target.site}/business`;
    results.push(
      acceptanceCase(
        "recovery.completion",
        pass ? "pass" : "fail",
        pass ? "password_updated" : `http_${updated.status}`,
      ),
    );
  }

  async function sessionGate(): Promise<void> {
    await applyConfirmation();
    const pending = tenants.some(
      (tenant) =>
        tenant.responseLost || (!tenant.accessToken && !tenant.confirmed),
    );
    if (pending) {
      const reason = tenants.some((tenant) => tenant.responseLost)
        ? "signup.response_lost"
        : mailerAutoconfirmFalse
          ? "confirmation_required"
          : "signup_session_absent";
      results.push(...blockedCases(SESSION_IDS, reason));
      await recovery(tenantA);
      if (phase === "continue") {
        pause("recovery_requested");
        return;
      }
      await completeRecovery(tenantA);
      return;
    }
    for (const tenant of tenants) await login(tenant);
    await recovery(tenantA);
    if (phase === "continue") {
      pause("recovery_requested");
      return;
    }
    await completeRecovery(tenantA);
    await finishAcceptedWork();
  }

  async function finishAcceptedWork(): Promise<void> {
    await refreshUi(tenantA);
    for (const tenant of tenants) await createOwnBusiness(tenant);
    await businessPages();
    await negativeUi(tenantA, tenantB);
    await negativeUi(tenantB, tenantA);
    await authenticatedDataApi(tenantA);

    if (!metadataPass) {
      results.push(...blockedCases(GENERIC_IDS, "oauth_metadata"));
      return;
    }
    registration = await register(registrationEndpoint ?? "", "acceptance");
    if (!registration) {
      results.push(...blockedCases(GENERIC_IDS, "dynamic_registration"));
      return;
    }
    const approvedA = await consent(
      tenantA,
      registration,
      authorizationEndpoint ?? "",
      tokenEndpoint ?? "",
      "approve",
    );
    results.push(
      acceptanceCase(
        "generic_client.consent",
        approvedA.ok ? "pass" : "fail",
        approvedA.ok ? "approved" : "not_approved",
      ),
    );
    if (!approvedA.ok || !tenantA.delegatedToken) {
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
      authorizationEndpoint ?? "",
      tokenEndpoint ?? "",
      "approve",
    );
    if (!approvedB.ok || !tenantB.delegatedToken) {
      results.push(
        ...blockedCases(
          [
            "generic_client.tenant_b_positive",
            "generic_client.tenant_b_negative",
            "generic_client.tenant_b_api_no_bearer",
            "generic_client.tenant_b_api_ui_token_as_bearer",
            "generic_client.tenant_b_mcp_positive",
            "generic_client.tenant_b_mcp_negative",
            "generic_client.tenant_b_setup_report",
            "generic_client.tenant_b_setup_status",
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
      authorizationEndpoint ?? "",
      tokenEndpoint ?? "",
    );
    denialRegistration = await register(registrationEndpoint ?? "", "denial");
    const denied = denialRegistration
      ? await consent(
          tenantA,
          denialRegistration,
          authorizationEndpoint ?? "",
          tokenEndpoint ?? "",
          "deny",
        )
      : { ok: false, token: null };
    results.push(
      acceptanceCase(
        "generic_client.denial",
        denied.ok ? "pass" : "fail",
        denied.ok ? "access_denied_no_code" : "not_denied",
      ),
    );
    restrictedRegistration = await register(
      registrationEndpoint ?? "",
      "restricted",
    );
    if (!restrictedRegistration) {
      results.push(...blockedCases(RESTRICTED_IDS, "dynamic_registration"));
      return;
    }
    const restricted = await consent(
      tenantA,
      restrictedRegistration,
      authorizationEndpoint ?? "",
      tokenEndpoint ?? "",
      "approve",
      { permissions: ["business.read"], remember: false },
    );
    await restrictedChecks(restricted.token);
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
    recoveryRequestedAt = new Date().toISOString();
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
    rememberCookiesOn(recoveryJar, reply.headers);
    const location = reply.headers.get("location") ?? "";
    const pass =
      reply.status === 303 &&
      location === `${target.site}/login?recovery=sent` &&
      !location.includes("example.com");
    if (!results.some((row) => row.id === "recovery.request_accepted")) {
      results.push(
        acceptanceCase(
          "recovery.request_accepted",
          pass ? "pass" : "fail",
          pass ? "request_initiated" : `http_${reply.status}`,
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
    label: CleanupClientLabel,
  ): Promise<RegisteredClient | null> {
    const reply = await request(endpoint, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        client_name: expectedClientName(label, nonce),
        redirect_uris: [GENERIC_REDIRECT],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    });
    const body = json(reply) as {
      client_id?: unknown;
      client_secret?: unknown;
    };
    if (
      reply.status >= 300 ||
      typeof body?.client_id !== "string" ||
      !CLEANUP_CLIENT_LABELS.includes(label)
    ) {
      return null;
    }
    const client: RegisteredClient = {
      label,
      clientId: body.client_id,
      clientSecret:
        typeof body.client_secret === "string" ? body.client_secret : null,
    };
    registered.push(client);
    publishManifest();
    return client;
  }

  async function consent(
    tenant: Tenant,
    client: RegisteredClient,
    authorizationEndpoint: string,
    tokenEndpoint: string,
    decision: "approve" | "deny",
    options: ConsentOptions = {},
  ): Promise<{ ok: boolean; token: string | null }> {
    const verifier = rng(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const state = rng(16).toString("hex");
    const authorize = new URL(authorizationEndpoint);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("client_id", client.clientId);
    authorize.searchParams.set("redirect_uri", GENERIC_REDIRECT);
    authorize.searchParams.set("code_challenge", challenge);
    authorize.searchParams.set("code_challenge_method", "S256");
    authorize.searchParams.set("state", state);
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
    if (!authorizationId || !onConsent) return { ok: false, token: null };
    if (!results.some((row) => row.id === "ui.consent_page")) {
      const page = await request(consentUrl, {
        headers: { cookie: cookieHeader(tenant), accept: "text/html" },
      });
      const rendered =
        page.status === 200 && page.text.includes("Authorize a client");
      results.push(
        acceptanceCase(
          "ui.consent_page",
          rendered ? "pass" : "fail",
          rendered ? "rendered_consent" : `http_${page.status}`,
        ),
      );
    }
    const form = new URLSearchParams();
    form.set("authorization_id", authorizationId);
    form.set("decision", decision);
    const permissions =
      options.permissions ??
      (decision === "approve" ? APPROVE_PERMISSIONS : []);
    for (const permission of permissions)
      form.append("permissions", permission);
    const decided = await request(`${target.site}/api/oauth/decision`, {
      method: "POST",
      headers: {
        cookie: cookieHeader(tenant),
        origin: target.site,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    });
    if (decision === "deny")
      return denyResult(decided, state, tokenEndpoint, client);
    if (decided.status !== 303) return { ok: false, token: null };
    const code = queryValue(decided.headers.get("location"), "code");
    if (!code) return { ok: false, token: null };
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
      return { ok: false, token: null };
    }
    let accessToken = issued.access_token;
    if (options.remember !== false) tenant.delegatedToken = accessToken;
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
      if (pass) {
        accessToken = next.access_token as string;
        if (options.remember !== false) tenant.delegatedToken = accessToken;
      }
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
    return { ok: true, token: accessToken };
  }

  async function denyResult(
    decided: Reply,
    state: string,
    tokenEndpoint: string,
    client: RegisteredClient,
  ): Promise<{ ok: boolean; token: null }> {
    let redirectOk = false;
    try {
      const parsed = new URL(decided.headers.get("location") ?? "");
      redirectOk =
        decided.status === 303 &&
        `${parsed.origin}${parsed.pathname}` === GENERIC_REDIRECT &&
        parsed.searchParams.get("error") === "access_denied" &&
        parsed.searchParams.get("state") === state &&
        !parsed.searchParams.has("code");
    } catch {
      redirectOk = false;
    }
    const tokenAttempt = await request(tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        redirect_uri: GENERIC_REDIRECT,
        client_id: client.clientId,
        code: "",
      }).toString(),
    });
    return { ok: redirectOk && tokenAttempt.status !== 200, token: null };
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
    const noBearerId =
      prefix === "generic_client"
        ? "generic_client.api_no_bearer"
        : "generic_client.tenant_b_api_no_bearer";
    const uiBearerId =
      prefix === "generic_client"
        ? "generic_client.api_ui_token_as_bearer"
        : "generic_client.tenant_b_api_ui_token_as_bearer";
    const mcpPositiveId =
      prefix === "generic_client"
        ? "generic_client.mcp_positive"
        : "generic_client.tenant_b_mcp_positive";
    const mcpNegativeId =
      prefix === "generic_client"
        ? "generic_client.mcp_negative"
        : "generic_client.tenant_b_mcp_negative";
    const reportId =
      prefix === "generic_client"
        ? "generic_client.setup_report"
        : "generic_client.tenant_b_setup_report";
    const statusId =
      prefix === "generic_client"
        ? "generic_client.setup_status"
        : "generic_client.tenant_b_setup_status";
    const missing = await request(`${target.site}/api/v1/business`, {
      headers: { accept: "application/json" },
    });
    results.push(
      acceptanceCase(
        noBearerId,
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
        uiBearerId,
        upgraded.status === 401 ? "pass" : "fail",
        `http_${upgraded.status}`,
      ),
    );
    const mcpOwn = await mcpCall(actor.delegatedToken, "create_business", {
      displayName: "Synthetic delegated",
      idempotencyKey: `tos3-mcp-${actor.label}-${nonce}`,
    });
    results.push(
      acceptanceCase(
        mcpPositiveId,
        mcpOwn.status === 200 && mcpOwn.id === actor.businessId
          ? "pass"
          : "fail",
        mcpOwn.id === actor.businessId
          ? "own_business"
          : `http_${mcpOwn.status}`,
      ),
    );
    const mcpForged = await mcpCall(actor.delegatedToken, "create_business", {
      displayName: "Synthetic delegated",
      idempotencyKey: `tos3-mcp-${actor.label}-${nonce}`,
      tenantId: other.businessId,
    });
    results.push(
      acceptanceCase(
        mcpNegativeId,
        mcpForged.id === actor.businessId && mcpForged.id !== other.businessId
          ? "pass"
          : "fail",
        mcpForged.id === other.businessId
          ? "other_tenant_visible"
          : `http_${mcpForged.status}`,
      ),
    );
    const report = await setupReport(actor.delegatedToken);
    results.push(
      acceptanceCase(
        reportId,
        report.ok && report.businessId === actor.businessId ? "pass" : "fail",
        report.ok ? "setup_report" : `http_${report.status}`,
      ),
    );
    const status = await mcpCall(actor.delegatedToken, "setup_status", {});
    results.push(
      acceptanceCase(
        statusId,
        status.ok && status.businessId === actor.businessId ? "pass" : "fail",
        status.ok ? "setup_status" : `http_${status.status}`,
      ),
    );
  }

  async function bearerBusiness(
    tenant: Tenant,
    forgedId: string | null,
    token: string | null = tenant.delegatedToken,
  ): Promise<{ status: number; id: string | null }> {
    const url = forgedId
      ? `${target.site}/api/v1/business?tenantId=${encodeURIComponent(forgedId)}`
      : `${target.site}/api/v1/business`;
    const reply = await request(url, {
      headers: {
        authorization: `Bearer ${token ?? ""}`,
        ...(forgedId ? { "x-tenant-id": forgedId } : {}),
        accept: "application/json",
      },
    });
    return { status: reply.status, id: businessId(json(reply)) };
  }

  async function setupReport(token: string | null): Promise<{
    status: number;
    ok: boolean;
    businessId: string | null;
  }> {
    const reply = await request(`${target.site}/api/v1/reports/setup`, {
      headers: {
        authorization: `Bearer ${token ?? ""}`,
        accept: "application/json",
      },
    });
    const body = json(reply) as {
      dataset?: unknown;
      businessId?: unknown;
      ready?: unknown;
    };
    return {
      status: reply.status,
      ok:
        reply.status === 200 &&
        body?.dataset === "setup" &&
        body.ready === true &&
        typeof body.businessId === "string",
      businessId: typeof body?.businessId === "string" ? body.businessId : null,
    };
  }

  async function mcpCall(
    token: string | null,
    name: string,
    args: Record<string, unknown>,
  ): Promise<{
    status: number;
    ok: boolean;
    id: string | null;
    businessId: string | null;
  }> {
    const reply = await request(`${target.site}/api/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token ?? ""}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    const text = (
      json(reply) as {
        result?: { content?: { text?: string }[]; isError?: boolean };
      }
    )?.result;
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text?.content?.[0]?.text ?? "");
    } catch {
      parsed = null;
    }
    const id = businessId(parsed);
    const reportId = (parsed as { businessId?: unknown } | null)?.businessId;
    const businessIdValue = typeof reportId === "string" ? reportId : id;
    return {
      status: reply.status,
      ok: reply.status === 200 && text?.isError !== true,
      id: text?.isError ? null : id,
      businessId: text?.isError ? null : businessIdValue,
    };
  }

  async function restrictedChecks(token: string | null): Promise<void> {
    const own = token
      ? await bearerBusiness(tenantA, null, token)
      : { status: 0, id: null };
    const report = token
      ? await setupReport(token)
      : { status: 0, ok: false, businessId: null };
    const status = token
      ? await mcpCall(token, "setup_status", {})
      : { status: 0, ok: false, id: null, businessId: null };
    results.push(
      acceptanceCase(
        "generic_client.restricted_business",
        own.status === 200 && own.id === tenantA.businessId ? "pass" : "fail",
        own.status === 200 ? "business_read" : `http_${own.status}`,
      ),
    );
    results.push(
      acceptanceCase(
        "generic_client.restricted_report",
        report.status === 403 ? "pass" : "fail",
        `http_${report.status}`,
      ),
    );
    results.push(
      acceptanceCase(
        "generic_client.restricted_setup_status",
        !status.ok && status.businessId !== tenantA.businessId
          ? "pass"
          : "fail",
        status.ok ? "reports_read_allowed" : `http_${status.status}`,
      ),
    );
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
    const reread = again.ok ? await bearerBusiness(tenant, null) : null;
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
    if (
      !tenantA.userId ||
      !tenantA.businessId ||
      !tenantB.userId ||
      !tenantB.businessId
    ) {
      results.push(...blockedCases(ids, "synthetic_business_absent"));
      if (tenantA.userId || tenantB.userId) {
        results.push(orphanRowsGap());
      }
      return;
    }
    try {
      const probeInputs = tenants.map((tenant) => {
        const other = tenant.label === "tenant-a" ? tenantB : tenantA;
        return {
          userId: tenant.userId ?? "",
          ownBusinessId: tenant.businessId ?? "",
          otherBusinessId: other.businessId ?? "",
          clientIds: registered.map((client) => client.clientId),
        };
      });
      const probes = input.probeDatabase
        ? await probeEach(input.appDatabaseUrl, probeInputs)
        : await probeWithPg(probeInputs);
      results.push(...classifyDirectProbes(probes));
    } catch (error) {
      results.push(
        ...blockedCases(ids, error instanceof Error ? error.name : "Error"),
      );
      results.push(orphanRowsGap());
    }
  }

  async function probeEach(
    url: string,
    probeInputs: readonly DirectProbeInput[],
  ): Promise<DirectProbe[]> {
    const probes: DirectProbe[] = [];
    for (const probeInput of probeInputs) {
      probes.push(await input.probeDatabase!(url, probeInput));
    }
    return probes;
  }

  async function probeWithPg(
    probeInputs: readonly DirectProbeInput[],
  ): Promise<DirectProbe[]> {
    const connection = pgConnection(input.appDatabaseUrl ?? "");
    try {
      return await probeDirectTenants(connection, probeInputs);
    } finally {
      await connection.close();
    }
  }

  async function closingHealth(): Promise<void> {
    closingChecked = true;
    const health = await request(`${target.site}/api/v1/health`, {
      headers: { accept: "application/json" },
    });
    const body = json(health) as { commit?: unknown; environment?: unknown };
    closingCommit = typeof body?.commit === "string" ? body.commit : "";
    const pass =
      health.status === 200 &&
      body?.environment === "development" &&
      closingCommit === deployedCommit &&
      closingCommit === input.commit;
    results.push(
      acceptanceCase(
        "health.closing",
        pass ? "pass" : "fail",
        pass ? "commit_unchanged" : "commit_changed",
      ),
    );
  }

  function publishManifest(): void {
    const identity: CleanupIdentity = {
      projectRef: target.ref,
      commit: input.commit,
      runId: input.runId,
      runAttempt: input.runAttempt,
      runNonce: nonce,
      startedAt: input.startedAt,
    };
    const manifest: CleanupManifest = {
      version: 1,
      environment: "development",
      projectRef: target.ref,
      commit: input.commit,
      runId: input.runId,
      runAttempt: input.runAttempt,
      users: tenants.flatMap((tenant) => {
        if (tenant.userId) return [{ label: tenant.label, id: tenant.userId }];
        if (tenant.responseLost) return [{ label: tenant.label }];
        return [];
      }),
      clients: registered.map((client) => ({
        label: client.label,
        id: client.clientId,
      })),
    };
    const reviewed = reviewCleanupManifest(manifest, identity);
    manifestState = reviewed.ok
      ? {
          ok: true,
          reason:
            manifest.users.length > 0
              ? "deferred_admin_cleanup"
              : "no_hosted_users",
        }
      : { ok: false, reason: reviewed.reason };
    if (!reviewed.ok) return;
    try {
      input.writeManifest?.(JSON.stringify(manifest));
    } catch {
      manifestState = { ok: false, reason: "manifest_unwritable" };
    }
  }

  async function loginPage(): Promise<void> {
    const page = await request(`${target.site}/login`, {
      headers: { accept: "text/html" },
    });
    const rendered =
      page.status === 200 &&
      page.text.includes("Sign in") &&
      page.text.includes("Account recovery");
    results.push(
      acceptanceCase(
        "ui.login_page",
        rendered ? "pass" : "fail",
        rendered ? "rendered_login" : `http_${page.status}`,
      ),
    );
  }

  async function businessPages(): Promise<void> {
    for (const tenant of tenants) {
      const ownName =
        tenant.label === "tenant-a" ? "Synthetic A" : "Synthetic B";
      const otherName =
        tenant.label === "tenant-a" ? "Synthetic B" : "Synthetic A";
      const page = await request(`${target.site}/business`, {
        headers: {
          cookie: cookieHeader(tenant),
          accept: "text/html",
        },
      });
      const rendered =
        page.status === 200 &&
        page.text.includes(ownName) &&
        !page.text.includes(otherName);
      results.push(
        acceptanceCase(
          `ui.${tenant.label.replace("tenant-", "tenant_")}_page`,
          rendered ? "pass" : "fail",
          rendered ? "rendered_business" : `http_${page.status}`,
        ),
      );
    }
  }
}

const RESTRICTED_IDS = [
  "generic_client.restricted_business",
  "generic_client.restricted_report",
  "generic_client.restricted_setup_status",
] as const;

const GENERIC_IDS = [
  "generic_client.consent",
  "generic_client.audience",
  "generic_client.api_positive",
  "generic_client.api_negative",
  "generic_client.api_no_bearer",
  "generic_client.api_ui_token_as_bearer",
  "generic_client.mcp_positive",
  "generic_client.mcp_negative",
  "generic_client.setup_report",
  "generic_client.setup_status",
  "generic_client.tenant_b_positive",
  "generic_client.tenant_b_negative",
  "generic_client.tenant_b_api_no_bearer",
  "generic_client.tenant_b_api_ui_token_as_bearer",
  "generic_client.tenant_b_mcp_positive",
  "generic_client.tenant_b_mcp_negative",
  "generic_client.tenant_b_setup_report",
  "generic_client.tenant_b_setup_status",
  ...RESTRICTED_IDS,
  "generic_client.revocation",
  "generic_client.reconnection",
  "generic_client.denial",
  "generic_client.bearer_not_upgraded",
  "generic_client.refresh",
] as const;

const EVIDENCE_GAPS: readonly AcceptanceCase[] = [
  ...REAL_CLIENT_GAPS,
  acceptanceCase(
    "recovery.email_callback",
    "gap",
    "Secretless runs do not read mail. The protected workflow records this case from the isolated receiving step.",
  ),
  acceptanceCase(
    "recovery.completion",
    "gap",
    "Recovery completion follows the email callback. Secretless runs do not read mail or call the admin API.",
  ),
  acceptanceCase(
    "ui.browser_interaction",
    "gap",
    "Rendered HTML checks fetch /login, /business, and /oauth/consent. No browser drives those forms. Cookie HTTP API calls are not rendered UI acceptance.",
  ),
  acceptanceCase(
    "cleanup.hard_kill",
    "gap",
    "If this job is cancelled or killed before the manifest output is written, cleanup receives no manifest. That is not a pass. Cleanup looks up the two emails and three client names derived from the trusted preflight nonce, requires one exact match inside the run window, and deletes only those. Ambiguous matches are left in place and the cleanup result stays fail.",
  ),
  acceptanceCase(
    "direct.audit_and_grants",
    "gap",
    "app.client_grants has no DELETE policy, so a scoped update can only set business_id null. app.access_audit has no DELETE policy. Auth user deletion does not remove either table. This workflow will not send unqualified SQL. A reviewed follow-up deletes those rows by primary key as a role this business job does not have.",
  ),
];

function orphanRowsGap(): AcceptanceCase {
  return acceptanceCase(
    "direct.orphan_rows",
    "gap",
    "Auth user deletion does not cascade into app.businesses, app.business_creation_keys, or app.oauth_consents. Scoped cleanup did not finish, so those rows may remain. This workflow will not send unqualified SQL or an elevated business request. A reviewed follow-up deletes the remaining rows by primary key as a role this business job does not have.",
  );
}

class RequestTimeoutError extends Error {
  constructor() {
    super("request_timeout");
    this.name = "RequestTimeoutError";
  }
}

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
  const runNonce = process.env.ACCEPTANCE_RUN_NONCE ?? "";
  mask(runNonce);
  if (!/^[a-f0-9]{32}$/.test(runNonce)) {
    console.error(
      "::error::ACCEPTANCE_RUN_NONCE must be 32 hex characters before signup.",
    );
    return 2;
  }
  const runId = process.env.GITHUB_RUN_ID ?? "";
  if (!/^[0-9]+$/.test(runId)) {
    console.error("::error::GITHUB_RUN_ID is absent.");
    return 2;
  }
  const runAttempt = process.env.GITHUB_RUN_ATTEMPT ?? "";
  if (!/^[0-9]+$/.test(runAttempt)) {
    console.error("::error::GITHUB_RUN_ATTEMPT is absent.");
    return 2;
  }
  const startedAt = process.env.ACCEPTANCE_STARTED_AT ?? "";
  if (!Number.isFinite(Date.parse(startedAt))) {
    console.error("::error::ACCEPTANCE_STARTED_AT is absent.");
    return 2;
  }
  const material = resolveAcceptanceMaterial(process.env, {});
  mask(material.publishableKey);
  mask(material.appDatabaseUrl);
  const bypass = await resolveProtectionBypass(process.env);
  mask(bypass.value);
  console.log(`Deployment protection bypass: ${bypass.source}.`);
  if (bypass.source === "none") {
    console.error(
      "::error::VERCEL_AUTOMATION_BYPASS_SECRET is absent. Copy the project's existing Protection Bypass for Automation value to GitHub → Settings → Environments → development → Secrets. The business job does not receive VERCEL_TOKEN. Do not generate a new bypass and do not disable Deployment Protection.",
    );
  }
  const preflightCases =
    decodePreflightCases(process.env.ACCEPTANCE_PREFLIGHT_CASES ?? "") ??
    blockedCases(MANAGEMENT_CASE_IDS, "preflight_cases_absent");
  let phase: HostedPhase;
  try {
    phase = readPhase(process.env.ACCEPTANCE_PHASE);
  } catch {
    console.error("::error::ACCEPTANCE_PHASE is not a supported phase.");
    return 2;
  }
  const stateDir = process.env.RUNNER_TEMP
    ? `${process.env.RUNNER_TEMP}/tos3-acceptance`
    : undefined;
  if (phase !== "all" && !stateDir) {
    console.error("::error::RUNNER_TEMP is absent.");
    return 2;
  }
  const report = await runHostedAcceptance({
    commit: process.env.GITHUB_SHA ?? "",
    runId,
    runAttempt,
    runNonce,
    startedAt,
    publishableKey: material.publishableKey,
    managementToken: null,
    appDatabaseUrl: material.appDatabaseUrl,
    preflightCases,
    bypass: bypass.value ?? null,
    phase,
    mailMode:
      process.env.ACCEPTANCE_MAIL_MODE === "required" ? "required" : undefined,
    stateDir,
    writePhaseOutput: (name, value) => {
      const output = process.env.GITHUB_OUTPUT;
      if (!output || /[\r\n]/.test(value)) return;
      appendFileSync(output, `${name}=${value}\n`);
    },
    schema: reviewedSchema(),
    writeManifest: (body) => {
      // Do not mask this value. A masked job output is dropped.
      writeManifestOutput(body, process.env.GITHUB_OUTPUT);
    },
  });
  if (phase === "signup" || phase === "continue") {
    console.log(`acceptance_stage=${phase}`);
    return 0;
  }
  console.log(formatAcceptanceReport(report));
  return acceptanceTally(report.results).exitCode;
}

function readPhase(value: string | undefined): HostedPhase {
  if (!value || value === "all") return "all";
  if (value === "signup" || value === "continue" || value === "finish") {
    return value;
  }
  throw new Error("acceptance_phase");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = await main();
}
