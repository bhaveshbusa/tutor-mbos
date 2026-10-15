/**
 * Applies the reviewed migration set to the development database.
 * Refuses a production URL and the app_runtime role. A missing URL is
 * reported on its own. A present URL is inspected once, and a rejection
 * prints only an allowlisted reason code plus setup guidance. The log
 * never includes the URL, host, username, password, length, hash, parser
 * error, or environment values.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import * as access from "../src/server/config/access.ts";
import {
  formatRuntimeRoleEvidence,
  formatSchemaLedgerLine,
  provisionAppRuntime,
  readSchemaLedger,
  safeRuntimeFailure,
} from "../src/server/application/app-runtime-role.ts";
import {
  applyMigrations,
  assertTenantPrivileges,
  loadMigrationFiles,
  type MigrationManifest,
} from "../src/server/application/migration-runner.ts";
import { pgConnection } from "../src/server/application/pg-connection.ts";

export const MIGRATION_URL_REJECTION_CODES = [
  "invalid",
  "binding_mismatch",
  "app_runtime",
  "privileged_user",
  "transaction_pooler",
] as const;

export type MigrationUrlRejectionCode =
  (typeof MIGRATION_URL_REJECTION_CODES)[number];

const MISSING_MIGRATION_URL =
  "SUPABASE_MIGRATION_DATABASE_URL is required and was not set. Set it in GitHub → Settings → Environments → development → Secrets. See docs/release.md.";

const UNCLASSIFIED_MIGRATION_URL =
  "SUPABASE_MIGRATION_DATABASE_URL was rejected before connection. See docs/release.md.";

const MIGRATION_URL_GUIDANCE: Record<MigrationUrlRejectionCode, string> = {
  invalid:
    "The value must be a postgres URL for the development migration login. Use a direct connection or session pooler on port 5432, with username postgres or supabase_admin, on the development project only. See docs/release.md.",
  binding_mismatch:
    "The URL must identify the development project only, not the production project. Use a direct connection or session pooler on port 5432, with username postgres or supabase_admin. See docs/release.md.",
  app_runtime:
    "The migration login cannot be the request role. Use postgres or supabase_admin on the development project, on a direct connection or session pooler on port 5432. The request role belongs in TUTOR_MBOS_APP_DATABASE_URL. See docs/release.md.",
  privileged_user:
    "The migration login must be postgres or supabase_admin on the development project. Use a direct connection or session pooler on port 5432. See docs/release.md.",
  transaction_pooler:
    "Port 6543 is the transaction pooler and cannot hold the session migration lock. Use a direct connection or session pooler on port 5432, with username postgres or supabase_admin, on the development project only. See docs/release.md.",
};

function isRejectionCode(code: string): code is MigrationUrlRejectionCode {
  return (MIGRATION_URL_REJECTION_CODES as readonly string[]).includes(code);
}

export function migrationUrlRejectionMessage(code: string): string {
  if (!isRejectionCode(code)) return UNCLASSIFIED_MIGRATION_URL;
  return `SUPABASE_MIGRATION_DATABASE_URL was rejected before connection: ${code}. ${MIGRATION_URL_GUIDANCE[code]}`;
}

/**
 * Checks the migration URL before any connection. A missing value does not
 * call the inspector. A present value is inspected exactly once.
 */
export function migrationConnectionDiagnostic(
  databaseUrl: string | undefined,
): { ok: true; databaseUrl: string } | { ok: false; message: string } {
  if (!databaseUrl) {
    return { ok: false, message: MISSING_MIGRATION_URL };
  }
  const inspection = access.inspectMigrationDatabaseUrl(databaseUrl);
  if (!inspection.ok) {
    return {
      ok: false,
      message: migrationUrlRejectionMessage(inspection.code),
    };
  }
  return { ok: true, databaseUrl };
}

async function main(): Promise<void> {
  const diagnostic = migrationConnectionDiagnostic(
    process.env.SUPABASE_MIGRATION_DATABASE_URL,
  );
  if (!diagnostic.ok) {
    console.error(diagnostic.message);
    process.exit(1);
  }
  const databaseUrl = diagnostic.databaseUrl;
  const appPassword = process.env.APP_RUNTIME_PASSWORD;
  if (!appPassword) {
    console.error("APP_RUNTIME_PASSWORD is required and was not set.");
    process.exit(1);
  }

  const manifest = JSON.parse(
    readFileSync("supabase/migrations/manifest.json", "utf8"),
  ) as MigrationManifest;
  const files = loadMigrationFiles("supabase/migrations", manifest);
  const db = pgConnection(databaseUrl);

  let runtimeFailure: string | undefined;
  try {
    const applied = await applyMigrations(db, files, manifest.lockKey);
    await assertTenantPrivileges(db);
    console.log(
      applied.length === 0
        ? "Migrations already applied."
        : `Applied ${applied.join(", ")}.`,
    );
    const ledger = await readSchemaLedger(db);
    for (const entry of ledger) console.log(formatSchemaLedgerLine(entry));
    try {
      const role = await provisionAppRuntime(db, appPassword);
      console.log(formatRuntimeRoleEvidence(role));
      console.log("app_runtime is ready for user-scoped requests.");
    } catch (error) {
      runtimeFailure = safeRuntimeFailure(error, appPassword);
    }
  } finally {
    await db.close();
  }
  if (runtimeFailure) {
    console.error(runtimeFailure);
    process.exit(1);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
