/**
 * Development-only proof for the current foundation.
 * Runs from the protected GitHub development environment. It creates its
 * own synthetic users, reads their mail through the existing Resend
 * receiving key, and prints case ids only. Direct table writes are proved
 * by the database tests. Auth self-delete may be unsupported, so
 * cleanup.auth_users records the observed HTTP status and synthetic
 * accounts can remain.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { chromium, type BrowserContext, type Page } from "@playwright/test";
import { parseDotenv } from "./assert-deploy-target.ts";
import { resolveProtectionBypass } from "./smoke-health.ts";
import {
  ENVIRONMENT_BINDINGS,
  supabaseUrlFor,
} from "../src/server/config/environments.ts";
import {
  RECEIVING_DOMAIN,
  readReceivedVerifyLink,
  type MailPurpose,
} from "../src/server/application/receiving-mail.ts";

export const DEVELOPMENT_SITE =
  "https://tutor-mbos-dev-lets-play-game.vercel.app";
const SITE = DEVELOPMENT_SITE;
const SUPABASE = supabaseUrlFor(
  ENVIRONMENT_BINDINGS.development.supabaseProjectRef,
);
const REDIRECT = "https://example.com/oauth/callback";

export interface HostedCase {
  id: string;
  status: "pass" | "fail" | "gap";
  detail: string;
}

export function hostedCheckAllowed(
  env: Record<string, string | undefined>,
): boolean {
  return (
    env.GITHUB_ACTIONS === "true" &&
    env.GITHUB_REF === "refs/heads/main" &&
    env.TUTOR_MBOS_ENV === "development"
  );
}

export function publishableKeyFromPulled(
  pulled: Record<string, string | undefined>,
): string | null {
  const value = pulled.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim() ?? "";
  if (!value || value === "[SENSITIVE]") return null;
  return /^sb_publishable_[A-Za-z0-9_-]+$/.test(value) ? value : null;
}

export function syntheticRecipient(
  runId: string,
  label: "a" | "b",
): string | null {
  if (!/^[0-9]{1,20}$/.test(runId)) return null;
  return `tos29-${runId}-${label}@${RECEIVING_DOMAIN}`;
}

export function syntheticPassword(bytes: Uint8Array): string {
  return `Aa1${Buffer.from(bytes).toString("base64url")}`.slice(0, 40);
}

export function businessIds(body: unknown): string[] {
  if (!Array.isArray(body)) return [];
  return body.flatMap((row) => {
    if (typeof row !== "object" || row === null) return [];
    const id = (row as { id?: unknown }).id;
    return typeof id === "string" ? [id] : [];
  });
}

export function businessesAreIsolated(a: unknown, b: unknown): boolean {
  const left = businessIds(a);
  const right = businessIds(b);
  return left.length === 1 && right.length === 1 && left[0] !== right[0];
}

export function grantRows(body: unknown): string[] {
  if (!Array.isArray(body)) return [];
  return body.flatMap((row) => {
    if (typeof row !== "object" || row === null) return [];
    const id = (row as { oauth_client_id?: unknown }).oauth_client_id;
    return typeof id === "string" ? [id] : [];
  });
}

export function revokedReadDenied(status: number, body: unknown): boolean {
  if (status !== 401 && status !== 403) return false;
  return !JSON.stringify(body ?? {}).includes('"id"');
}

/** A foreign discovery URL must not receive the signed-in browser. */
export function trustedSupabaseUrl(
  value: string | undefined,
  origin: string,
): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.origin === origin ? url : null;
  } catch {
    return null;
  }
}

/** Every case a full run reports. Unreached ones are failed, never omitted. */
export const HOSTED_CASES = [
  "hosted.health",
  "mail.confirmation",
  "browser.login",
  "browser.onboarding",
  "browser.onboarding_retry",
  "data_api.tenant_isolation",
  "mcp.consent",
  "data_api.cross_client_grant_hidden",
  "app.reports_only_business_denied",
  "mcp.discovery",
  "mcp.permitted_call",
  "app.revoke",
  "app.revoked_read",
  "data_api.delegated_raw_denied_after_revoke",
  "mcp.revoked_call",
  "browser.recovery",
  "mail.recovery",
  "browser.password_updated",
  "browser.old_password_rejected",
  "browser.new_password_login",
  "cleanup.auth_users",
  "cleanup.oauth_clients",
] as const;

export function unreachedCases(rows: { id: string }[]): string[] {
  const seen = new Set(rows.map((row) => row.id));
  return HOSTED_CASES.filter((id) => !seen.has(id));
}

/** Runs one stage and reports its failure, so later stages still run. */
export async function continueAfter(
  work: () => Promise<void>,
  onFailure: (error: unknown) => void,
): Promise<void> {
  try {
    await work();
  } catch (error) {
    onFailure(error);
  }
}

function authError(url: URL): boolean {
  const fragment = new URLSearchParams(url.hash.slice(1));
  return ["error", "error_code", "error_description"].some(
    (key) => fragment.has(key) || url.searchParams.has(key),
  );
}

/**
 * The Auth verify response for a mailed confirmation link, read without
 * following it. supabase-js signUp uses the implicit flow, so a good link
 * redirects to the site callback with a session fragment. The app callback
 * exchanges PKCE codes only, so the browser is not sent there.
 */
export function confirmationRedirect(
  status: number,
  location: string,
  site: string,
): string {
  if (status !== 302 && status !== 303) return `http_${status}`;
  let url: URL;
  try {
    url = new URL(location);
  } catch {
    return "bad_location";
  }
  if (url.origin !== site || url.pathname !== "/auth/callback") {
    return "foreign_target";
  }
  if (authError(url)) return "auth_error";
  const fragment = new URLSearchParams(url.hash.slice(1));
  return fragment.get("access_token") || url.searchParams.get("code")
    ? "redirected"
    : "no_session";
}

/**
 * A confirmation passes only on the Auth outcome: password sign-in is refused
 * as unconfirmed before the mailed link and succeeds after it. Sign-in
 * results are error codes, or null when a session was issued.
 */
export function confirmationOutcome(input: {
  before: string | null;
  mail: string;
  redirect: string | null;
  after: string | null;
}): string {
  if (input.before === null) return "unconfirmed_signin_allowed";
  if (input.before !== "email_not_confirmed") return `before_${input.before}`;
  if (input.mail !== "ready") return `mail_${input.mail}`;
  if (input.redirect !== "redirected") {
    return `redirect_${input.redirect ?? "absent"}`;
  }
  if (input.after !== null) return `signin_${input.after}`;
  return "signin_after_verify";
}

/** Final document of a followed recovery link, after the app's PKCE exchange. */
export function recoveryLanding(
  value: string,
  status: number,
  site: string,
): string {
  if (status >= 400) return `http_${status}`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "not_landed";
  }
  if (url.origin !== site) return "foreign_target";
  if (authError(url)) return "auth_error";
  return url.pathname === "/auth/update-password" ? "landed" : "not_landed";
}

/** Stage, error class and Playwright call only. Messages can carry URLs. */
export function failureDetail(stage: string, error: unknown): string {
  if (!(error instanceof Error)) return `${stage}_error`;
  const call = /^([A-Za-z]+\.[A-Za-z]+):/.exec(error.message)?.[1];
  return call ? `${stage}_${error.name}_${call}` : `${stage}_${error.name}`;
}

function mask(value: string | undefined): void {
  if (value && process.env.GITHUB_ACTIONS === "true") {
    console.log(`::add-mask::${value}`);
  }
}

function detailCode(value: string): string {
  return value
    .replace(/https?:\/\/\S+/g, "[url]")
    .replace(/[^\w.=-]+/g, "_")
    .slice(0, 80);
}

async function jsonFetch(
  url: string,
  init: RequestInit,
): Promise<{ status: number; json: unknown; location: string }> {
  const response = await fetch(url, { ...init, redirect: "manual" });
  const location = response.headers.get("location") ?? "";
  const text = await response.text();
  let json: unknown = null;
  try {
    json = text ? (JSON.parse(text) as unknown) : null;
  } catch {
    json = null;
  }
  return { status: response.status, json, location };
}

function authHeaders(key: string): Record<string, string> {
  return {
    apikey: key,
    "content-type": "application/json",
    accept: "application/json",
  };
}

async function rpc(
  key: string,
  token: string,
  name: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: unknown }> {
  const reply = await jsonFetch(`${SUPABASE}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { ...authHeaders(key), authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: reply.status, json: reply.json };
}

async function openContext(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  bypass: string,
) {
  const context = await browser.newContext();
  await context.route("**/*", async (route) => {
    const url = route.request().url();
    if (url.startsWith("https://example.com/")) {
      await route.abort();
      return;
    }
    const headers = { ...route.request().headers() };
    if (new URL(url).hostname.endsWith("vercel.app")) {
      headers["x-vercel-protection-bypass"] = bypass;
    }
    await route.continue({ headers });
  });
  return context;
}

async function signIn(
  page: Page,
  email: string,
  password: string,
): Promise<number> {
  await page.goto(`${SITE}/login`, { waitUntil: "domcontentloaded" });
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  const pending = page.waitForResponse(
    (response) =>
      response.url().includes("/api/auth/login") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Sign in" }).click();
  const response = await pending;
  if (response.status() === 303) {
    await page
      .waitForURL(/\/onboarding$/, { timeout: 20_000 })
      .catch(() => undefined);
  }
  return response.status();
}

async function createBusiness(
  page: Page,
  name: string,
): Promise<string | null> {
  await page.goto(`${SITE}/onboarding`, { waitUntil: "domcontentloaded" });
  await page.locator("#displayName").fill(name);
  const pending = page.waitForResponse(
    (response) =>
      response.url().includes("/api/v1/business") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create business" }).click();
  await pending;
  await page.waitForURL(/\/business$/, { timeout: 20_000 });
  const text = await page.locator("main").innerText();
  const match = /Business id ([0-9a-f-]{36})/i.exec(text);
  return match?.[1] ?? null;
}

async function followRecovery(context: BrowserContext, url: URL) {
  const page = await context.newPage();
  try {
    const response = await page.goto(url.toString(), {
      waitUntil: "domcontentloaded",
    });
    return recoveryLanding(page.url(), response?.status() ?? 0, SITE);
  } catch (error) {
    return failureDetail("recovery_link", error);
  } finally {
    await page.close();
  }
}

async function signInCode(
  auth: SupabaseClient["auth"],
  email: string,
  password: string,
): Promise<string | null> {
  const { error } = await auth.signInWithPassword({ email, password });
  if (!error) return null;
  return error.code ?? `http_${error.status ?? 0}`;
}

async function verifyRedirect(url: URL): Promise<string> {
  try {
    const response = await fetch(url, { redirect: "manual" });
    return confirmationRedirect(
      response.status,
      response.headers.get("location") ?? "",
      SITE,
    );
  } catch (error) {
    return failureDetail("verify", error);
  }
}

async function readLink(
  key: string,
  recipient: string,
  purpose: MailPurpose,
  startedAt: string,
  exclude: string[],
): Promise<{ status: string; messageId?: string; verifyUrl?: URL }> {
  return readReceivedVerifyLink({
    fetchImpl: fetch,
    apiKey: key,
    recipient,
    purpose,
    startedAt,
    nowMs: Date.now(),
    supabaseOrigin: SUPABASE,
    siteOrigin: SITE,
    excludeMessageIds: exclude,
    attempts: 12,
    delayMs: 5_000,
  });
}

async function issueToken(
  key: string,
  email: string,
  password: string,
): Promise<string | null> {
  const supabase = createClient(SUPABASE, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });
  if (error || !data.session?.access_token) return null;
  mask(data.session.access_token);
  mask(data.session.refresh_token);
  return data.session.access_token;
}

async function registerClient(
  key: string,
  name: string,
): Promise<string | null> {
  const metadata = await jsonFetch(
    `${SUPABASE}/auth/v1/.well-known/oauth-authorization-server`,
    {
      headers: authHeaders(key),
    },
  );
  const registration =
    typeof metadata.json === "object" && metadata.json !== null
      ? (metadata.json as { registration_endpoint?: unknown })
          .registration_endpoint
      : undefined;
  if (metadata.status !== 200 || typeof registration !== "string") return null;
  if (new URL(registration).origin !== SUPABASE) return null;
  const created = await jsonFetch(registration, {
    method: "POST",
    headers: authHeaders(key),
    body: JSON.stringify({
      client_name: name,
      redirect_uris: [REDIRECT],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  const clientId =
    typeof created.json === "object" && created.json !== null
      ? (created.json as { client_id?: unknown }).client_id
      : undefined;
  return created.status < 300 && typeof clientId === "string" ? clientId : null;
}

async function authorize(
  page: Page,
  key: string,
  clientId: string,
  permissions: string[],
): Promise<{ token: string } | { failure: string }> {
  let step = "metadata";
  try {
    const metadata = await jsonFetch(
      `${SUPABASE}/auth/v1/.well-known/oauth-authorization-server`,
      {
        headers: authHeaders(key),
      },
    );
    const record = metadata.json as {
      authorization_endpoint?: string;
      token_endpoint?: string;
    };
    const authorizeUrl = trustedSupabaseUrl(
      record?.authorization_endpoint,
      SUPABASE,
    );
    const tokenUrl = trustedSupabaseUrl(record?.token_endpoint, SUPABASE);
    if (!authorizeUrl || !tokenUrl) return { failure: "metadata_untrusted" };
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    mask(verifier);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", REDIRECT);
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    authorizeUrl.searchParams.set("state", randomBytes(8).toString("hex"));
    authorizeUrl.searchParams.set("scope", "openid email profile");
    authorizeUrl.searchParams.set("resource", `${SITE}/api/mcp`);
    step = "authorize_navigation";
    const landed = await page.goto(authorizeUrl.toString(), {
      waitUntil: "domcontentloaded",
    });
    step = "consent_url";
    await page.waitForURL(/\/oauth\/consent\?/, { timeout: 20_000 });
    if (new URL(page.url()).origin !== SITE)
      return { failure: "consent_origin" };
    const consentStatus = landed?.status() ?? 0;
    if (consentStatus !== 200)
      return { failure: `consent_http_${consentStatus}` };
    step = "permissions";
    await page
      .locator("input[value='business.read']")
      .setChecked(permissions.includes("business.read"));
    await page
      .locator("input[value='reports.read']")
      .setChecked(permissions.includes("reports.read"));
    await page
      .locator("input[value='business.onboard']")
      .setChecked(permissions.includes("business.onboard"));
    step = "approve";
    const pending = page.waitForResponse(
      (response) =>
        response.url().includes("/api/oauth/decision") &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Approve" }).click();
    step = "decision";
    const decided = await pending;
    if (decided.status() !== 303) {
      return { failure: `decision_http_${decided.status()}` };
    }
    const location = decided.headers().location ?? "";
    const code = new URL(location, SITE).searchParams.get("code");
    if (!code) return { failure: "decision_no_code" };
    mask(code);
    step = "token";
    const token = await jsonFetch(tokenUrl.toString(), {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT,
        client_id: clientId,
        code_verifier: verifier,
      }).toString(),
    });
    const access =
      typeof token.json === "object" && token.json !== null
        ? (token.json as { access_token?: unknown }).access_token
        : undefined;
    if (token.status !== 200 || typeof access !== "string") {
      return { failure: `token_http_${token.status}` };
    }
    mask(access);
    return { token: access };
  } catch (error) {
    return { failure: failureDetail(step, error) };
  }
}

async function main(): Promise<number> {
  const results: HostedCase[] = [];
  const record = (id: string, status: HostedCase["status"], detail: string) => {
    results.push({ id, status, detail: detailCode(detail) });
  };
  if (!hostedCheckAllowed(process.env)) {
    console.error(
      "::error::This check runs only from the protected development workflow on main.",
    );
    return 2;
  }
  const runId = process.env.GITHUB_RUN_ID ?? "";
  const emailA = syntheticRecipient(runId, "a");
  const emailB = syntheticRecipient(runId, "b");
  const receivingKey = process.env.RESEND_DEVELOPMENT_RECEIVING_API_KEY ?? "";
  mask(receivingKey);
  const pulled = existsSync(".vercel/.env.production.local")
    ? parseDotenv(readFileSync(".vercel/.env.production.local", "utf8"))
    : {};
  const publishableKey = publishableKeyFromPulled(pulled);
  mask(publishableKey ?? undefined);
  const bypass = await resolveProtectionBypass(process.env);
  mask(bypass.value);
  if (!emailA || !emailB || !publishableKey || !bypass.value || !receivingKey) {
    record(
      "hosted.prerequisites",
      "fail",
      !publishableKey
        ? "publishable_key_unreadable"
        : !bypass.value
          ? `bypass_${bypass.source}`
          : "recipient_or_receiving_key_absent",
    );
    for (const row of results)
      console.log(`case=${row.id} status=${row.status} detail=${row.detail}`);
    return 1;
  }
  const passwordA = syntheticPassword(randomBytes(24));
  const passwordB = syntheticPassword(randomBytes(24));
  mask(passwordA);
  mask(passwordB);
  mask(emailA);
  mask(emailB);
  const supabase = createClient(SUPABASE, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const browser = await chromium.launch({ headless: true });
  let stage = "health";
  let cleanupA: string | null = null;
  let cleanupB: string | null = null;
  try {
    const health = await jsonFetch(`${SITE}/api/v1/health`, {
      headers: {
        accept: "application/json",
        "x-vercel-protection-bypass": bypass.value,
      },
    });
    const commit = (health.json as { commit?: unknown } | null)?.commit;
    record(
      "hosted.health",
      health.status === 200 && commit === process.env.GITHUB_SHA
        ? "pass"
        : "fail",
      health.status === 200 ? "commit_checked" : `http_${health.status}`,
    );

    stage = "confirmation";
    const started = new Date().toISOString();
    const signups = await Promise.all(
      [emailA, emailB].map((email, index) =>
        supabase.auth.signUp({
          email,
          password: index === 0 ? passwordA : passwordB,
          options: { emailRedirectTo: `${SITE}/auth/callback` },
        }),
      ),
    );
    const needsMail = signups.map(
      (signup) => !signup.error && !signup.data.session,
    );
    if (signups.some((signup) => signup.error)) {
      record("mail.confirmation", "fail", "signup_rejected");
    } else if (needsMail.some(Boolean)) {
      const outcomes: string[] = [];
      const seen: string[] = [];
      for (const [index, email] of [emailA, emailB].entries()) {
        if (!needsMail[index]) continue;
        const password = index === 0 ? passwordA : passwordB;
        const before = await signInCode(supabase.auth, email, password);
        const mail = await readLink(
          receivingKey,
          email,
          "confirmation",
          started,
          seen,
        );
        if (mail.messageId) seen.push(mail.messageId);
        const redirect =
          mail.status === "ready" && mail.verifyUrl
            ? await verifyRedirect(mail.verifyUrl)
            : null;
        const after =
          redirect === "redirected"
            ? await signInCode(supabase.auth, email, password)
            : "not_attempted";
        outcomes.push(
          confirmationOutcome({ before, mail: mail.status, redirect, after }),
        );
      }
      const failure = outcomes.find(
        (outcome) => outcome !== "signin_after_verify",
      );
      record(
        "mail.confirmation",
        failure ? "fail" : "pass",
        failure ?? "signin_after_verify",
      );
    } else {
      record("mail.confirmation", "pass", "autoconfirm");
    }

    stage = "login_onboarding";
    const contextA = await openContext(browser, bypass.value!);
    const pageA = await contextA.newPage();
    const loginA = await signIn(pageA, emailA, passwordA);
    const loggedIn = loginA === 303 && pageA.url().endsWith("/onboarding");
    record(
      "browser.login",
      loggedIn ? "pass" : "fail",
      loggedIn ? "onboarding" : `http_${loginA}`,
    );
    let businessA: string | null = null;
    let businessB: string | null = null;
    if (loggedIn) {
      businessA = await createBusiness(pageA, "Fixture A");
      const retry = await createBusiness(pageA, "Fixture A renamed");
      record(
        "browser.onboarding",
        businessA ? "pass" : "fail",
        businessA ? "created" : "missing",
      );
      record(
        "browser.onboarding_retry",
        businessA && retry === businessA ? "pass" : "fail",
        businessA && retry === businessA ? "same_business" : "not_same",
      );
    } else {
      record("browser.onboarding", "fail", "no_session");
      record("browser.onboarding_retry", "fail", "no_session");
    }
    const contextB = await openContext(browser, bypass.value!);
    const pageB = await contextB.newPage();
    const loginB = await signIn(pageB, emailB, passwordB);
    if (loginB === 303) businessB = await createBusiness(pageB, "Fixture B");
    await contextB.close();

    stage = "tenant_isolation";
    const tokenA = await issueToken(publishableKey, emailA, passwordA);
    const tokenB = await issueToken(publishableKey, emailB, passwordB);
    cleanupA = tokenA;
    cleanupB = tokenB;
    if (tokenA && tokenB && businessA && businessB) {
      const readA = await rpc(publishableKey, tokenA, "read_business", {});
      const readB = await rpc(publishableKey, tokenB, "read_business", {});
      const isolated =
        businessesAreIsolated(readA.json, readB.json) &&
        businessIds(readA.json)[0] === businessA &&
        businessIds(readB.json)[0] === businessB;
      record(
        "data_api.tenant_isolation",
        isolated ? "pass" : "fail",
        isolated ? "distinct" : `http_${readA.status}`,
      );
    } else {
      record("data_api.tenant_isolation", "fail", "token_or_business_missing");
    }

    await continueAfter(
      async () => {
        stage = "consent";
        const reader = await registerClient(
          publishableKey,
          `tos29-${runId}-reader`,
        );
        const reports = await registerClient(
          publishableKey,
          `tos29-${runId}-reports`,
        );
        let readerToken: string | null = null;
        let reportsToken: string | null = null;
        let consentFailure = !loggedIn
          ? "no_session"
          : !reader || !reports
            ? "client_not_registered"
            : "";
        if (loggedIn && reader && reports) {
          const readerGrant = await authorize(pageA, publishableKey, reader, [
            "business.read",
            "reports.read",
          ]);
          const reportsGrant = await authorize(pageA, publishableKey, reports, [
            "reports.read",
          ]);
          readerToken = "token" in readerGrant ? readerGrant.token : null;
          reportsToken = "token" in reportsGrant ? reportsGrant.token : null;
          consentFailure =
            "failure" in readerGrant
              ? `reader_${readerGrant.failure}`
              : "failure" in reportsGrant
                ? `reports_${reportsGrant.failure}`
                : "";
        }
        record(
          "mcp.consent",
          readerToken && reportsToken ? "pass" : "fail",
          readerToken && reportsToken ? "issued" : consentFailure,
        );
        stage = "client_permissions";
        if (tokenA && reader && reports && reportsToken) {
          const own = await rpc(
            publishableKey,
            reportsToken,
            "read_client_grant",
            {
              p_oauth_client_id: reports,
            },
          );
          const other = await rpc(
            publishableKey,
            reportsToken,
            "read_client_grant",
            { p_oauth_client_id: reader },
          );
          const hidden =
            grantRows(own.json).length === 1 &&
            grantRows(other.json).length === 0;
          record(
            "data_api.cross_client_grant_hidden",
            hidden ? "pass" : "fail",
            hidden ? "own_grant_only" : `http_${other.status}`,
          );
          const denied = await jsonFetch(`${SITE}/api/v1/business`, {
            headers: {
              accept: "application/json",
              authorization: `Bearer ${reportsToken}`,
              "x-vercel-protection-bypass": bypass.value!,
            },
          });
          const body = JSON.stringify(denied.json ?? {});
          record(
            "app.reports_only_business_denied",
            denied.status === 403 &&
              !body.includes(businessA ?? "missing-business")
              ? "pass"
              : "fail",
            `http_${denied.status}`,
          );
        } else {
          record(
            "data_api.cross_client_grant_hidden",
            "fail",
            "grant_setup_missing",
          );
          record(
            "app.reports_only_business_denied",
            "fail",
            "grant_setup_missing",
          );
        }

        stage = "mcp";
        if (readerToken) {
          const discovery = await jsonFetch(
            `${SITE}/.well-known/oauth-protected-resource`,
            {
              headers: {
                accept: "application/json",
                "x-vercel-protection-bypass": bypass.value!,
              },
            },
          );
          const resource = (discovery.json as { resource?: unknown } | null)
            ?.resource;
          record(
            "mcp.discovery",
            discovery.status === 200 && resource === `${SITE}/api/mcp`
              ? "pass"
              : "fail",
            discovery.status === 200
              ? "resource_present"
              : `http_${discovery.status}`,
          );
          const client = new Client({
            name: "tutor-mbos-foundation-check",
            version: "0",
          });
          const transport = new StreamableHTTPClientTransport(
            new URL(`${SITE}/api/mcp`),
            {
              requestInit: {
                headers: {
                  authorization: `Bearer ${readerToken}`,
                  "x-vercel-protection-bypass": bypass.value!,
                },
              },
            },
          );
          let mcpConnected = false;
          try {
            await client.connect(transport);
            mcpConnected = true;
            const called = await client.callTool({
              name: "setup_status",
              arguments: {},
            });
            record(
              "mcp.permitted_call",
              called.isError ? "fail" : "pass",
              called.isError ? "tool_error" : "setup_status",
            );
          } catch {
            record("mcp.permitted_call", "fail", "client_error");
          }
          const revoke = await pageA.request.post(
            `${SITE}/api/v1/grants/revoke`,
            {
              data: { clientId: reader },
              headers: {
                origin: SITE,
                accept: "application/json",
                "x-vercel-protection-bypass": bypass.value!,
              },
            },
          );
          record(
            "app.revoke",
            revoke.status() === 200 ? "pass" : "fail",
            `http_${revoke.status()}`,
          );
          const again = await jsonFetch(`${SITE}/api/v1/business`, {
            headers: {
              accept: "application/json",
              authorization: `Bearer ${readerToken}`,
              "x-vercel-protection-bypass": bypass.value!,
            },
          });
          record(
            "app.revoked_read",
            revokedReadDenied(again.status, again.json) ? "pass" : "fail",
            `http_${again.status}`,
          );
          const raw = await rpc(
            publishableKey,
            readerToken,
            "read_business",
            {},
          );
          record(
            "data_api.delegated_raw_denied_after_revoke",
            raw.status === 200 && businessIds(raw.json).length === 0
              ? "pass"
              : "fail",
            `http_${raw.status}`,
          );
          if (!mcpConnected) {
            record("mcp.revoked_call", "fail", "client_not_connected");
          } else {
            try {
              const revokedCall = await client.callTool({
                name: "setup_status",
                arguments: {},
              });
              record(
                "mcp.revoked_call",
                revokedCall.isError ? "pass" : "fail",
                revokedCall.isError ? "tool_error" : "still_permitted",
              );
            } catch {
              record("mcp.revoked_call", "pass", "client_rejected");
            }
          }
          await client.close().catch(() => undefined);
        } else {
          for (const id of [
            "mcp.discovery",
            "mcp.permitted_call",
            "app.revoke",
            "app.revoked_read",
            "data_api.delegated_raw_denied_after_revoke",
            "mcp.revoked_call",
          ]) {
            record(id, "fail", "no_delegated_token");
          }
        }
      },
      (error) => {
        record("hosted.unhandled", "fail", failureDetail(stage, error));
      },
    );

    stage = "recovery";
    const recoveryStarted = new Date().toISOString();
    const recoveryPage = await contextA.newPage();
    await recoveryPage.goto(`${SITE}/login`, { waitUntil: "domcontentloaded" });
    await recoveryPage.locator("#recovery-email").fill(emailA);
    const recoveryPending = recoveryPage.waitForResponse(
      (response) =>
        response.url().includes("/api/auth/recover") &&
        response.request().method() === "POST",
    );
    await recoveryPage
      .getByRole("button", { name: "Email a recovery link" })
      .click();
    const recoveryReply = await recoveryPending;
    record(
      "browser.recovery",
      recoveryReply.status() === 303 ? "pass" : "fail",
      `http_${recoveryReply.status()}`,
    );
    const recoveryMail = await readLink(
      receivingKey,
      emailA,
      "recovery",
      recoveryStarted,
      [],
    );
    const recoveryContext = await openContext(browser, bypass.value!);
    const landing = recoveryMail.verifyUrl
      ? await followRecovery(recoveryContext, recoveryMail.verifyUrl)
      : `mail_${recoveryMail.status}`;
    const opened = recoveryMail.status === "ready" && landing === "landed";
    record("mail.recovery", opened ? "pass" : "fail", landing);
    if (opened) {
      const update = await recoveryContext.newPage();
      await update.goto(`${SITE}/auth/update-password`, {
        waitUntil: "domcontentloaded",
      });
      const replacement = syntheticPassword(randomBytes(24));
      mask(replacement);
      await update.locator("#password").fill(replacement);
      const updated = update.waitForResponse(
        (response) =>
          response.url().includes("/api/auth/password") &&
          response.request().method() === "POST",
      );
      await update.getByRole("button", { name: "Update password" }).click();
      const passwordReply = await updated;
      record(
        "browser.password_updated",
        passwordReply.status() === 303 ? "pass" : "fail",
        `http_${passwordReply.status()}`,
      );
      const fresh = await openContext(browser, bypass.value!);
      const freshPage = await fresh.newPage();
      const oldStatus = await signIn(freshPage, emailA, passwordA);
      record(
        "browser.old_password_rejected",
        oldStatus === 401 ? "pass" : "fail",
        `http_${oldStatus}`,
      );
      const newStatus = await signIn(freshPage, emailA, replacement);
      record(
        "browser.new_password_login",
        newStatus === 303 && freshPage.url().endsWith("/onboarding")
          ? "pass"
          : "fail",
        `http_${newStatus}`,
      );
      await fresh.close();
      const replacementToken = await issueToken(
        publishableKey,
        emailA,
        replacement,
      );
      if (replacementToken) cleanupA = replacementToken;
    } else {
      record("browser.password_updated", "fail", "no_recovery_session");
      record("browser.old_password_rejected", "fail", "no_recovery_session");
      record("browser.new_password_login", "fail", "no_recovery_session");
    }
    await recoveryContext.close();
    await contextA.close();
  } catch (error) {
    record("hosted.unhandled", "fail", failureDetail(stage, error));
  } finally {
    const cleanupStatuses: string[] = [];
    for (const token of [cleanupA, cleanupB]) {
      if (!token) {
        cleanupStatuses.push("absent");
        continue;
      }
      const deleted = await jsonFetch(`${SUPABASE}/auth/v1/user`, {
        method: "DELETE",
        headers: {
          ...authHeaders(publishableKey),
          authorization: `Bearer ${token}`,
        },
      }).catch(() => ({ status: 0, json: null, location: "" }));
      cleanupStatuses.push(`http_${deleted.status}`);
    }
    const removed = cleanupStatuses.filter(
      (status) => status === "http_200" || status === "http_204",
    ).length;
    record(
      "cleanup.auth_users",
      removed === 2 ? "pass" : "gap",
      cleanupStatuses.join("_"),
    );
    record("cleanup.oauth_clients", "gap", "left_registered");
    await browser.close().catch(() => undefined);
  }
  for (const id of unreachedCases(results)) record(id, "fail", "not_reached");
  for (const row of results)
    console.log(`case=${row.id} status=${row.status} detail=${row.detail}`);
  const failed = results.some((row) => row.status === "fail");
  return failed ? 1 : 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = await main();
}
