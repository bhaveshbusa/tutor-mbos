import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import type { SqlConnection } from "./sql";

export const MIGRATION_LOCK_KEY = 748310015;

export interface MigrationManifest {
  contractVersion: string;
  lockKey: number;
  migrations: { version: string; name: string; sha256: string }[];
  relations: string[];
}

export interface LoadedMigration {
  version: string;
  name: string;
  sha256: string;
  sql: string;
}

export function hashSql(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

/** Refuses to apply when the directory and checksums differ from the manifest. */
export function loadMigrationFiles(
  directory: string,
  manifest: MigrationManifest,
): LoadedMigration[] {
  const present = readdirSync(directory)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const expected = manifest.migrations.map(
    (entry) => `${entry.version}_${entry.name}.sql`,
  );
  if (present.join("\n") !== expected.join("\n")) {
    throw new Error("migration files do not match the manifest");
  }
  return manifest.migrations.map((entry) => {
    const sql = readFileSync(
      `${directory}/${entry.version}_${entry.name}.sql`,
      "utf8",
    );
    const sha256 = hashSql(sql);
    if (sha256 !== entry.sha256) {
      throw new Error(`checksum mismatch for ${entry.version}`);
    }
    return { ...entry, sql, sha256 };
  });
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
 * Applies pending migrations in manifest order, each in its own transaction,
 * while holding a session advisory lock. A failed migration rolls back and
 * leaves earlier versions in place.
 */
export async function applyMigrations(
  db: SqlConnection,
  files: readonly LoadedMigration[],
  lockKey: number = MIGRATION_LOCK_KEY,
): Promise<string[]> {
  await db.query("select pg_advisory_lock($1)", [lockKey]);
  const applied: string[] = [];
  try {
    await db.exec(LEDGER);
    const existing = await db.query<{ version: string }>(
      "select version from supabase_migrations.schema_migrations",
    );
    const have = new Set(existing.rows.map((row) => row.version));
    for (const file of files) {
      if (have.has(file.version)) continue;
      await db.transaction(async (tx) => {
        await tx.exec(file.sql);
        await tx.query(
          `insert into supabase_migrations.schema_migrations
             (version, statements, name) values ($1, $2, $3)`,
          [file.version, [file.sql], file.name],
        );
      });
      applied.push(file.version);
    }
    return applied;
  } finally {
    await db.query("select pg_advisory_unlock($1)", [lockKey]);
  }
}

/**
 * Hosted development apply checks these privileges after the migration set.
 * authenticated must not use schema app. app_request must still execute
 * auth.uid(), which stays granted by Supabase Auth rather than this app.
 */
export async function assertTenantPrivileges(db: SqlConnection): Promise<void> {
  const result = await db.query<{ app_usage: boolean; uid_execute: boolean }>(
    `select has_schema_privilege('authenticated', 'app', 'USAGE') as app_usage,
            has_function_privilege('app_request', 'auth.uid()', 'EXECUTE') as uid_execute`,
  );
  const row = result.rows[0];
  if (!row || row.app_usage) {
    throw new Error("authenticated retains usage on schema app");
  }
  if (!row.uid_execute) {
    throw new Error("app_request cannot execute auth.uid()");
  }
}
