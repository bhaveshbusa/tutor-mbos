import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
  if?: string;
  environment?: string | { name: string };
  env?: Record<string, string>;
  outputs?: Record<string, string>;
  steps?: Step[];
  permissions?: Record<string, string>;
  secrets?: Record<string, string> | string;
}
interface Workflow {
  on: Record<string, unknown>;
  permissions?: Record<string, string>;
  concurrency?: {
    group?: string;
    "cancel-in-progress"?: boolean;
    queue?: string;
  };
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

function detectScript(workflow: Workflow): string {
  const changes = workflow.jobs.changes;
  const detect = (changes?.steps ?? []).find((step) =>
    (step.run ?? "").includes("git diff --quiet"),
  );
  return detect?.run ?? "";
}

function migrationInputPaths(script: string): string[] {
  const block =
    script.split("git diff --quiet")[1]?.split("diff_status")[0] ?? "";
  return block
    .split("\n")
    .map((line) => line.trim().replace(/\\$/, "").trim())
    .filter((line) => line.length > 0 && line !== "--" && !line.includes("$"));
}

interface DetectRepo {
  dir: string;
  base: string;
  side: string;
}

function git(cwd: string, args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "advice.detachedHead=false",
      "-c",
      "init.defaultBranch=main",
      ...args,
    ],
    {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "detect-test",
        GIT_AUTHOR_EMAIL: "detect-test@example.com",
        GIT_COMMITTER_NAME: "detect-test",
        GIT_COMMITTER_EMAIL: "detect-test@example.com",
      },
    },
  )
    .toString()
    .trim();
}

function initDetectRepo(inputs: string[]): DetectRepo {
  const dir = mkdtempSync(join(tmpdir(), "migrate-detect-"));
  git(dir, ["init"]);
  for (const path of inputs) writeRepoFile(dir, touchedFile(path), "base\n");
  writeRepoFile(dir, "README.md", "docs\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "base"]);
  const base = git(dir, ["rev-parse", "HEAD"]);
  git(dir, ["checkout", "--orphan", "side"]);
  git(dir, ["commit", "--allow-empty", "-m", "side"]);
  const side = git(dir, ["rev-parse", "HEAD"]);
  git(dir, ["checkout", base]);
  return { dir, base, side };
}

function touchedFile(path: string): string {
  return path.split("/").pop()?.includes(".") ? path : join(path, "keep");
}

function writeRepoFile(dir: string, path: string, contents: string): void {
  const full = join(dir, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents);
}

function commitFile(
  repo: DetectRepo,
  base: string,
  path: string,
  contents: string,
): string {
  git(repo.dir, ["checkout", base]);
  writeRepoFile(repo.dir, path, contents);
  git(repo.dir, ["add", path]);
  git(repo.dir, ["commit", "-m", path]);
  return git(repo.dir, ["rev-parse", "HEAD"]);
}

function runDetect(
  repo: DetectRepo,
  script: string,
  options: { event: string; sha: string; stub?: string; stubExit?: number },
): string {
  const bin = join(repo.dir, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "gh"),
    '#!/bin/sh\nif [ "${GH_STUB_EXIT:-0}" != "0" ]; then exit "$GH_STUB_EXIT"; fi\nprintf \'%s\' "${GH_STUB_OUT-}"\n',
  );
  execFileSync("chmod", ["755", join(bin, "gh")]);
  const output = join(repo.dir, "github-output");
  writeFileSync(output, "");
  const scriptPath = join(repo.dir, "detect.sh");
  writeFileSync(scriptPath, script);
  execFileSync("bash", ["-e", scriptPath], {
    cwd: repo.dir,
    env: {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      NODE_ENV: "test",
      EVENT_NAME: options.event,
      GITHUB_SHA: options.sha,
      GITHUB_OUTPUT: output,
      GITHUB_REPOSITORY: "example/repo",
      GH_STUB_OUT: options.stub ?? "",
      GH_STUB_EXIT: String(options.stubExit ?? 0),
      HOME: repo.dir,
    },
  });
  const recorded = readFileSync(output, "utf8").match(
    /^migrate=(true|false)$/m,
  );
  return recorded?.[1] ?? "";
}

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

  it("deploys only from main pushes or manual dispatch, after CI, preflight and migrations", () => {
    expect(workflow.on).toEqual({
      push: { branches: ["main"] },
      workflow_dispatch: null,
    });
    expect(workflow.jobs.checks?.uses).toBe("./.github/workflows/ci.yml");
    expect(workflow.jobs.preflight?.needs).toBe("checks");
    expect(environmentOf(workflow.jobs.preflight!)).toBe("development");
    expect(workflow.jobs.migrate?.needs).toEqual(["preflight", "changes"]);
    expect(workflow.jobs.migrate?.if).toBe(
      "needs.changes.outputs.migrate == 'true'",
    );
    expect(workflow.jobs.migrate?.uses).toBe(
      "./.github/workflows/apply-development-migrations.yml",
    );
    expect(workflow.jobs.deploy?.needs).toEqual([
      "preflight",
      "changes",
      "migrate",
    ]);
    expect(workflow.jobs.deploy?.if).toBe(
      "${{ !cancelled() && needs.changes.result == 'success' && needs.preflight.result == 'success' && (needs.migrate.result == 'success' || (needs.migrate.result == 'skipped' && needs.changes.outputs.migrate == 'false')) }}",
    );
    expect(workflow.concurrency).toEqual({
      group: "development-delivery",
      "cancel-in-progress": false,
      queue: "max",
    });
    const preflightRuns = (workflow.jobs.preflight?.steps ?? [])
      .map((step) => step.run ?? "")
      .join("\n");
    expect(preflightRuns.indexOf("VERCEL_TOKEN")).toBeLessThan(
      preflightRuns.indexOf("scripts/assert-deploy-target.ts"),
    );
    expect(preflightRuns).not.toContain("migrate:development");
    expect(preflightRuns).not.toMatch(/\bdeploy\s+--prebuilt/);
  });

  it("runs migrations only when migration inputs changed since the last successful delivery", () => {
    const changes = workflow.jobs.changes!;
    expect(environmentOf(changes)).toBeUndefined();
    expect(changes.permissions).toEqual({
      contents: "read",
      actions: "read",
    });
    expect(changes.outputs?.migrate).toBe(
      "${{ steps.detect.outputs.migrate }}",
    );
    expect(JSON.stringify(changes)).not.toMatch(/secrets\./);
    const detect = (changes.steps ?? []).find((step) =>
      (step.run ?? "").includes("git diff --quiet"),
    );
    expect(detect?.env?.GH_TOKEN).toBe("${{ github.token }}");
    expect(detect?.env?.EVENT_NAME).toBe("${{ github.event_name }}");
    const script = detect?.run ?? "";
    expect(script).toContain(
      'if [ "$EVENT_NAME" = "workflow_dispatch" ]; then',
    );
    expect(script).toContain(
      "repos/${GITHUB_REPOSITORY}/actions/workflows/deploy-development.yml/runs?branch=main&status=success&per_page=1",
    );
    expect(script).toContain(
      'git merge-base --is-ancestor "$base" "$GITHUB_SHA"',
    );
    expect(script).not.toContain("github.event.before");
    expect(migrationInputPaths(script)).toEqual([
      "supabase/migrations",
      "scripts",
      "src",
      ".github/workflows/apply-development-migrations.yml",
      ".github/actions/setup",
      "package.json",
      "pnpm-lock.yaml",
      ".nvmrc",
    ]);
    expect(raw(`${WORKFLOW_DIR}/deploy-development.yml`)).not.toContain(
      "paths-ignore",
    );
    expect(raw(`${WORKFLOW_DIR}/migrate-development.yml`)).not.toContain(
      "needs.changes.outputs.migrate",
    );
  });

  it("decides migrate from the workflow script", () => {
    const script = detectScript(workflow);
    const inputs = migrationInputPaths(script);
    const repo = initDetectRepo(inputs);
    const docs = commitFile(repo, repo.base, "README.md", "changed docs\n");
    expect(
      runDetect(repo, script, { event: "push", sha: docs, stub: repo.base }),
    ).toBe("false");
    expect(
      runDetect(repo, script, {
        event: "workflow_dispatch",
        sha: docs,
        stub: repo.base,
      }),
    ).toBe("true");
    expect(
      runDetect(repo, script, { event: "push", sha: docs, stubExit: 1 }),
    ).toBe("true");
    expect(
      runDetect(repo, script, { event: "push", sha: docs, stub: "" }),
    ).toBe("true");
    expect(
      runDetect(repo, script, { event: "push", sha: docs, stub: "not-a-sha" }),
    ).toBe("true");
    expect(
      runDetect(repo, script, {
        event: "push",
        sha: docs,
        stub: "a".repeat(40),
      }),
    ).toBe("true");
    expect(
      runDetect(repo, script, { event: "push", sha: docs, stub: repo.side }),
    ).toBe("true");
    for (const path of inputs) {
      const changed = commitFile(
        repo,
        repo.base,
        touchedFile(path),
        "changed\n",
      );
      expect(
        runDetect(repo, script, {
          event: "push",
          sha: changed,
          stub: repo.base,
        }),
        path,
      ).toBe("true");
    }
  }, 60_000);

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
    expect(workflow.concurrency).toEqual({
      group: "development-delivery",
      "cancel-in-progress": false,
      queue: "max",
    });
    expect(
      raw(`${WORKFLOW_DIR}/apply-development-migrations.yml`),
    ).not.toContain("concurrency:");
  });

  it("uses the development environment and stops before any SQL when secrets are absent", () => {
    const migrate = applied.jobs.migrate!;
    expect(environmentOf(migrate)).toBe("development");
    const call = applied.on.workflow_call as {
      secrets?: Record<string, { required?: boolean }>;
    };
    expect(Object.keys(applied.on)).toEqual(["workflow_call"]);
    expect(call.secrets).toEqual({
      SUPABASE_MIGRATION_DATABASE_URL: { required: true },
      APP_RUNTIME_PASSWORD: { required: true },
    });
    const runs = (migrate.steps ?? []).map((step) => step.run ?? "").join("\n");
    expect(runs).toContain(
      "SUPABASE_MIGRATION_DATABASE_URL is absent. Expected secret scope: GitHub environment development",
    );
    expect(runs).toContain(
      "APP_RUNTIME_PASSWORD is absent. Expected secret scope: GitHub environment development",
    );
    expect(runs).toContain("SUPABASE_MIGRATION_DATABASE_URL is present.");
    expect(runs).toContain("APP_RUNTIME_PASSWORD is present.");
    expect(runs).not.toContain("||");
    expect(runs).not.toMatch(
      /echo\s+["']\$\{?(SUPABASE_MIGRATION_DATABASE_URL|APP_RUNTIME_PASSWORD)/,
    );
    expect(runs).not.toMatch(/\b(printenv|env|sha256sum|wc)\b/);
    expect(runs.indexOf("is absent")).toBeLessThan(
      runs.indexOf("pnpm migrate:development"),
    );
    expect(runs).not.toContain("vercel");
  });

  it("forwards only the two development migration secrets by name", () => {
    const forwarded = {
      SUPABASE_MIGRATION_DATABASE_URL:
        "${{ secrets.SUPABASE_MIGRATION_DATABASE_URL }}",
      APP_RUNTIME_PASSWORD: "${{ secrets.APP_RUNTIME_PASSWORD }}",
    };
    for (const file of ["deploy-development.yml", "migrate-development.yml"]) {
      const caller = load(file).jobs.migrate!;
      expect(caller.uses, file).toBe(
        "./.github/workflows/apply-development-migrations.yml",
      );
      expect(environmentOf(caller), file).toBeUndefined();
      expect(caller.secrets, file).toEqual(forwarded);
      expect(JSON.stringify(caller), file).not.toContain("inherit");
      expect(JSON.stringify(caller), file).not.toContain("VERCEL_TOKEN");
    }
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
          const forwardedMigration =
            job.uses ===
              "./.github/workflows/apply-development-migrations.yml" &&
            name === "migrate";
          if (forwardedMigration) {
            expect(job.secrets, `${file} job ${name}`).toEqual({
              SUPABASE_MIGRATION_DATABASE_URL:
                "${{ secrets.SUPABASE_MIGRATION_DATABASE_URL }}",
              APP_RUNTIME_PASSWORD: "${{ secrets.APP_RUNTIME_PASSWORD }}",
            });
            continue;
          }
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
