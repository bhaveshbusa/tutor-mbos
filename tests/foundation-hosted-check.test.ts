import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { siteOriginFor } from "@/server/config/access";
import {
  DEVELOPMENT_SITE,
  businessesAreIsolated,
  grantRows,
  hostedCheckAllowed,
  publishableKeyFromPulled,
  revokedReadDenied,
  syntheticPassword,
  syntheticRecipient,
  trustedSupabaseUrl,
} from "../scripts/foundation-hosted-check";

describe("foundation hosted check helpers", () => {
  it("uses the development site origin", () => {
    expect(DEVELOPMENT_SITE).toBe(siteOriginFor("development"));
  });

  it("refuses to run outside the protected main workflow", () => {
    expect(hostedCheckAllowed({})).toBe(false);
    expect(
      hostedCheckAllowed({
        GITHUB_ACTIONS: "true",
        GITHUB_REF: "refs/heads/main",
        TUTOR_MBOS_ENV: "development",
      }),
    ).toBe(true);
  });

  it("rejects a sensitive placeholder publishable key", () => {
    expect(publishableKeyFromPulled({})).toBeNull();
    expect(
      publishableKeyFromPulled({
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "[SENSITIVE]",
      }),
    ).toBeNull();
    expect(
      publishableKeyFromPulled({
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_example",
      }),
    ).toBe("sb_publishable_example");
  });

  it("builds a receiving-domain address only for a numeric run id", () => {
    expect(syntheticRecipient("39106750935", "a")).toBe(
      "tos29-39106750935-a@weeveo.resend.app",
    );
    expect(syntheticRecipient("not-a-run", "b")).toBeNull();
    expect(syntheticPassword(Uint8Array.from([1, 2, 3, 4]))).toMatch(/^Aa1/);
  });

  it("treats two business rows as isolated and a revoked read as denied", () => {
    expect(
      businessesAreIsolated(
        [{ id: "11111111-1111-4111-8111-111111111111" }],
        [{ id: "22222222-2222-4222-8222-222222222222" }],
      ),
    ).toBe(true);
    expect(
      businessesAreIsolated(
        [{ id: "11111111-1111-4111-8111-111111111111" }],
        [{ id: "11111111-1111-4111-8111-111111111111" }],
      ),
    ).toBe(false);
    expect(grantRows([{ oauth_client_id: "client-a" }])).toEqual(["client-a"]);
    expect(revokedReadDenied(403, { detail: "forbidden" })).toBe(true);
    expect(revokedReadDenied(200, { business: { id: "x" } })).toBe(false);
  });

  it("rejects an authorization endpoint on another origin", () => {
    const origin = "https://idvzjqrkgnihvxoswuxu.supabase.co";
    expect(
      trustedSupabaseUrl(`${origin}/auth/v1/oauth/authorize`, origin)?.pathname,
    ).toBe("/auth/v1/oauth/authorize");
    expect(
      trustedSupabaseUrl("https://evil.example/authorize", origin),
    ).toBeNull();
  });
});

describe("foundation hosted check workflow", () => {
  const text = readFileSync(
    ".github/workflows/foundation-hosted-check.yml",
    "utf8",
  );
  const workflow = parse(text) as {
    on: Record<string, unknown>;
    jobs: Record<string, { environment?: string; steps?: { run?: string }[] }>;
  };

  it("is a manual development check and does not deploy", () => {
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    expect(workflow.jobs.check?.environment).toBe("development");
    expect(text).not.toContain("vercel deploy");
    expect(text).not.toContain("db push");
    expect(text).not.toContain("pull_request");
    expect(text).toContain("RESEND_DEVELOPMENT_RECEIVING_API_KEY");
    expect(text).toContain("Do not create a new key");
    const runs = (workflow.jobs.check?.steps ?? []).map(
      (step) => step.run ?? "",
    );
    expect(runs.join("\n")).not.toMatch(/--token\b|--protection-bypass\b/);
    expect(
      runs.some((run) =>
        run.includes("node scripts/foundation-hosted-check.ts"),
      ),
    ).toBe(true);
  });
});
