import { describe, expect, it } from "vitest";
import {
  checkDeployTarget,
  parseDotenv,
} from "../scripts/assert-deploy-target.ts";
import { checkHealthPayload } from "../scripts/smoke-health.ts";
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
