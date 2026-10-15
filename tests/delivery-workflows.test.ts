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
  needs?: string | string[];
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

  it("deploys only from main pushes or manual dispatch, after CI and migrations", () => {
    expect(workflow.on).toEqual({
      push: { branches: ["main"] },
      workflow_dispatch: null,
    });
    expect(workflow.jobs.checks?.uses).toBe("./.github/workflows/ci.yml");
    expect(workflow.jobs.migrate?.needs).toBe("checks");
    expect(workflow.jobs.migrate?.uses).toBe(
      "./.github/workflows/apply-development-migrations.yml",
    );
    expect(workflow.jobs.deploy?.needs).toBe("migrate");
    expect(raw(`${WORKFLOW_DIR}/deploy-development.yml`)).toContain(
      "group: development-delivery",
    );
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

describe("development migration recovery", () => {
  const workflow = load("migrate-development.yml");
  const applied = load("apply-development-migrations.yml");

  it("is a manual recovery entry serialized with development delivery", () => {
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    expect(workflow.jobs.migrate?.uses).toBe(
      "./.github/workflows/apply-development-migrations.yml",
    );
    expect(raw(`${WORKFLOW_DIR}/migrate-development.yml`)).toContain(
      "group: development-delivery",
    );
    expect(
      raw(`${WORKFLOW_DIR}/apply-development-migrations.yml`),
    ).not.toContain("concurrency:");
  });

  it("uses the development environment and stops before any SQL when secrets are absent", () => {
    const migrate = applied.jobs.migrate!;
    expect(environmentOf(migrate)).toBe("development");
    expect(Object.keys(applied.on)).toEqual(["workflow_call"]);
    const runs = (migrate.steps ?? []).map((step) => step.run ?? "").join("\n");
    expect(runs).toContain(
      "GitHub → Settings → Environments → development → Secrets",
    );
    expect(runs.indexOf("SUPABASE_MIGRATION_DATABASE_URL")).toBeLessThan(
      runs.indexOf("pnpm migrate:development"),
    );
    expect(runs).not.toContain("vercel");
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

describe("deployment credentials and promotion", () => {
  const deployJobs = {
    "deploy-development.yml": load("deploy-development.yml").jobs.deploy!,
    "release-production.yml": load("release-production.yml").jobs.release!,
  };
  const runOf = (step: Step) => step.run ?? "";

  it("never pass tokens or bypass secrets on a command line", () => {
    for (const file of [...workflowFiles, ...actionFiles]) {
      const doc = parse(raw(file)) as {
        jobs?: Record<string, Job>;
        runs?: { steps: Step[] };
      };
      const steps = [
        ...Object.values(doc.jobs ?? {}).flatMap((job) => job.steps ?? []),
        ...(doc.runs?.steps ?? []),
      ];
      for (const step of steps) {
        expect(runOf(step), file).not.toMatch(/--token\b|-t\s+\$/);
        expect(runOf(step), file).not.toMatch(/--protection-bypass\b/);
      }
    }
  });

  for (const [file, job] of Object.entries(deployJobs)) {
    describe(file, () => {
      const steps = job.steps ?? [];
      const indexOf = (predicate: (step: Step) => boolean) =>
        steps.findIndex(predicate);

      it("keeps VERCEL_TOKEN out of the job environment and the build step", () => {
        expect(job.env ?? {}).not.toHaveProperty("VERCEL_TOKEN");
        const builds = steps.filter((step) =>
          /vercel@\S*\s+build\b/.test(runOf(step)),
        );
        expect(builds).toHaveLength(1);
        for (const build of builds) {
          expect(JSON.stringify(build)).not.toContain("VERCEL_TOKEN");
        }
      });

      it("deploys without promoting, smoke tests, then promotes", () => {
        const deploys = steps.filter((step) =>
          /\bdeploy\s+--prebuilt/.test(runOf(step)),
        );
        expect(deploys).toHaveLength(1);
        expect(runOf(deploys[0]!)).toContain("--skip-domain");
        const deploy = indexOf((step) => step === deploys[0]);
        const smoke = indexOf(
          (step) =>
            runOf(step).includes("scripts/smoke-health.ts") &&
            runOf(step).includes('"$DEPLOYMENT_URL"'),
        );
        const promote = indexOf((step) =>
          /\bpromote\s+"\$DEPLOYMENT_URL"/.test(runOf(step)),
        );
        expect(deploy).toBeGreaterThanOrEqual(0);
        expect(smoke).toBeGreaterThan(deploy);
        expect(promote).toBeGreaterThan(smoke);
        expect(steps[smoke]!.env?.DEPLOYMENT_URL).toBe(
          "${{ steps.deploy.outputs.url }}",
        );
      });
    });
  }
});

describe("Vercel project configuration", () => {
  it("disables Git-triggered deployments so only gated workflows deploy", () => {
    const config = JSON.parse(raw("vercel.json")) as {
      git?: { deploymentEnabled?: unknown };
    };
    expect(config.git?.deploymentEnabled).toBe(false);
  });
});
