import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import {
  applyMigrations,
  loadMigrationFiles,
  type MigrationManifest,
} from "@/server/application/migration-runner";
import { createPgAccessStore } from "@/server/application/access-store";
import type { Sql, SqlConnection } from "@/server/application/sql";

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

export function migrationManifest(): MigrationManifest {
  return JSON.parse(
    readFileSync("supabase/migrations/manifest.json", "utf8"),
  ) as MigrationManifest;
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
  const manifest = migrationManifest();
  const files = loadMigrationFiles("supabase/migrations", manifest);
  await applyMigrations(connection, files, manifest.lockKey);
  return {
    db,
    connection,
    store: createPgAccessStore(connection),
    manifest,
    files,
  };
}
