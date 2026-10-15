/**
 * Applies the reviewed migration set to the development database.
 * Refuses a production URL and the app_runtime role. Does not print URLs
 * or passwords.
 */
import { readFileSync } from "node:fs";
import { inspectMigrationDatabaseUrl } from "../src/server/config/access.ts";
import {
  applyMigrations,
  assertTenantPrivileges,
  loadMigrationFiles,
  type MigrationManifest,
} from "../src/server/application/migration-runner.ts";
import { pgConnection } from "../src/server/application/pg-connection.ts";

const databaseUrl = process.env.SUPABASE_MIGRATION_DATABASE_URL;
const appPassword = process.env.APP_RUNTIME_PASSWORD;

if (!databaseUrl || !inspectMigrationDatabaseUrl(databaseUrl).ok) {
  console.error(
    "SUPABASE_MIGRATION_DATABASE_URL must be the development migration login. See docs/release.md.",
  );
  process.exit(1);
}
if (!appPassword) {
  console.error("APP_RUNTIME_PASSWORD is required and was not set.");
  process.exit(1);
}

const manifest = JSON.parse(
  readFileSync("supabase/migrations/manifest.json", "utf8"),
) as MigrationManifest;
const files = loadMigrationFiles("supabase/migrations", manifest);
const db = pgConnection(databaseUrl);

try {
  const applied = await applyMigrations(db, files, manifest.lockKey);
  await assertTenantPrivileges(db);
  console.log(
    applied.length === 0
      ? "Migrations already applied."
      : `Applied ${applied.join(", ")}.`,
  );
  await db.exec(`
    do $$
    begin
      if not exists (select 1 from pg_roles where rolname = 'app_runtime') then
        create role app_runtime login nosuperuser nobypassrls noinherit;
      else
        alter role app_runtime login nosuperuser nobypassrls noinherit;
      end if;
    end
    $$;
  `);
  await db.query("grant app_request to app_runtime");
  const quoted = await db.query<{ statement: string }>(
    "select format('alter role app_runtime password %L', $1) as statement",
    [appPassword],
  );
  const statement = quoted.rows[0]?.statement;
  if (!statement?.startsWith("alter role app_runtime password ")) {
    throw new Error("Could not set the app runtime password.");
  }
  await db.exec(statement);
  console.log("app_runtime is ready for user-scoped requests.");
} finally {
  await db.close();
}
