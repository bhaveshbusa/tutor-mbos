import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { inspectMigrationDatabaseUrl } from "@/server/config/access";
import {
  migrationCliInvocation,
  migrationLedgerDrift,
} from "../scripts/migration-url";
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

describe("migration CLI invocation", () => {
  it("puts the password in PGPASSWORD and leaves it out of the arguments", () => {
    const password = "p@ss:word";
    const url = `postgresql://postgres.${devRef}:${encodeURIComponent(password)}@db.${devRef}.supabase.co:5432/postgres`;
    for (const mode of ["query", "push"] as const) {
      const invocation = migrationCliInvocation(url, mode);
      expect(invocation.args.join("\n")).not.toContain(password);
      expect(invocation.args.join("\n")).not.toContain(
        encodeURIComponent(password),
      );
      expect(
        new URL(invocation.args[invocation.args.indexOf("--db-url") + 1]!)
          .password,
      ).toBe("");
      expect(invocation.env.PGPASSWORD).toBe(password);
    }
    const push = migrationCliInvocation(url, "push");
    expect(push.args).toContain("--skip-vault");
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

describe("migration script under node", () => {
  it("loads the same way the migration job runs it", () => {
    const env = { ...process.env };
    delete env.SUPABASE_MIGRATION_DATABASE_URL;
    let stderr = "";
    try {
      execFileSync("node", ["scripts/migration-url.ts"], {
        encoding: "utf8",
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      const failed = error as { status?: number; stderr?: string };
      expect(failed.status).toBe(1);
      stderr = failed.stderr ?? "";
    }
    expect(stderr).toContain("SUPABASE_MIGRATION_DATABASE_URL is required");
    expect(stderr).not.toContain("ERR_MODULE_NOT_FOUND");
  });
});
