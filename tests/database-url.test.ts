import { describe, expect, it } from "vitest";
import { inspectMigrationDatabaseUrl } from "@/server/config/access";
import { migrationLedgerDrift } from "../scripts/migration-url";
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
        `postgresql://postgres.${prodRef}:${password}@db.${prodRef}.supabase.co:5432/postgres`,
        "production",
      ),
    ).toEqual({ ok: true });
    expect(
      inspectMigrationDatabaseUrl(
        `postgresql://postgres.${devRef}:${password}@db.${devRef}.supabase.co:5432/postgres`,
        "production",
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

describe("migration ledger drift", () => {
  const files = [
    { version: "20261015120000", name: "tenant_security", sha256: "abc" },
    { version: "20261017220000", name: "user_scoped_access", sha256: "def" },
  ];

  it("accepts a matching prefix and refuses an unknown or altered version", () => {
    expect(
      migrationLedgerDrift(files, [
        { version: "20261015120000", name: "tenant_security", sha256: "abc" },
      ]),
    ).toEqual({ ok: true });
    expect(
      migrationLedgerDrift(files, [
        { version: "20261015999999", name: "other", sha256: "abc" },
      ]),
    ).toMatchObject({ ok: false, code: "unknown_version" });
    expect(
      migrationLedgerDrift(files, [
        { version: "20261015120000", name: "tenant_security", sha256: "nope" },
      ]),
    ).toMatchObject({ ok: false, code: "checksum_mismatch" });
    expect(
      migrationLedgerDrift(files, [
        {
          version: "20261017220000",
          name: "user_scoped_access",
          sha256: "def",
        },
      ]),
    ).toMatchObject({ ok: false, code: "history_gap" });
  });
});
