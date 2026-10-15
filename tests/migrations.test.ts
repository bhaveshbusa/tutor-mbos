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
