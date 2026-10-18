import { readdirSync, readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import type { Sql, SqlConnection } from "@/server/application/sql";
import { createSqlAccessStore } from "./sql-store";

export function pgliteConnection(db: PGlite): SqlConnection {
  const wrap = (target: {
    query: PGlite["query"];
    exec: PGlite["exec"];
  }): Sql => ({
    async query<T = Record<string, unknown>>(
      text: string,
      params?: readonly unknown[],
    ) {
      const result = await target.query(text, params ? [...params] : []);
      return { rows: result.rows as T[] };
    },
    async exec(text) {
      await target.exec(text);
    },
  });
  return {
    ...wrap(db),
    transaction: (fn) => db.transaction((tx) => fn(wrap(tx))),
  };
}

export function migrationFileNames(): string[] {
  return readdirSync("supabase/migrations")
    .filter((name) => name.endsWith(".sql"))
    .sort();
}

const LEDGER = `
create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (
  version text primary key,
  statements text[],
  name text
);
`;

/**
 * Applies reviewed SQL files in filename order, one transaction each, and
 * records the Supabase CLI history shape. This is the test fixture. Hosted
 * development uses `supabase db push`, which skips versions already recorded.
 */
export async function applyMigrationFiles(
  connection: SqlConnection,
  names: readonly string[] = migrationFileNames(),
): Promise<string[]> {
  await connection.exec(LEDGER);
  const existing = await connection.query<{ version: string }>(
    "select version from supabase_migrations.schema_migrations",
  );
  const recorded = new Set(existing.rows.map((row) => row.version));
  const applied: string[] = [];
  for (const file of names) {
    const version = file.split("_")[0] ?? "";
    if (recorded.has(version)) continue;
    const name = file.slice(version.length + 1).replace(/\.sql$/, "");
    const sql = readFileSync(`supabase/migrations/${file}`, "utf8");
    await connection.transaction(async (tx) => {
      await tx.exec(sql);
      await tx.query(
        `insert into supabase_migrations.schema_migrations
           (version, statements, name) values ($1, $2, $3)`,
        [version, [sql], name],
      );
    });
    applied.push(version);
  }
  return applied;
}

export async function emptyDatabase(): Promise<{
  db: PGlite;
  connection: SqlConnection;
}> {
  const db = new PGlite();
  const connection = pgliteConnection(db);
  await connection.exec(readFileSync("supabase/tests/auth-compat.sql", "utf8"));
  return { db, connection };
}

export async function migratedDatabase() {
  const { db, connection } = await emptyDatabase();
  const applied = await applyMigrationFiles(connection);
  return {
    db,
    connection,
    store: createSqlAccessStore(connection),
    applied,
  };
}
