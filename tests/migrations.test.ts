import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  applyMigrationFiles,
  emptyDatabase,
  migrationFileNames,
} from "./helpers/database";

const APPLIED_CHECKSUMS: Record<string, string> = {
  "20261015120000_tenant_security.sql":
    "6c2b8d5fd737be6ae8e692544fde72ddc74c22d1392c1751982840a55e269eff",
  "20261015121000_restrict_delegated_access.sql":
    "1dac10609dd055ef2dacad846e6431a7d2ef67125d28761f9a0c484489fa14e7",
  "20261015122000_review_access_fixes.sql":
    "4a038b61668e97332c1983d950f6464ff9b4af06bbb589539fd6e3c171346355",
};

describe("migration files", () => {
  it("keeps the three applied files byte-for-byte and adds one forward file", () => {
    const names = migrationFileNames();
    expect(names.slice(0, 3)).toEqual(Object.keys(APPLIED_CHECKSUMS));
    expect(names[3]).toBe("20261017220000_user_scoped_access.sql");
    for (const [name, checksum] of Object.entries(APPLIED_CHECKSUMS)) {
      const sql = readFileSync(`supabase/migrations/${name}`);
      expect(createHash("sha256").update(sql).digest("hex")).toBe(checksum);
    }
  });

  it("installs on an empty database and skips versions already recorded", async () => {
    const { connection } = await emptyDatabase();
    const first = await applyMigrationFiles(connection);
    expect(first).toHaveLength(4);
    const second = await applyMigrationFiles(connection);
    expect(second).toEqual([]);
    const versions = await connection.query<{ version: string }>(
      "select version from supabase_migrations.schema_migrations order by version",
    );
    expect(versions.rows.map((row) => row.version)).toEqual([
      "20261015120000",
      "20261015121000",
      "20261015122000",
      "20261017220000",
    ]);
  });

  it("keeps an existing business when the forward file is applied", async () => {
    const { connection } = await emptyDatabase();
    const earlier = migrationFileNames().slice(0, 3);
    await applyMigrationFiles(connection, earlier);
    const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
    await connection.query(
      `insert into app.businesses (owner_user_id, display_name)
       values ($1, 'Kept through the transition')`,
      [owner],
    );
    const applied = await applyMigrationFiles(connection);
    expect(applied).toEqual(["20261017220000"]);
    const rows = await connection.query<{ display_name: string }>(
      "select display_name from app.businesses",
    );
    expect(rows.rows).toEqual([
      { display_name: "Kept through the transition" },
    ]);
    const visible = await connection.transaction(async (tx) => {
      await tx.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: owner, role: "authenticated" }),
      ]);
      await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [
        owner,
      ]);
      await tx.exec("set local role authenticated");
      return tx.query("select display_name from public.read_business()");
    });
    expect(visible.rows).toEqual([
      { display_name: "Kept through the transition" },
    ]);
  });

  it("rolls back a failed file and leaves the earlier version recorded", async () => {
    const { connection } = await emptyDatabase();
    await applyMigrationFiles(connection, migrationFileNames().slice(0, 1));
    await expect(
      connection.transaction(async (tx) => {
        await tx.exec("select no_such_migration_function()");
        await tx.query(
          `insert into supabase_migrations.schema_migrations
             (version, statements, name) values ('999', array['bad'], 'bad')`,
        );
      }),
    ).rejects.toThrow(/no_such_migration_function/);
    const versions = await connection.query<{ version: string }>(
      "select version from supabase_migrations.schema_migrations",
    );
    expect(versions.rows.map((row) => row.version)).toEqual(["20261015120000"]);
  });
});
