/**
 * Explicit app_runtime password rotation for development. Ordinary
 * migration does not call this script. The confirmation value is compared
 * and not printed. The log does not include the password, verifier, or URL.
 */
import { pathToFileURL } from "node:url";
import {
  formatRuntimePrivilegeEvidence,
  rotateAppRuntimePassword,
  safeRuntimeFailure,
} from "../src/server/application/app-runtime-role.ts";
import { pgConnection } from "../src/server/application/pg-connection.ts";
import { migrationConnectionDiagnostic } from "./apply-migrations.ts";

const ROTATION_CONFIRMATION = "rotate-app-runtime-password";

async function main(): Promise<void> {
  if (process.env.APP_RUNTIME_PASSWORD_ROTATION !== ROTATION_CONFIRMATION) {
    console.error(
      "App runtime password rotation requires the reviewed confirmation. Ordinary migration does not rotate the password.",
    );
    process.exit(2);
  }
  const diagnostic = migrationConnectionDiagnostic(
    process.env.SUPABASE_MIGRATION_DATABASE_URL,
  );
  if (!diagnostic.ok) {
    console.error(diagnostic.message);
    process.exit(1);
  }
  const appPassword = process.env.APP_RUNTIME_PASSWORD;
  if (!appPassword) {
    console.error("APP_RUNTIME_PASSWORD is required and was not set.");
    process.exit(1);
  }
  const db = pgConnection(diagnostic.databaseUrl);
  let failure: string | undefined;
  try {
    const evidence = await rotateAppRuntimePassword(db, appPassword);
    console.log(formatRuntimePrivilegeEvidence(evidence));
    console.log("app_runtime password rotation finished.");
  } catch (error) {
    failure = safeRuntimeFailure(error, appPassword);
  } finally {
    await db.close();
  }
  if (failure) {
    console.error(failure);
    process.exit(1);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
