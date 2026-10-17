/**
 * Protected read for run 38954838195. Workflow run 38992665029 failed
 * before a report, so this process does not delete. The owner and client
 * ids are compiled into the reviewed module. This process does not read a
 * manifest, an admin key, or a caller-supplied id. It receives only the
 * development app_runtime URL.
 */
import { pathToFileURL } from "node:url";
import {
  CLEANUP_RUN_38954838195,
  cleanupRunGuard,
  diagnoseRun38954838195,
  formatDiagnoseReport,
  type DiagnoseReport,
} from "@/server/application/cleanup-run-38954838195";
import { pgConnection } from "@/server/application/pg-connection";
import {
  APP_DATABASE_URL_SECRET,
  databaseSqlState,
} from "@/server/application/hosted-acceptance";
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
  let report: DiagnoseReport | null = null;
  let failed: unknown = null;
  try {
    report = await diagnoseRun38954838195(connection);
  } catch (error) {
    failed = error;
  }
  let closeSqlstate: string | null = null;
  try {
    await connection.close();
  } catch (error) {
    closeSqlstate = databaseSqlState(error);
  }
  if (report) {
    console.log(
      formatDiagnoseReport(
        closeSqlstate ? { ...report, closeSqlstate } : report,
      ),
    );
    return report.outcome === "read" ? 0 : 1;
  }
  const sqlstate = databaseSqlState(failed);
  const close =
    closeSqlstate === null ? "" : ` close_sqlstate=${closeSqlstate}`;
  console.error(
    `::error::historical_app_rows run=${CLEANUP_RUN_38954838195.runId} phase=script outcome=failed sqlstate=${sqlstate} writes=not_started${close}`,
  );
  return 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = await main();
}
