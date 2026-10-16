/**
 * Read-only development health probe. It sends the automation bypass only
 * to the reviewed development site origin and does not print the value.
 * A failure here is before the admin capability step, so the existing
 * recover command still applies. It does not mint a nonce or create users.
 */
import { pathToFileURL } from "node:url";
import { siteOriginFor } from "../src/server/config/access.ts";
import { ENVIRONMENT_BINDINGS } from "../src/server/config/environments.ts";
import { SERVICE_NAME } from "../src/server/application/service-status.ts";

export const DEVELOPMENT_HEALTH_STEP_NAME =
  "Verify development protection and health";

const SHA = /^[0-9a-f]{40}$/;
const BODY_LIMIT = 65_536;
const DEFAULT_TIMEOUT_MS = 15_000;

export interface DevelopmentHealthProbeInput {
  commit: string;
  bypass: string | undefined;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export async function probeDevelopmentHealth(
  input: DevelopmentHealthProbeInput,
): Promise<{ ok: true } | { ok: false; detail: string }> {
  if (!SHA.test(input.commit)) return { ok: false, detail: "commit_absent" };
  if (!input.bypass) return { ok: false, detail: "protection_bypass_absent" };

  const site = siteOriginFor("development");
  const url = new URL("/api/v1/health", `${site}/`);
  if (url.origin !== site) return { ok: false, detail: "origin_rejected" };

  const headers = new Headers({ accept: "application/json" });
  if (url.origin === site) {
    headers.set("x-vercel-protection-bypass", input.bypass);
  }

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  timer.unref?.();
  try {
    const response = await (input.fetchImpl ?? fetch)(url, {
      method: "GET",
      headers,
      redirect: "manual",
      signal: controller.signal,
    });
    if (
      response.status === 0 ||
      response.type === "opaqueredirect" ||
      (response.status >= 300 && response.status < 400)
    ) {
      return { ok: false, detail: `http_${response.status} redirect` };
    }
    const text = await response.text();
    const body = parseBody(text);
    const commit = typeof body?.commit === "string" ? body.commit : "";
    const commitState =
      commit.length === 0
        ? "absent"
        : commit === input.commit
          ? "match"
          : "mismatch";
    if (response.status !== 200 || body?.status !== "ok") {
      return {
        ok: false,
        detail: `http_${response.status} commit=${commitState}`,
      };
    }
    if (body.environment !== "development") {
      return { ok: false, detail: "environment_mismatch" };
    }
    if (
      body.supabaseProjectRef !==
      ENVIRONMENT_BINDINGS.development.supabaseProjectRef
    ) {
      return { ok: false, detail: "project_mismatch" };
    }
    if (body.service !== SERVICE_NAME || body.syntheticDataOnly !== true) {
      return { ok: false, detail: "health_shape" };
    }
    if (commitState !== "match") {
      return { ok: false, detail: `http_200 commit=${commitState}` };
    }
    return { ok: true };
  } catch (error) {
    if (controller.signal.aborted) {
      return { ok: false, detail: "request_timeout" };
    }
    return { ok: false, detail: error instanceof Error ? error.name : "Error" };
  } finally {
    clearTimeout(timer);
  }
}

function parseBody(text: string): Record<string, unknown> | undefined {
  if (text.length > BODY_LIMIT) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function mask(value: string | undefined): void {
  if (value && process.env.GITHUB_ACTIONS === "true") {
    console.log(`::add-mask::${value}`);
  }
}

async function main(): Promise<number> {
  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  mask(bypass);
  const result = await probeDevelopmentHealth({
    commit: process.env.GITHUB_SHA ?? "",
    bypass,
  });
  if (!result.ok) {
    console.error(`::error::${result.detail}`);
    if (result.detail === "http_401 commit=absent") {
      console.error(
        "::error::A loaded Protection Bypass for Automation value with http_401 commit=absent can be invalid or rotated. Copy the project's current tutor-mbos-dev value again.",
      );
    }
    return 1;
  }
  console.log("development_health=match");
  return 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = await main();
}
