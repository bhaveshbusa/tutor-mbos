import { describe, expect, it } from "vitest";
import {
  ENVIRONMENT_BINDINGS,
  loadRuntimeConfig,
  looksLikeSecret,
  supabaseUrlFor,
} from "@/server/config/environments";

const DEV_URL = supabaseUrlFor(
  ENVIRONMENT_BINDINGS.development.supabaseProjectRef,
);
const PROD_URL = supabaseUrlFor(
  ENVIRONMENT_BINDINGS.production.supabaseProjectRef,
);

const SYNTHETIC_PUBLISHABLE = "sb_" + "publishable_" + "synthetic_example";

function jwt(payload: object): string {
  const encode = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode(payload)}.c2lnbmF0dXJlLXZhbHVl`;
}

describe("reviewed environment bindings", () => {
  it("pins development and production to distinct Vercel and Supabase projects", () => {
    const dev = ENVIRONMENT_BINDINGS.development;
    const prod = ENVIRONMENT_BINDINGS.production;
    expect(dev.vercelProjectId).not.toBe(prod.vercelProjectId);
    expect(dev.supabaseProjectRef).not.toBe(prod.supabaseProjectRef);
    expect(dev.syntheticDataOnly).toBe(true);
  });
});

describe("loadRuntimeConfig", () => {
  it("accepts each environment with its own Supabase project", () => {
    for (const [environment, binding] of Object.entries(ENVIRONMENT_BINDINGS)) {
      const result = loadRuntimeConfig({
        TUTOR_MBOS_ENV: environment,
        NEXT_PUBLIC_SUPABASE_URL: supabaseUrlFor(binding.supabaseProjectRef),
      });
      expect(result).toEqual({
        ok: true,
        config: {
          environment,
          supabaseProjectRef: binding.supabaseProjectRef,
          supabaseUrl: supabaseUrlFor(binding.supabaseProjectRef),
          supabasePublishableKeyConfigured: false,
          syntheticDataOnly: binding.syntheticDataOnly,
        },
      });
    }
  });

  it("rejects swapped Supabase projects in both directions", () => {
    expect(
      loadRuntimeConfig({
        TUTOR_MBOS_ENV: "development",
        NEXT_PUBLIC_SUPABASE_URL: PROD_URL,
      }),
    ).toEqual({
      ok: false,
      issues: [
        { variable: "NEXT_PUBLIC_SUPABASE_URL", code: "binding_mismatch" },
      ],
    });
    expect(
      loadRuntimeConfig({
        TUTOR_MBOS_ENV: "production",
        NEXT_PUBLIC_SUPABASE_URL: DEV_URL,
      }),
    ).toMatchObject({ ok: false });
  });

  it("reports missing configuration without guessing an environment", () => {
    expect(loadRuntimeConfig({})).toEqual({
      ok: false,
      issues: [
        { variable: "TUTOR_MBOS_ENV", code: "missing" },
        { variable: "NEXT_PUBLIC_SUPABASE_URL", code: "missing" },
      ],
    });
  });

  it.each([
    ["staging", DEV_URL],
    ["Development", DEV_URL],
    ["development", `${DEV_URL}/`],
    ["development", DEV_URL.replace("https:", "http:")],
    [
      "development",
      "https://idvzjqrkgnihvxoswuxu.supabase.co.attacker.example",
    ],
  ])("rejects invalid values (%s, %s)", (environment, url) => {
    const result = loadRuntimeConfig({
      TUTOR_MBOS_ENV: environment,
      NEXT_PUBLIC_SUPABASE_URL: url,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects secret or privileged keys in public variables and never echoes them", () => {
    const secret = "sb_" + "secret_" + "a".repeat(32);
    const serviceRole = jwt({ role: "service_role" });
    for (const value of [secret, serviceRole]) {
      const result = loadRuntimeConfig({
        TUTOR_MBOS_ENV: "development",
        NEXT_PUBLIC_SUPABASE_URL: DEV_URL,
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: value,
      });
      expect(result).toEqual({
        ok: false,
        issues: [
          {
            variable: "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
            code: "secret_in_public_variable",
          },
        ],
      });
      expect(JSON.stringify(result)).not.toContain(value);
    }
  });

  it("flags secrets in any NEXT_PUBLIC_ variable", () => {
    const result = loadRuntimeConfig({
      TUTOR_MBOS_ENV: "development",
      NEXT_PUBLIC_SUPABASE_URL: DEV_URL,
      NEXT_PUBLIC_ANYTHING: "sb_" + "secret_" + "b".repeat(32),
      SERVER_ONLY_VALUE: "sb_" + "secret_" + "c".repeat(32),
    });
    expect(result).toEqual({
      ok: false,
      issues: [
        { variable: "NEXT_PUBLIC_ANYTHING", code: "secret_in_public_variable" },
      ],
    });
  });

  it("accepts a publishable key and records only that it is configured", () => {
    const result = loadRuntimeConfig({
      TUTOR_MBOS_ENV: "development",
      NEXT_PUBLIC_SUPABASE_URL: DEV_URL,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: SYNTHETIC_PUBLISHABLE,
    });
    expect(result).toMatchObject({
      ok: true,
      config: { supabasePublishableKeyConfigured: true },
    });
    expect(JSON.stringify(result)).not.toContain(SYNTHETIC_PUBLISHABLE);
  });

  it("rejects a malformed publishable key", () => {
    expect(
      loadRuntimeConfig({
        TUTOR_MBOS_ENV: "development",
        NEXT_PUBLIC_SUPABASE_URL: DEV_URL,
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "not-a-key",
      }),
    ).toEqual({
      ok: false,
      issues: [
        { variable: "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", code: "invalid" },
      ],
    });
  });
});

describe("looksLikeSecret", () => {
  it("treats only anon JWTs as public", () => {
    expect(looksLikeSecret(jwt({ role: "anon" }))).toBe(false);
    expect(looksLikeSecret(jwt({ role: "authenticated" }))).toBe(true);
    expect(looksLikeSecret("eyJunparseable.eyJ%%%.sig")).toBe(true);
    expect(looksLikeSecret("https://example.supabase.co")).toBe(false);
  });
});
