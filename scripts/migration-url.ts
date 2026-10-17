/**
 * Checks the development migration URL before the Supabase CLI connects.
 * A missing value is reported on its own. A rejection prints only an
 * allowlisted reason code plus setup guidance. The log never includes the
 * URL, host, username, password, length, hash, or parser error.
 */
import { pathToFileURL } from "node:url";
import { inspectMigrationDatabaseUrl } from "../src/server/config/access.ts";

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
    "The migration login cannot be a request role. Use postgres or supabase_admin on the development project, on a direct connection or session pooler on port 5432. See docs/release.md.",
  privileged_user:
    "The migration login must be postgres or supabase_admin on the development project. Use a direct connection or session pooler on port 5432. See docs/release.md.",
  transaction_pooler:
    "Port 6543 is the transaction pooler. Use a direct connection or session pooler on port 5432, with username postgres or supabase_admin, on the development project only. See docs/release.md.",
};

function isRejectionCode(code: string): code is MigrationUrlRejectionCode {
  return (MIGRATION_URL_REJECTION_CODES as readonly string[]).includes(code);
}

export function migrationUrlRejectionMessage(code: string): string {
  if (!isRejectionCode(code)) return UNCLASSIFIED_MIGRATION_URL;
  return `SUPABASE_MIGRATION_DATABASE_URL was rejected before connection: ${code}. ${MIGRATION_URL_GUIDANCE[code]}`;
}

export function migrationConnectionDiagnostic(
  databaseUrl: string | undefined,
): { ok: true; databaseUrl: string } | { ok: false; message: string } {
  if (!databaseUrl) return { ok: false, message: MISSING_MIGRATION_URL };
  const inspection = inspectMigrationDatabaseUrl(databaseUrl);
  if (!inspection.ok) {
    return {
      ok: false,
      message: migrationUrlRejectionMessage(inspection.code),
    };
  }
  return { ok: true, databaseUrl };
}

function main(): number {
  const diagnostic = migrationConnectionDiagnostic(
    process.env.SUPABASE_MIGRATION_DATABASE_URL,
  );
  if (!diagnostic.ok) {
    console.error(`::error::${diagnostic.message}`);
    return 1;
  }
  console.log("Migration URL accepted for the development project.");
  return 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = main();
}
