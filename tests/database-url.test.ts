import { describe, expect, it } from "vitest";
import {
  inspectAppDatabaseUrl,
  inspectMigrationDatabaseUrl,
} from "@/server/config/access";
import { ENVIRONMENT_BINDINGS } from "@/server/config/environments";

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
});
