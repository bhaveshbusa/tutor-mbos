/**
 * Development-only proof for the current foundation.
 * Runs from the protected GitHub development environment. It creates its
 * own synthetic users, reads their mail through the existing Resend
 * receiving key, and prints case ids only.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createClient } from "@supabase/supabase-js";
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

async function followVerify(
  context: BrowserContext,
  url: URL,
  purpose: MailPurpose,
): Promise<boolean> {
  const page = await context.newPage();
  await page.goto(url.toString(), { waitUntil: "domcontentloaded" });
  const expected =
    purpose === "confirmation"
      ? /\/(business|onboarding)$/
      : /\/auth\/update-password$/;
  try {
    await page.waitForURL(expected, { timeout: 20_000 });
    return true;
  } catch {
    return false;
  } finally {
    await page.close();
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
): Promise<string | null> {
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
  if (!record?.authorization_endpoint || !record.token_endpoint) return null;
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  mask(verifier);
  const authorizeUrl = new URL(record.authorization_endpoint);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", REDIRECT);
  authorizeUrl.searchParams.set("code_challenge", challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set("state", randomBytes(8).toString("hex"));
  authorizeUrl.searchParams.set("scope", "openid email profile");
  authorizeUrl.searchParams.set("resource", `${SITE}/api/mcp`);
  await page.goto(authorizeUrl.toString(), { waitUntil: "domcontentloaded" });
  await page.waitForURL(/\/oauth\/consent\?/, { timeout: 20_000 });
  await page
    .locator("input[value='business.read']")
    .setChecked(permissions.includes("business.read"));
  await page
    .locator("input[value='reports.read']")
    .setChecked(permissions.includes("reports.read"));
  await page
    .locator("input[value='business.onboard']")
    .setChecked(permissions.includes("business.onboard"));
  const pending = page.waitForResponse(
    (response) =>
      response.url().includes("/api/oauth/decision") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Approve" }).click();
  const decided = await pending;
  const location = decided.headers().location ?? "";
  const code = new URL(location, SITE).searchParams.get("code");
  if (!code) return null;
  mask(code);
  const token = await jsonFetch(record.token_endpoint, {
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
  if (token.status !== 200 || typeof access !== "string") return null;
  mask(access);
  return access;
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
      const context = await openContext(browser, bypass.value!);
      let confirmed = true;
      const seen: string[] = [];
      for (const [index, email] of [emailA, emailB].entries()) {
        if (!needsMail[index]) continue;
        const mail = await readLink(
          receivingKey,
          email,
          "confirmation",
          started,
          seen,
        );
        if (mail.messageId) seen.push(mail.messageId);
        const opened = mail.verifyUrl
          ? await followVerify(context, mail.verifyUrl, "confirmation")
          : false;
        confirmed &&= mail.status === "ready" && opened;
      }
      await context.close();
      record(
        "mail.confirmation",
        confirmed ? "pass" : "fail",
        confirmed ? "verified" : "not_verified",
      );
    } else {
      record("mail.confirmation", "pass", "autoconfirm");
    }

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
      const write = await jsonFetch(`${SUPABASE}/rest/v1/businesses`, {
        method: "POST",
        headers: {
          ...authHeaders(publishableKey),
          authorization: `Bearer ${tokenA}`,
          "content-profile": "app",
          "accept-profile": "app",
        },
        body: JSON.stringify({
          display_name: "raw",
          owner_user_id: "00000000-0000-4000-8000-000000000000",
        }),
      });
      record(
        "data_api.direct_write_denied",
        write.status !== 200 && write.status !== 201 ? "pass" : "fail",
        `http_${write.status}`,
      );
    } else {
      record("data_api.tenant_isolation", "fail", "token_or_business_missing");
      record("data_api.direct_write_denied", "fail", "token_missing");
    }

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
    if (loggedIn && reader && reports) {
      readerToken = await authorize(pageA, publishableKey, reader, [
        "business.read",
        "reports.read",
      ]);
      reportsToken = await authorize(pageA, publishableKey, reports, [
        "reports.read",
      ]);
    }
    record(
      "mcp.consent",
      readerToken && reportsToken ? "pass" : "fail",
      readerToken && reportsToken ? "issued" : "not_issued",
    );
    if (tokenA && reader && reports && reportsToken) {
      const own = await rpc(publishableKey, reportsToken, "read_client_grant", {
        p_oauth_client_id: reports,
      });
      const other = await rpc(
        publishableKey,
        reportsToken,
        "read_client_grant",
        { p_oauth_client_id: reader },
      );
      const hidden =
        grantRows(own.json).length === 1 && grantRows(other.json).length === 0;
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
        denied.status === 403 && !body.includes(businessA ?? "missing-business")
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
      record("app.reports_only_business_denied", "fail", "grant_setup_missing");
    }

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
      const revoke = await pageA.request.post(`${SITE}/api/v1/grants/revoke`, {
        data: { clientId: reader },
        headers: { origin: SITE, accept: "application/json" },
      });
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
      const raw = await rpc(publishableKey, readerToken, "read_business", {});
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
    const opened = recoveryMail.verifyUrl
      ? await followVerify(recoveryContext, recoveryMail.verifyUrl, "recovery")
      : false;
    record(
      "mail.recovery",
      recoveryMail.status === "ready" && opened ? "pass" : "fail",
      recoveryMail.status,
    );
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
    record(
      "hosted.unhandled",
      "fail",
      error instanceof Error ? error.name : "error",
    );
  } finally {
    let removed = 0;
    for (const token of [cleanupA, cleanupB]) {
      if (!token) continue;
      const deleted = await jsonFetch(`${SUPABASE}/auth/v1/user`, {
        method: "DELETE",
        headers: {
          ...authHeaders(publishableKey),
          authorization: `Bearer ${token}`,
        },
      }).catch(() => ({ status: 0, json: null, location: "" }));
      if (deleted.status === 200 || deleted.status === 204) removed += 1;
    }
    record(
      "cleanup.auth_users",
      removed === 2 ? "pass" : "gap",
      `deleted_${removed}`,
    );
    record("cleanup.oauth_clients", "gap", "left_registered");
    await browser.close().catch(() => undefined);
  }
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
