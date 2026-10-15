import { afterEach, describe, expect, it, vi } from "vitest";
import { GET as health } from "@/app/api/v1/health/route";
import * as unknownRoute from "@/app/api/v1/[...path]/route";
import { healthResponse } from "@/adapters/http/v1";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const DEV_ENV = {
  TUTOR_MBOS_ENV: "development",
  NEXT_PUBLIC_SUPABASE_URL: "https://idvzjqrkgnihvxoswuxu.supabase.co",
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /api/v1/health", () => {
  it("reports the bound environment, commit and that authentication is not implemented", async () => {
    const response = healthResponse(DEV_ENV, { commit: COMMIT });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      apiVersion: "v1",
      service: "tutor-mbos",
      status: "ok",
      commit: COMMIT,
      authentication: "not_implemented",
      environment: "development",
      supabaseProjectRef: "idvzjqrkgnihvxoswuxu",
      syntheticDataOnly: true,
    });
  });

  it("returns 503 with issue codes only when misconfigured", async () => {
    const leaked = "sb_" + "secret_" + "z".repeat(32);
    const response = healthResponse(
      { ...DEV_ENV, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: leaked },
      { commit: COMMIT },
    );
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(text).not.toContain(leaked);
    expect(JSON.parse(text)).toMatchObject({
      status: "misconfigured",
      issues: [
        {
          variable: "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
          code: "secret_in_public_variable",
        },
      ],
    });
  });

  it("does not report a commit that is not a full SHA", async () => {
    const response = healthResponse(DEV_ENV, { commit: "main" });
    expect(await response.json()).toMatchObject({ commit: null });
  });

  it("route handler reads process environment", async () => {
    vi.stubEnv("TUTOR_MBOS_ENV", "production");
    vi.stubEnv(
      "NEXT_PUBLIC_SUPABASE_URL",
      "https://vblwjqfpcmegbugmufif.supabase.co",
    );
    const response = health();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      environment: "production",
      supabaseProjectRef: "vblwjqfpcmegbugmufif",
      syntheticDataOnly: false,
    });
  });

  it("route handler fails closed with no configuration", async () => {
    vi.stubEnv("TUTOR_MBOS_ENV", undefined);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", undefined);
    expect(health().status).toBe(503);
  });
});

describe("unknown /api/v1 routes", () => {
  it.each(["GET", "POST", "PUT", "PATCH", "DELETE"] as const)(
    "%s returns a 404 problem document",
    async (method) => {
      const response = unknownRoute[method]();
      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toBe(
        "application/problem+json",
      );
      expect(await response.json()).toMatchObject({
        status: 404,
        title: "Not found",
      });
    },
  );
});
