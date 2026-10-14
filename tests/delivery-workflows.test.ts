import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { ENVIRONMENT_BINDINGS } from "@/server/config/environments";

interface Step {
  uses?: string;
  run?: string;
  env?: Record<string, string>;
}
interface Job {
  uses?: string;
  environment?: string | { name: string };
  env?: Record<string, string>;
  steps?: Step[];
  permissions?: Record<string, string>;
}
interface Workflow {
  on: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs: Record<string, Job>;
}

const WORKFLOW_DIR = ".github/workflows";
const raw = (file: string) => readFileSync(file, "utf8");
const load = (name: string) =>
  parse(raw(`${WORKFLOW_DIR}/${name}`)) as Workflow;
const environmentOf = (job: Job) =>
  typeof job.environment === "string" ? job.environment : job.environment?.name;
const workflowFiles = readdirSync(WORKFLOW_DIR).map(
  (f) => `${WORKFLOW_DIR}/${f}`,
);
const actionFiles = [".github/actions/setup/action.yml"];

describe("CI workflow", () => {
  const ci = load("ci.yml");

  it("runs on pull requests and as a reusable check, never with secrets", () => {
    expect(Object.keys(ci.on).sort()).toEqual([
      "pull_request",
      "workflow_call",
    ]);
    expect(ci.permissions).toEqual({ contents: "read" });
    expect(raw(`${WORKFLOW_DIR}/ci.yml`)).not.toMatch(/\$\{\{\s*secrets\./);
    expect(Object.values(ci.jobs).every((job) => !job.environment)).toBe(true);
  });

  it("covers lint, typecheck, tests, hygiene, build and audit", () => {
    const runs = Object.values(ci.jobs)
      .flatMap((job) => job.steps ?? [])
      .map((step) => step.run ?? "");
    for (const command of [
      "pnpm format:check",
      "pnpm lint",
      "pnpm typecheck",
      "pnpm test",
      "pnpm hygiene",
      "pnpm build",
      "pnpm hygiene --artifact .next",
      "pnpm audit --prod --audit-level=high",
    ]) {
      expect(runs).toContain(command);
    }
  });
});

describe("development deployment", () => {
  const workflow = load("deploy-development.yml");

  it("deploys only from main pushes or manual dispatch, after CI", () => {
    expect(workflow.on).toEqual({
      push: { branches: ["main"] },
      workflow_dispatch: null,
    });
    expect(workflow.jobs.checks?.uses).toBe("./.github/workflows/ci.yml");
  });

  it("targets the development binding through the development environment", () => {
    const deploy = workflow.jobs.deploy!;
    expect(environmentOf(deploy)).toBe("development");
    expect(deploy.env?.VERCEL_ORG_ID).toBe(
      ENVIRONMENT_BINDINGS.development.vercelTeamId,
    );
    expect(deploy.env?.VERCEL_PROJECT_ID).toBe(
      ENVIRONMENT_BINDINGS.development.vercelProjectId,
    );
    expect(deploy.env?.DEPLOY_ENVIRONMENT).toBe("development");
  });
});

describe("production release", () => {
  const workflow = load("release-production.yml");

  it("is only ever triggered manually", () => {
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
  });

  it("deploys only from the protected production environment after checks", () => {
    const release = workflow.jobs.release!;
    expect(environmentOf(release)).toBe("production");
    expect(release.env?.VERCEL_ORG_ID).toBe(
      ENVIRONMENT_BINDINGS.production.vercelTeamId,
    );
    expect(release.env?.VERCEL_PROJECT_ID).toBe(
      ENVIRONMENT_BINDINGS.production.vercelProjectId,
    );
    expect(workflow.jobs.checks?.uses).toBe("./.github/workflows/ci.yml");
    const runs = (release.steps ?? []).map((s) => s.run ?? "").join("\n");
    expect(runs).toContain('"$PRODUCTION_RELEASES_ENABLED" != "true"');
    expect(runs.indexOf("PRODUCTION_RELEASES_ENABLED")).toBeLessThan(
      runs.indexOf("vercel@"),
    );
  });

  it("requires the candidate to have passed the development deployment", () => {
    const runs = (workflow.jobs.candidate?.steps ?? [])
      .map((s) => s.run ?? "")
      .join("\n");
    expect(runs).toContain("merge-base --is-ancestor");
    expect(runs).toContain("deploy-development.yml/runs?head_sha=");
  });
});

describe("all workflows", () => {
  it("no workflow other than release-production can deploy to production", () => {
    for (const file of workflowFiles.filter(
      (f) => !f.endsWith("release-production.yml"),
    )) {
      const text = raw(file);
      expect(text).not.toContain(
        ENVIRONMENT_BINDINGS.production.vercelProjectId,
      );
      const jobs = Object.values((parse(text) as Workflow).jobs);
      expect(jobs.map(environmentOf)).not.toContain("production");
    }
  });

  it("only reference secrets from jobs bound to a GitHub environment", () => {
    for (const file of workflowFiles) {
      for (const [name, job] of Object.entries(
        load(file.split("/").pop()!).jobs,
      )) {
        if (!environmentOf(job)) {
          expect(JSON.stringify(job), `${file} job ${name}`).not.toMatch(
            /secrets\./,
          );
        }
      }
    }
  });

  it("never use pull_request_target or interpolate inputs into shell scripts", () => {
    for (const file of [...workflowFiles, ...actionFiles]) {
      const text = raw(file);
      expect(text).not.toContain("pull_request_target");
      const doc = parse(text) as {
        jobs?: Record<string, Job>;
        runs?: { steps: Step[] };
      };
      const steps = [
        ...Object.values(doc.jobs ?? {}).flatMap((job) => job.steps ?? []),
        ...(doc.runs?.steps ?? []),
      ];
      for (const step of steps) {
        expect(step.run ?? "", file).not.toMatch(
          /\$\{\{\s*(inputs|github\.event)\./,
        );
      }
    }
  });

  it("pin third-party actions to full commit SHAs and the Vercel CLI to an exact version", () => {
    for (const file of [...workflowFiles, ...actionFiles]) {
      for (const match of raw(file).matchAll(/uses:\s*([^\s#]+)/g)) {
        const ref = match[1]!;
        if (ref.startsWith("./")) continue;
        expect(ref, file).toMatch(/@[0-9a-f]{40}$/);
      }
      for (const match of raw(file).matchAll(/VERCEL_CLI_VERSION:\s*(\S+)/g)) {
        expect(match[1], file).toMatch(/^\d+\.\d+\.\d+$/);
      }
    }
  });
});

describe("Vercel project configuration", () => {
  it("disables Git-triggered deployments so only gated workflows deploy", () => {
    const config = JSON.parse(raw("vercel.json")) as {
      git?: { deploymentEnabled?: unknown };
    };
    expect(config.git?.deploymentEnabled).toBe(false);
  });
});
