import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { siteOriginFor } from "@/server/config/access";
import {
  DEVELOPMENT_SITE,
  businessesAreIsolated,
  failureDetail,
  grantRows,
  hostedCheckAllowed,
  publishableKeyFromPulled,
  revokedReadDenied,
  syntheticPassword,
  syntheticRecipient,
  trustedSupabaseUrl,
  HOSTED_CASES,
  confirmationOutcome,
  confirmationRedirect,
  continueAfter,
  recoveryLanding,
  unreachedCases,
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

describe("foundation hosted check confirmation", () => {
  const site = DEVELOPMENT_SITE;
  const callback = `${site}/auth/callback`;

  it("accepts the implicit-flow redirect to the site callback", () => {
    expect(
      confirmationRedirect(
        303,
        `${callback}#access_token=a&refresh_token=r&type=signup`,
        site,
      ),
    ).toBe("redirected");
  });

  it("rejects Auth error redirects in the fragment or the query", () => {
    expect(
      confirmationRedirect(
        303,
        `${callback}#error=access_denied&error_code=otp_expired`,
        site,
      ),
    ).toBe("auth_error");
    expect(
      confirmationRedirect(
        302,
        `${callback}?error_description=expired#access_token=a`,
        site,
      ),
    ).toBe("auth_error");
  });

  it("rejects an empty or missing session and HTTP errors", () => {
    expect(confirmationRedirect(303, `${callback}#access_token=`, site)).toBe(
      "no_session",
    );
    expect(confirmationRedirect(303, callback, site)).toBe("no_session");
    expect(confirmationRedirect(400, "", site)).toBe("http_400");
    expect(confirmationRedirect(200, callback, site)).toBe("http_200");
    expect(confirmationRedirect(303, "not a url", site)).toBe("bad_location");
  });

  it("rejects a session sent to another origin or path", () => {
    expect(
      confirmationRedirect(
        303,
        "https://evil.example/auth/callback#access_token=a",
        site,
      ),
    ).toBe("foreign_target");
    expect(
      confirmationRedirect(303, `${site}/business#access_token=a`, site),
    ).toBe("foreign_target");
  });

  it("passes only when sign-in is refused before the link and works after", () => {
    const good = {
      before: "email_not_confirmed",
      mail: "ready",
      redirect: "redirected",
      after: null,
    };
    expect(confirmationOutcome(good)).toBe("signin_after_verify");
    expect(confirmationOutcome({ ...good, before: null })).toBe(
      "unconfirmed_signin_allowed",
    );
    expect(
      confirmationOutcome({ ...good, before: "invalid_credentials" }),
    ).toBe("before_invalid_credentials");
    expect(confirmationOutcome({ ...good, mail: "none" })).toBe("mail_none");
    expect(confirmationOutcome({ ...good, redirect: "auth_error" })).toBe(
      "redirect_auth_error",
    );
    expect(confirmationOutcome({ ...good, redirect: null })).toBe(
      "redirect_absent",
    );
    expect(confirmationOutcome({ ...good, after: "email_not_confirmed" })).toBe(
      "signin_email_not_confirmed",
    );
  });
});

describe("foundation hosted check recovery landing", () => {
  const site = DEVELOPMENT_SITE;

  it("lands on the password form after the app exchange", () => {
    expect(recoveryLanding(`${site}/auth/update-password`, 200, site)).toBe(
      "landed",
    );
  });

  it("fails on an HTTP error, an Auth error, or another page", () => {
    expect(recoveryLanding(`${site}/auth/recovery?code=c`, 400, site)).toBe(
      "http_400",
    );
    expect(recoveryLanding(`${site}/auth/update-password`, 503, site)).toBe(
      "http_503",
    );
    expect(
      recoveryLanding(
        `${site}/#error=access_denied&error_code=otp_expired`,
        200,
        site,
      ),
    ).toBe("auth_error");
    expect(recoveryLanding(`${site}/login`, 200, site)).toBe("not_landed");
    expect(
      recoveryLanding("https://evil.example/auth/update-password", 200, site),
    ).toBe("foreign_target");
  });
});

describe("foundation hosted check stage continuation", () => {
  it("reports a failed stage and still runs the next one", async () => {
    const rows: { id: string; status: string; detail: string }[] = [];
    await continueAfter(
      async () => {
        rows.push({ id: "mcp.consent", status: "fail", detail: "x" });
        throw new Error("page.waitForURL: Timeout");
      },
      () => rows.push({ id: "hosted.unhandled", status: "fail", detail: "" }),
    );
    rows.push({ id: "browser.recovery", status: "pass", detail: "" });
    expect(rows.map((row) => row.id)).toEqual([
      "mcp.consent",
      "hosted.unhandled",
      "browser.recovery",
    ]);
    const unreached = unreachedCases(rows);
    expect(unreached).toContain("mcp.permitted_call");
    expect(unreached).toContain("mcp.revoked_call");
    expect(unreached).not.toContain("browser.recovery");
  });

  it("declares every case the script records", () => {
    const source = readFileSync("scripts/foundation-hosted-check.ts", "utf8");
    const recorded = new Set(
      [
        ...source.matchAll(
          /"((?:hosted|mail|browser|data_api|app|mcp|cleanup)\.[a-z_]+)"/g,
        ),
      ].map((match) => match[1]),
    );
    recorded.delete("hosted.prerequisites");
    recorded.delete("hosted.unhandled");
    expect([...recorded].sort()).toEqual([...HOSTED_CASES].sort());
  });
});

describe("foundation hosted check failure details", () => {
  it("names the stage and Playwright call without the message", () => {
    const timeout = new Error(
      "page.waitForURL: Timeout 20000ms exceeded.\n  navigated to https://tutor.example/oauth/consent?authorization_id=secret",
    );
    timeout.name = "TimeoutError";
    const detail = failureDetail("consent_url", timeout);
    expect(detail).toBe("consent_url_TimeoutError_page.waitForURL");
    expect(detail).not.toContain("authorization_id");
  });

  it("falls back to the error class or a generic code", () => {
    expect(failureDetail("mcp", new TypeError("fetch failed"))).toBe(
      "mcp_TypeError",
    );
    expect(failureDetail("recovery", "boom")).toBe("recovery_error");
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
