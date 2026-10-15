/**
 * Post-deploy smoke test: GET /api/v1/health on the deployed URL and confirm
 * it reports the expected environment, Supabase binding and source commit.
 *
 * Protected deployments are reached with the project's existing automation
 * bypass, read in-process with VERCEL_TOKEN (never passed on a command line,
 * never created here). VERCEL_AUTOMATION_BYPASS_SECRET is a fallback only.
 */
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  ENVIRONMENT_BINDINGS,
  type DeploymentEnvironment,
} from "../src/server/config/environments.ts";

export interface SmokeExpectation {
  environment: string;
  commit: string;
}

export function checkHealthPayload(
  status: number,
  payload: unknown,
  expected: SmokeExpectation,
): string[] {
  const errors: string[] = [];
  if (status !== 200) errors.push(`Expected HTTP 200, received ${status}.`);
  const body = (payload ?? {}) as Record<string, unknown>;
  if (body.status !== "ok") errors.push(`Expected status "ok".`);
  if (body.environment !== expected.environment) {
    errors.push(`Expected environment "${expected.environment}".`);
  }
  const binding = Object.hasOwn(ENVIRONMENT_BINDINGS, expected.environment)
    ? ENVIRONMENT_BINDINGS[expected.environment as DeploymentEnvironment]
    : undefined;
  if (!binding || body.supabaseProjectRef !== binding.supabaseProjectRef) {
    errors.push("Supabase project does not match the reviewed binding.");
  }
  if (body.commit !== expected.commit) {
    errors.push(`Expected commit ${expected.commit}.`);
  }
  return errors;
}

type FetchLike = (
  input: URL,
  init: { method: string; headers: Record<string, string> },
) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

export function selectAutomationBypass(project: unknown): string | undefined {
  const bypasses =
    (project as { protectionBypass?: Record<string, { scope?: unknown }> })
      ?.protectionBypass ?? {};
  return Object.entries(bypasses).find(
    ([, entry]) => entry?.scope === "automation-bypass",
  )?.[0];
}

export async function fetchProjectAutomationBypass(options: {
  token: string;
  projectId: string;
  teamId: string;
  fetchImpl?: FetchLike;
}): Promise<string | undefined> {
  const url = new URL(
    `https://api.vercel.com/v9/projects/${encodeURIComponent(options.projectId)}`,
  );
  url.searchParams.set("teamId", options.teamId);
  const response = await (options.fetchImpl ?? fetch)(url, {
    method: "GET",
    headers: { authorization: `Bearer ${options.token}` },
  });
  if (!response.ok) return undefined;
  return selectAutomationBypass(await response.json().catch(() => undefined));
}

export type BypassSource = "project" | "fallback-secret" | "none";

export async function resolveProtectionBypass(
  env: Record<string, string | undefined>,
  fetchImpl?: FetchLike,
): Promise<{ source: BypassSource; value?: string }> {
  const { VERCEL_TOKEN, VERCEL_PROJECT_ID, VERCEL_ORG_ID } = env;
  if (VERCEL_TOKEN && VERCEL_PROJECT_ID && VERCEL_ORG_ID) {
    const value = await fetchProjectAutomationBypass({
      token: VERCEL_TOKEN,
      projectId: VERCEL_PROJECT_ID,
      teamId: VERCEL_ORG_ID,
      fetchImpl,
    }).catch(() => undefined);
    if (value) return { source: "project", value };
  }
  const fallback = env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (fallback) return { source: "fallback-secret", value: fallback };
  return { source: "none" };
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      "base-url": { type: "string" },
      environment: { type: "string" },
      commit: { type: "string" },
      attempts: { type: "string", default: "10" },
    },
  });
  const baseUrl = values["base-url"];
  const environment = values.environment;
  const commit = values.commit;
  if (!baseUrl || !environment || !commit) {
    console.error(
      "Usage: smoke-health.ts --base-url URL --environment ENV --commit SHA",
    );
    return 2;
  }
  const url = new URL(
    "/api/v1/health",
    baseUrl.startsWith("http") ? baseUrl : `https://${baseUrl}`,
  );
  const headers: Record<string, string> = { accept: "application/json" };
  const bypass = await resolveProtectionBypass(process.env);
  if (bypass.value) {
    if (process.env.GITHUB_ACTIONS === "true") {
      console.log(`::add-mask::${bypass.value}`);
    }
    headers["x-vercel-protection-bypass"] = bypass.value;
  }
  console.log(`Deployment protection bypass: ${bypass.source}.`);

  let errors: string[] = ["No attempt made."];
  const attempts = Number(values.attempts);
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, { headers, redirect: "manual" });
      const payload: unknown = await response.json().catch(() => undefined);
      errors = checkHealthPayload(response.status, payload, {
        environment,
        commit,
      });
    } catch (error) {
      errors = [`Request failed: ${(error as Error).name}`];
    }
    if (errors.length === 0) {
      console.log(
        `Smoke test passed: ${url.origin} serves ${environment} at ${commit}.`,
      );
      return 0;
    }
    console.log(`Attempt ${attempt}/${attempts}: ${errors.join(" ")}`);
    if (attempt < attempts) await new Promise((r) => setTimeout(r, 6000));
  }
  for (const error of errors) console.error(`::error::${error}`);
  return 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = await main();
}
