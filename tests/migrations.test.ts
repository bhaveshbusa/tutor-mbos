import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  applyMigrations,
  assertTenantPrivileges,
  hashSql,
  loadMigrationFiles,
} from "@/server/application/migration-runner";
import { ACCESS_CONTRACT_VERSION } from "@/server/domain/access-contract";
import { emptyDatabase, migrationManifest } from "./helpers/database";
import type { SqlConnection } from "@/server/application/sql";

async function versions(db: SqlConnection): Promise<string[]> {
  const result = await db.query<{ version: string }>(
    "select version from supabase_migrations.schema_migrations order by version",
  );
  return result.rows.map((row) => row.version);
}

describe("versioned migrations", () => {
  it("matches the access contract and refuses a checksum mismatch", () => {
    const manifest = migrationManifest();
    expect(manifest.contractVersion).toBe(ACCESS_CONTRACT_VERSION);
    expect(manifest.lockKey).toBe(748310015);
    const files = loadMigrationFiles("supabase/migrations", manifest);
    expect(files.map((file) => file.version)).toEqual([
      "20261015120000",
      "20261015121000",
      "20261015122000",
    ]);
    expect(files[0]?.sql).not.toContain("setup_report");
    expect(files[1]?.sql).toContain("setup_report");
    expect(() =>
      loadMigrationFiles("supabase/migrations", {
        ...manifest,
        migrations: manifest.migrations.map((entry, index) =>
          index === 0 ? { ...entry, sha256: "0".repeat(64) } : entry,
        ),
      }),
    ).toThrow(/checksum mismatch/);
  });

  it("applies a fresh database once, then does not apply again", async () => {
    const { connection } = await emptyDatabase();
    const manifest = migrationManifest();
    const files = loadMigrationFiles("supabase/migrations", manifest);
    const queries: string[] = [];
    const wrapped: SqlConnection = {
      query: async (text, params) => {
        queries.push(text);
        return connection.query(text, params);
      },
      exec: (text) => connection.exec(text),
      transaction: (fn) => connection.transaction(fn),
    };
    const first = await applyMigrations(wrapped, files, manifest.lockKey);
    const second = await applyMigrations(wrapped, files, manifest.lockKey);
    expect(first).toEqual([
      "20261015120000",
      "20261015121000",
      "20261015122000",
    ]);
    expect(second).toEqual([]);
    expect(await versions(connection)).toEqual(first);
    expect(queries.some((query) => query.includes("pg_advisory_lock"))).toBe(
      true,
    );
    const relations = await connection.query<{ name: string }>(
      `select n.nspname || '.' || c.relname as name
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'app' and c.relkind in ('r', 'v')
       order by 1`,
    );
    expect(relations.rows.map((row) => row.name)).toEqual(manifest.relations);
    await connection.exec("set role authenticated");
    await expect(
      connection.query("select * from app.businesses"),
    ).rejects.toThrow(/permission denied/);
    await connection.exec("reset role");
    await assertTenantPrivileges(connection);
    await connection.exec("revoke usage on schema auth from app_request");
    await expect(assertTenantPrivileges(connection)).rejects.toThrow(
      /cannot execute auth.uid/,
    );
  });

  it("runs the auth.uid check for a login that cannot set role app_request", async () => {
    const { connection } = await emptyDatabase();
    const manifest = migrationManifest();
    await applyMigrations(
      connection,
      loadMigrationFiles("supabase/migrations", manifest),
      manifest.lockKey,
    );
    await connection.exec(`
      create role migration_login nosuperuser createrole;
      grant app_request to migration_login with admin true, inherit false, set false;
    `);
    await connection.exec("set session authorization migration_login");
    await expect(
      connection.transaction(async (tx) => {
        await tx.exec("set local role app_request");
      }),
    ).rejects.toThrow(/permission denied to set role "app_request"/);
    await assertTenantPrivileges(connection);
    await connection.exec("reset session authorization");
    const membership = await connection.query<{
      admin_option: boolean;
      inherit_option: boolean;
      set_option: boolean;
    }>(`
      select m.admin_option, m.inherit_option, m.set_option
      from pg_auth_members m
      join pg_roles granted on granted.oid = m.roleid
      join pg_roles member on member.oid = m.member
      where granted.rolname = 'app_request'
        and member.rolname = 'migration_login'
    `);
    expect(membership.rows).toEqual([
      { admin_option: true, inherit_option: false, set_option: false },
    ]);
  });

  it("quotes the migration login instead of granting to a role keyword", () => {
    const source = readFileSync(
      "src/server/application/migration-runner.ts",
      "utf8",
    );
    expect(source).toContain(
      "format('grant app_request to %I with set true, inherit false', current_user)",
    );
    expect(source).not.toMatch(
      /\bto\s+(current_user|current_role|session_user)\b/i,
    );
  });

  it("keeps populated rows when the corrective migration is applied", async () => {
    const { connection } = await emptyDatabase();
    const manifest = migrationManifest();
    const files = loadMigrationFiles("supabase/migrations", manifest);
    await applyMigrations(connection, [files[0]!], manifest.lockKey);
    const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
    await connection.transaction(async (tx) => {
      await tx.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: owner, role: "authenticated" }),
      ]);
      await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [
        owner,
      ]);
      await tx.exec("set local role app_request");
      await tx.query("select * from app.create_business($1, $2)", [
        "North Bridge Tutoring",
        "populated-key",
      ]);
    });
    await applyMigrations(connection, files, manifest.lockKey);
    const report = await connection.transaction(async (tx) => {
      await tx.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: owner, role: "authenticated" }),
      ]);
      await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [
        owner,
      ]);
      await tx.exec("set local role app_request");
      return tx.query("select display_name from app.setup_report");
    });
    expect(report.rows).toEqual([{ display_name: "North Bridge Tutoring" }]);
    expect(await versions(connection)).toEqual([
      "20261015120000",
      "20261015121000",
      "20261015122000",
    ]);
  });

  it("rolls back a failed migration and keeps the previous version", async () => {
    const { connection } = await emptyDatabase();
    const manifest = migrationManifest();
    const files = loadMigrationFiles("supabase/migrations", manifest);
    const broken = {
      version: "20261015123000",
      name: "broken",
      sha256: hashSql("select * from app.missing_relation"),
      sql: "select * from app.missing_relation;",
    };
    await expect(
      applyMigrations(connection, [files[0]!, broken], manifest.lockKey),
    ).rejects.toThrow();
    expect(await versions(connection)).toEqual(["20261015120000"]);
    const tables = await connection.query(
      "select to_regclass('app.businesses') as businesses, to_regclass('app.missing_relation') as missing",
    );
    expect(tables.rows[0]).toMatchObject({
      businesses: "app.businesses",
      missing: null,
    });
  });

  it("does not ship the test auth shim as a hosted migration", () => {
    const sql = readFileSync("supabase/tests/auth-compat.sql", "utf8");
    expect(sql).toContain("Do not apply this file");
    const manifest = migrationManifest();
    expect(
      manifest.migrations.every((entry) => entry.name !== "auth-compat"),
    ).toBe(true);
  });
});
