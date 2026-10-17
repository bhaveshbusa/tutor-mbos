import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  appRuntimeDatabaseUrl,
  inspectAppDatabaseUrl,
  inspectMigrationDatabaseUrl,
  resolveAppDatabaseUrl,
} from "@/server/config/access";
import { ENVIRONMENT_BINDINGS } from "@/server/config/environments";

const require = createRequire(import.meta.url);
const ConnectionParameters = require("pg/lib/connection-parameters.js") as new (
  value: string,
) => { password?: string; user?: string; ssl?: unknown };

function parsedConnection(value: string): {
  password?: string;
  user?: string;
  ssl?: unknown;
} {
  return new ConnectionParameters(value);
}

const devRef = ENVIRONMENT_BINDINGS.development.supabaseProjectRef;
const prodRef = ENVIRONMENT_BINDINGS.production.supabaseProjectRef;
const password = "redacted";

describe("database connection guards", () => {
  it("accepts only the app runtime role for the selected environment", () => {
    expect(
      inspectAppDatabaseUrl(
        `postgresql://app_runtime.${devRef}:${password}@aws-0-eu-west-2.pooler.supabase.com:6543/postgres`,
        "development",
      ),
    ).toEqual({ ok: true });
    expect(
      inspectAppDatabaseUrl(
        `postgresql://postgres.${devRef}:${password}@aws-0-eu-west-2.pooler.supabase.com:6543/postgres`,
        "development",
      ).ok,
    ).toBe(false);
    expect(
      inspectAppDatabaseUrl(
        `postgresql://app_runtime.${prodRef}:${password}@aws-0-eu-west-2.pooler.supabase.com:6543/postgres`,
        "development",
      ),
    ).toMatchObject({ ok: false, code: "binding_mismatch" });
  });

  it("allows a development migration login and refuses production or the request role", () => {
    expect(
      inspectMigrationDatabaseUrl(
        `postgresql://postgres.${devRef}:${password}@db.${devRef}.supabase.co:5432/postgres`,
      ),
    ).toEqual({ ok: true });
    expect(
      inspectMigrationDatabaseUrl(
        `postgresql://supabase_admin.${devRef}:${password}@db.${devRef}.supabase.co:5432/postgres`,
      ),
    ).toEqual({ ok: true });
    expect(
      inspectMigrationDatabaseUrl(
        `postgresql://postgres.${devRef}:${password}@aws-0-eu-west-2.pooler.supabase.com:5432/postgres`,
      ),
    ).toEqual({ ok: true });
    expect(
      inspectMigrationDatabaseUrl(
        `postgresql://postgres.${prodRef}:${password}@db.${prodRef}.supabase.co:5432/postgres`,
      ),
    ).toMatchObject({ ok: false, code: "binding_mismatch" });
    expect(
      inspectMigrationDatabaseUrl(
        `postgresql://app_runtime.${devRef}:${password}@db.${devRef}.supabase.co:5432/postgres`,
      ),
    ).toMatchObject({ ok: false, code: "app_runtime" });
    expect(
      inspectMigrationDatabaseUrl(
        `postgresql://service_role.${devRef}:${password}@db.${devRef}.supabase.co:5432/postgres`,
      ),
    ).toMatchObject({ ok: false, code: "privileged_user" });
    expect(inspectMigrationDatabaseUrl("not-a-postgres-url")).toMatchObject({
      ok: false,
      code: "invalid",
    });
    expect(
      inspectMigrationDatabaseUrl(
        `postgresql://postgres.${devRef}:${password}@aws-0-eu-west-2.pooler.supabase.com:6543/postgres`,
      ),
    ).toMatchObject({ ok: false, code: "transaction_pooler" });
  });

  it("encodes the runtime password and does not fall back to a second url", () => {
    const secret = "p@ss:w/rd?# word";
    const built = appRuntimeDatabaseUrl({
      environment: "development",
      password: secret,
      host: "aws-0-eu-west-2.pooler.supabase.com",
      port: "6543",
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const parsed = parsedConnection(built.url);
    expect(parsed.password).toBe(secret);
    expect(parsed.user).toBe(`app_runtime.${devRef}`);
    expect(parsed.ssl).toEqual({});
    expect(built.url).toContain("sslmode=verify-full");
    expect(built.url).not.toContain(secret);
    expect(JSON.stringify(built)).not.toContain(secret);
    for (const roundTrip of [
      "p%41ss",
      "ab%2Fcd",
      "%25%",
      "100%",
      "x+y&z!$'()*,;=~",
    ]) {
      const encoded = appRuntimeDatabaseUrl({
        environment: "development",
        password: roundTrip,
        host: "aws-0-eu-west-2.pooler.supabase.com",
        port: "6543",
      });
      expect(encoded.ok, roundTrip).toBe(true);
      if (!encoded.ok) continue;
      expect(parsedConnection(encoded.url).password, roundTrip).toBe(roundTrip);
      expect(encoded.url).toContain("sslmode=verify-full");
    }
    const legacy = `postgresql://app_runtime.${devRef}:<decoy>@aws-0-eu-west-2.pooler.supabase.com:6543/postgres`;
    const preferred = resolveAppDatabaseUrl(
      {
        APP_RUNTIME_PASSWORD: secret,
        TUTOR_MBOS_APP_DATABASE_HOST: "aws-0-eu-west-2.pooler.supabase.com",
        TUTOR_MBOS_APP_DATABASE_PORT: "6543",
        TUTOR_MBOS_APP_DATABASE_URL: legacy,
      },
      "development",
    );
    expect(preferred).toMatchObject({ ok: true, source: "password" });
    if (preferred.ok) expect(preferred.url).not.toContain("decoy");
    const partial = resolveAppDatabaseUrl(
      {
        APP_RUNTIME_PASSWORD: secret,
        TUTOR_MBOS_APP_DATABASE_URL: legacy,
      },
      "development",
    );
    expect(partial.ok).toBe(false);
    expect(JSON.stringify(partial)).not.toContain(secret);
    expect(JSON.stringify(partial)).not.toContain("decoy");
    const stored = resolveAppDatabaseUrl(
      { TUTOR_MBOS_APP_DATABASE_URL: legacy },
      "development",
    );
    expect(stored).toEqual({ ok: true, url: legacy, source: "url" });
    expect(
      appRuntimeDatabaseUrl({
        environment: "development",
        password: `${secret}\n`,
        host: "aws-0-eu-west-2.pooler.supabase.com",
        port: "6543",
      }),
    ).toEqual({ ok: false, code: "password_absent" });
    const badHost = appRuntimeDatabaseUrl({
      environment: "development",
      password: secret,
      host: "host name",
      port: "6543",
    });
    expect(badHost).toEqual({ ok: false, code: "host_invalid" });
    expect(JSON.stringify(badHost)).not.toContain(secret);
    const production = appRuntimeDatabaseUrl({
      environment: "production",
      password: secret,
      host: "aws-0-eu-west-2.pooler.supabase.com",
      port: "6543",
    });
    expect(production.ok).toBe(true);
    if (production.ok) {
      expect(new URL(production.url).username).toBe(`app_runtime.${prodRef}`);
      expect(production.url).not.toContain(devRef);
      expect(production.url).not.toContain(secret);
    }
  });
});
