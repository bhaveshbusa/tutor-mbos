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

interface RecordedMigration {
  version: string;
  statements: unknown;
  name: string | null;
}

function recordedSql(statements: unknown, version: string): string {
  if (
    !Array.isArray(statements) ||
    statements.length === 0 ||
    statements.some((statement) => typeof statement !== "string")
  ) {
    throw new Error(`recorded migration ${version} has no statements`);
  }
  return (statements as string[]).join("");
}

/**
 * The recorded ledger must be a prefix of the reviewed files. Unknown
 * versions, skipped earlier versions and statement text that no longer
 * matches the file are rejected before any pending migration runs.
 */
export function pendingMigrations(
  files: readonly LoadedMigration[],
  recorded: readonly RecordedMigration[],
): LoadedMigration[] {
  const byVersion = new Map(recorded.map((row) => [row.version, row]));
  const expected = new Set(files.map((file) => file.version));
  for (const version of byVersion.keys()) {
    if (!expected.has(version)) {
      throw new Error(
        `recorded migration ${version} is not in the reviewed set`,
      );
    }
  }
  let prefix = 0;
  while (prefix < files.length && byVersion.has(files[prefix]!.version)) {
    prefix += 1;
  }
  for (let index = prefix; index < files.length; index += 1) {
    if (byVersion.has(files[index]!.version)) {
      throw new Error(
        `recorded migration history is missing ${files[prefix]!.version}`,
      );
    }
  }
  for (let index = 0; index < prefix; index += 1) {
    const file = files[index]!;
    const row = byVersion.get(file.version)!;
    if (
      row.name !== file.name ||
      hashSql(recordedSql(row.statements, file.version)) !== file.sha256
    ) {
      throw new Error(
        `recorded migration ${file.version} does not match the reviewed file`,
      );
    }
  }
  return files.slice(prefix);
}

/**
 * Applies pending migrations in manifest order, each in its own transaction,
 * while holding a session advisory lock. Recorded history is checked before
 * any pending file runs. A failed migration rolls back and leaves earlier
 * versions in place.
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
    const existing = await db.query<RecordedMigration>(
      `select version, statements, name
       from supabase_migrations.schema_migrations`,
    );
    const pending = pendingMigrations(files, existing.rows);
    for (const file of pending) {
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

/** Forces the privilege probe to roll back its temporary role grant. */
class RolledBackPrivilegeProbe extends Error {
  constructor() {
    super("rolled back privilege probe");
  }
}

/**
 * Hosted development apply checks these privileges after the migration set.
 * authenticated must not use schema app. app_request must execute
 * app.auth_uid(), which reads auth.uid() as the migration login that owns
 * the function. app_request is not granted schema auth.
 *
 * A hosted `postgres` login can administer `app_request` without being allowed
 * to `SET ROLE` to it (Postgres 16+ records that membership with set_option
 * false). The probe grants `SET` to the current login and switches role in one
 * transaction, then rolls the grant back so the migration login does not keep
 * the membership.
 *
 * The grant target is a quoted identifier from `format('%I', current_user)`.
 * Using the current_user, current_role, or session_user keyword as the GRANT
 * role specification crashes the backend on supabase/postgres 17.6.1.011
 * (supautils 2.9.4). A named role does not.
 */
export async function assertTenantPrivileges(db: SqlConnection): Promise<void> {
  const result = await db.query<{ app_usage: boolean }>(
    `select has_schema_privilege('authenticated', 'app', 'USAGE') as app_usage`,
  );
  const row = result.rows[0];
  if (!row || row.app_usage) {
    throw new Error("authenticated retains usage on schema app");
  }
  try {
    await db.transaction(async (tx) => {
      await tx.exec(
        "do $$ begin execute format('grant app_request to %I with set true, inherit false', current_user); end $$",
      );
      await tx.exec("set local role app_request");
      await tx.query("select app.auth_uid()");
      throw new RolledBackPrivilegeProbe();
    });
  } catch (error) {
    if (error instanceof RolledBackPrivilegeProbe) return;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`app_request cannot execute app.auth_uid(): ${message}`);
  }
}
