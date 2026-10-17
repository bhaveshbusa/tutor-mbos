import { describe, expect, it } from "vitest";
import { inspectMigrationDatabaseUrl } from "@/server/config/access";
import { ENVIRONMENT_BINDINGS } from "@/server/config/environments";

const devRef = ENVIRONMENT_BINDINGS.development.supabaseProjectRef;
const prodRef = ENVIRONMENT_BINDINGS.production.supabaseProjectRef;
const password = "redacted";

describe("migration connection guards", () => {
  it("allows a development migration login and refuses production or a request role", () => {
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
