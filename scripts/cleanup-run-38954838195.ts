/**
 * Protected cleanup for run 38954838195. Read 39019907233 showed both
 * pinned businesses still present. This process deletes only when each
 * manifest owner still sees exactly that business. The ids are compiled
 * into the reviewed module. This process does not read a manifest, an
 * admin key, or a caller-supplied id. It builds the development
 * app_runtime URL from APP_RUNTIME_PASSWORD and the non-secret host and
 * port. A stored URL is not accepted.
 */
import { pathToFileURL } from "node:url";
import {
  CLEANUP_RUN_38954838195,
  cleanupRun38954838195,
  cleanupRunGuard,
  formatHistoricalAppRowReport,
  type HistoricalAppRowReport,
} from "@/server/application/cleanup-run-38954838195";
import { pgAppRuntimeConnection } from "@/server/application/pg-connection";
import { databaseSqlState } from "@/server/application/hosted-acceptance";
import { resolveAppDatabaseUrl } from "@/server/config/access";

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
  const inspected = resolveAppDatabaseUrl(process.env, "development");
  if (!inspected.ok || inspected.source !== "password") {
    console.error(
      `::error::app_database_url=${inspected.ok ? "url" : inspected.code}`,
    );
    return 1;
  }
  const databaseUrl = inspected.url;
  mask(databaseUrl);
  const connection = pgAppRuntimeConnection(databaseUrl);
  let report: HistoricalAppRowReport | null = null;
  let failed: unknown = null;
  try {
    report = await cleanupRun38954838195(connection);
  } catch (error) {
    failed = error;
  }
  let closeSqlstate: string | null = null;
  try {
    await connection.close();
  } catch (error) {
    closeSqlstate = databaseSqlState(error);
  }
  const close =
    closeSqlstate === null ? "" : `\nclose_sqlstate=${closeSqlstate}`;
  if (report) {
    console.log(`${formatHistoricalAppRowReport(report)}${close}`);
    return report.outcome === "removed" ? 0 : 1;
  }
  const sqlstate = databaseSqlState(failed);
  console.error(
    `::error::historical_app_rows run=${CLEANUP_RUN_38954838195.runId} phase=cleanup outcome=uncertain sqlstate=${sqlstate}${close}`,
  );
  return 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = await main();
}
