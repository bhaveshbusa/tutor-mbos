import { describe, expect, it } from "vitest";
import {
  checkDeployTarget,
  developmentSetupGaps,
  parseDotenv,
} from "../scripts/assert-deploy-target.ts";
import {
  checkHealthPayload,
  fetchProjectAutomationBypass,
  resolveProtectionBypass,
  selectAutomationBypass,
} from "../scripts/smoke-health.ts";
import {
  ENVIRONMENT_BINDINGS,
  supabaseUrlFor,
} from "@/server/config/environments";

const dev = ENVIRONMENT_BINDINGS.development;
const prod = ENVIRONMENT_BINDINGS.production;
const devLink = { orgId: dev.vercelTeamId, projectId: dev.vercelProjectId };
const prodLink = { orgId: prod.vercelTeamId, projectId: prod.vercelProjectId };
const devEnv = {
  TUTOR_MBOS_ENV: "development",
  NEXT_PUBLIC_SUPABASE_URL: supabaseUrlFor(dev.supabaseProjectRef),
};
const prodEnv = {
  TUTOR_MBOS_ENV: "production",
  NEXT_PUBLIC_SUPABASE_URL: supabaseUrlFor(prod.supabaseProjectRef),
};

describe("checkDeployTarget", () => {
  it("accepts the reviewed project and configuration for each environment", () => {
    expect(
      checkDeployTarget("development", [devLink, devLink], devEnv),
    ).toEqual([]);
    expect(checkDeployTarget("production", [prodLink], prodEnv)).toEqual([]);
  });

  it("rejects deploying development with the production project linked", () => {
    expect(checkDeployTarget("development", [prodLink], devEnv)).toEqual([
      "Linked Vercel project is not tutor-mbos-dev (development).",
    ]);
  });

  it("rejects production settings pulled into a development deploy", () => {
    expect(checkDeployTarget("development", [devLink], prodEnv)).toEqual([
      "TUTOR_MBOS_ENV: binding_mismatch (expected development)",
    ]);
  });

  it("rejects a development deploy pointed at the production database", () => {
    expect(
      checkDeployTarget("development", [devLink], {
        ...devEnv,
        NEXT_PUBLIC_SUPABASE_URL: prodEnv.NEXT_PUBLIC_SUPABASE_URL,
      }),
    ).toEqual(["NEXT_PUBLIC_SUPABASE_URL: binding_mismatch"]);
  });

  it("rejects missing links, missing settings and unknown environments", () => {
    expect(checkDeployTarget("development", [{}], {})).toEqual([
      "Linked Vercel team is not the reviewed development team.",
      "Linked Vercel project is not tutor-mbos-dev (development).",
      "TUTOR_MBOS_ENV: missing",
      "NEXT_PUBLIC_SUPABASE_URL: missing",
    ]);
    expect(checkDeployTarget("staging", [devLink], devEnv)).toEqual([
      'Unknown deployment environment "staging".',
    ]);
  });
});

describe("developmentSetupGaps", () => {
  it("names the Vercel location when promotion configuration is absent", () => {
    expect(developmentSetupGaps({})).toEqual([
      "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY is absent. Set it at Vercel project tutor-mbos-dev → Settings → Environment Variables → Production.",
    ]);
    expect(
      developmentSetupGaps({
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "configured",
      }),
    ).toEqual([]);
  });
});

describe("parseDotenv", () => {
  it("parses Vercel pulled environment files", () => {
    expect(
      parseDotenv(
        '# Created by Vercel CLI\nTUTOR_MBOS_ENV="development"\nNEXT_PUBLIC_SUPABASE_URL="https://x.supabase.co"\nEMPTY=""\nRAW=value\n',
      ),
    ).toEqual({
      TUTOR_MBOS_ENV: "development",
      NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co",
      EMPTY: "",
      RAW: "value",
    });
  });
});

describe("checkHealthPayload", () => {
  const commit = "0123456789abcdef0123456789abcdef01234567";
  const healthy = {
    status: "ok",
    environment: "development",
    supabaseProjectRef: dev.supabaseProjectRef,
    commit,
  };

  it("accepts the expected deployment", () => {
    expect(
      checkHealthPayload(200, healthy, { environment: "development", commit }),
    ).toEqual([]);
  });

  it("rejects a stale commit, wrong environment, wrong database or error status", () => {
    expect(
      checkHealthPayload(
        200,
        { ...healthy, commit: "f".repeat(40) },
        { environment: "development", commit },
      ),
    ).toHaveLength(1);
    expect(
      checkHealthPayload(200, healthy, { environment: "production", commit }),
    ).toHaveLength(2);
    expect(
      checkHealthPayload(
        200,
        { ...healthy, supabaseProjectRef: prod.supabaseProjectRef },
        { environment: "development", commit },
      ),
    ).toEqual(["Supabase project does not match the reviewed binding."]);
    expect(
      checkHealthPayload(401, undefined, { environment: "development", commit })
        .length,
    ).toBeGreaterThan(1);
  });
});

describe("deployment protection bypass", () => {
  const SYNTHETIC_BYPASS = "synthetic-bypass-value";
  const project = {
    protectionBypass: {
      "synthetic-share-link": { scope: "shareable-link" },
      [SYNTHETIC_BYPASS]: { scope: "automation-bypass" },
    },
  };
  const fakeFetch = (ok: boolean, body: unknown) => {
    const calls: {
      url: URL;
      method: string;
      headers: Record<string, string>;
    }[] = [];
    const impl = async (
      url: URL,
      init: { method: string; headers: Record<string, string> },
    ) => {
      calls.push({ url, ...init });
      return { ok, json: async () => body };
    };
    return { impl, calls };
  };
  const env = {
    VERCEL_TOKEN: "synthetic-token",
    VERCEL_PROJECT_ID: "prj_synthetic",
    VERCEL_ORG_ID: "team_synthetic",
  };

  it("selects only the automation bypass", () => {
    expect(selectAutomationBypass(project)).toBe(SYNTHETIC_BYPASS);
    expect(
      selectAutomationBypass({
        protectionBypass: { other: { scope: "shareable-link" } },
      }),
    ).toBeUndefined();
    expect(selectAutomationBypass(undefined)).toBeUndefined();
  });

  it("reads the project's existing bypass with a GET, never creating one", async () => {
    const { impl, calls } = fakeFetch(true, project);
    const value = await fetchProjectAutomationBypass({
      token: env.VERCEL_TOKEN,
      projectId: env.VERCEL_PROJECT_ID,
      teamId: env.VERCEL_ORG_ID,
      fetchImpl: impl,
    });
    expect(value).toBe(SYNTHETIC_BYPASS);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url.pathname).toBe("/v9/projects/prj_synthetic");
    expect(calls[0]!.url.searchParams.get("teamId")).toBe("team_synthetic");
    expect(calls[0]!.headers.authorization).toBe("Bearer synthetic-token");
  });

  it("prefers the token-authenticated project bypass over the fallback secret", async () => {
    const { impl } = fakeFetch(true, project);
    await expect(
      resolveProtectionBypass(
        { ...env, VERCEL_AUTOMATION_BYPASS_SECRET: "synthetic-fallback" },
        impl,
      ),
    ).resolves.toEqual({ source: "project", value: SYNTHETIC_BYPASS });
  });

  it("falls back to the bypass secret, then to no bypass", async () => {
    const failing = fakeFetch(false, {});
    await expect(
      resolveProtectionBypass(
        { ...env, VERCEL_AUTOMATION_BYPASS_SECRET: "synthetic-fallback" },
        failing.impl,
      ),
    ).resolves.toEqual({
      source: "fallback-secret",
      value: "synthetic-fallback",
    });
    const unused = fakeFetch(true, project);
    await expect(resolveProtectionBypass({}, unused.impl)).resolves.toEqual({
      source: "none",
    });
    await expect(
      resolveProtectionBypass({ VERCEL_AUTOMATION_BYPASS_SECRET: "" }),
    ).resolves.toEqual({ source: "none" });
    expect(unused.calls).toHaveLength(0);
  });
});
