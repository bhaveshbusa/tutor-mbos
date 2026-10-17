/**
 * Protected entry for run 38954838195 app-row cleanup. The owner and client
 * ids are compiled into the reviewed module. This process does not read a
 * manifest, an admin key, or a caller-supplied id. It receives only the
 * development app_runtime URL.
 */
import { pathToFileURL } from "node:url";
import {
  cleanupRun38954838195,
  cleanupRunGuard,
  formatHistoricalAppRowReport,
} from "@/server/application/cleanup-run-38954838195";
import { pgConnection } from "@/server/application/pg-connection";
import { APP_DATABASE_URL_SECRET } from "@/server/application/hosted-acceptance";
import { inspectAppDatabaseUrl } from "@/server/config/access";

function mask(value: string | null | undefined): void {
  if (value && process.env.GITHUB_ACTIONS === "true") {
    console.log(`::add-mask::${value}`);
  }
}

async function main(): Promise<number> {
  const guard = cleanupRunGuard(process.env);
  if (guard) {
    console.error(`::error::${guard}`);
    return 2;
  }
  const databaseUrl = process.env[APP_DATABASE_URL_SECRET] ?? "";
  mask(databaseUrl);
  const inspected = inspectAppDatabaseUrl(databaseUrl, "development");
  if (!inspected.ok) {
    console.error(`::error::app_database_url=${inspected.code}`);
    return 1;
  }
  const connection = pgConnection(databaseUrl);
  try {
    const report = await cleanupRun38954838195(connection);
    console.log(formatHistoricalAppRowReport(report));
    return report.outcome === "removed" ? 0 : 1;
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.name : "Error"}`);
    return 1;
  } finally {
    await connection.close();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = await main();
}
