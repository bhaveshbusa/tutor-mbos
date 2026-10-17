/**
 * Run after `vercel pull` in a deploy job. Confirms the linked Vercel team and
 * project and the pulled runtime configuration match the reviewed binding for
 * the requested environment, so credentials or settings for one environment
 * can never build or deploy another. Prints variable names and codes only.
 */
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  ENVIRONMENT_BINDINGS,
  loadRuntimeConfig,
  type DeploymentEnvironment,
} from "../src/server/config/environments.ts";

export interface LinkedProject {
  orgId?: string;
  projectId?: string;
}

export function parseDotenv(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match =
      /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!match?.[1]) continue;
    let value = match[2] ?? "";
    const quote = value[0];
    if (
      (quote === '"' || quote === "'") &&
      value.endsWith(quote) &&
      value.length >= 2
    ) {
      value = value.slice(1, -1);
      if (quote === '"')
        value = value.replace(/\\n/g, "\n").replace(/\\"/g, '"');
    }
    values[match[1]] = value;
  }
  return values;
}

function isDeploymentEnvironment(
  value: string,
): value is DeploymentEnvironment {
  return Object.hasOwn(ENVIRONMENT_BINDINGS, value);
}

const DEVELOPMENT_RUNTIME_LOCATION =
  "Vercel project tutor-mbos-dev → Settings → Environment Variables → Production";

/**
 * Names required before development migrations or promotion. Values are not
 * read. A Secret-type value pulled as `[SENSITIVE]` still counts as present.
 * Absence fails the development preflight before hosted SQL and promotion.
 */
export function developmentSetupGaps(
  pulledEnv: Record<string, string | undefined>,
): string[] {
  const gaps: string[] = [];
  const absent = (name: string) => !pulledEnv[name]?.trim();
  if (absent("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY")) {
    gaps.push(
      `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY is absent. Set it at ${DEVELOPMENT_RUNTIME_LOCATION}.`,
    );
  }
  return gaps;
}

export function checkDeployTarget(
  expected: string,
  linked: LinkedProject[],
  pulledEnv: Record<string, string | undefined>,
): string[] {
  if (!isDeploymentEnvironment(expected)) {
    return [`Unknown deployment environment "${expected}".`];
  }
  const binding = ENVIRONMENT_BINDINGS[expected];
  const errors: string[] = [];
  for (const project of linked) {
    if (project.orgId !== binding.vercelTeamId) {
      errors.push(`Linked Vercel team is not the reviewed ${expected} team.`);
    }
    if (project.projectId !== binding.vercelProjectId) {
      errors.push(
        `Linked Vercel project is not ${binding.vercelProjectName} (${expected}).`,
      );
    }
  }
  const result = loadRuntimeConfig(pulledEnv);
  if (!result.ok) {
    for (const issue of result.issues) {
      errors.push(`${issue.variable}: ${issue.code}`);
    }
  } else if (result.config.environment !== expected) {
    errors.push(`TUTOR_MBOS_ENV: binding_mismatch (expected ${expected})`);
  }
  return errors;
}

function main(argv: string[]): number {
  const expected = argv[0] ?? "";
  const linked: LinkedProject[] = [
    {
      orgId: process.env.VERCEL_ORG_ID,
      projectId: process.env.VERCEL_PROJECT_ID,
    },
  ];
  if (existsSync(".vercel/project.json")) {
    linked.push(
      JSON.parse(readFileSync(".vercel/project.json", "utf8")) as LinkedProject,
    );
  }
  const envFile = ".vercel/.env.production.local";
  const pulled = existsSync(envFile)
    ? parseDotenv(readFileSync(envFile, "utf8"))
    : {};
  const errors = checkDeployTarget(expected, linked, pulled);
  if (expected === "development") {
    errors.push(...developmentSetupGaps(pulled));
  }
  if (errors.length === 0) {
    console.log(`Deployment target verified for ${expected}.`);
    return 0;
  }
  for (const error of errors) console.error(`::error::${error}`);
  return 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = main(process.argv.slice(2));
}
