/**
 * Checks the migration URL before the Supabase CLI connects, then compares
 * the recorded ledger with the reviewed files. A rejection prints only an
 * allowlisted reason code. The log never includes the URL or SQL text.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { inspectMigrationDatabaseUrl } from "../src/server/config/access.ts";
import type { DeploymentEnvironment } from "../src/server/config/environments.ts";

export const MIGRATION_URL_REJECTION_CODES = [
  "invalid",
  "binding_mismatch",
  "app_runtime",
  "privileged_user",
  "transaction_pooler",
] as const;

export type MigrationUrlRejectionCode =
  (typeof MIGRATION_URL_REJECTION_CODES)[number];

function missingMigrationUrl(target: DeploymentEnvironment): string {
  return `SUPABASE_MIGRATION_DATABASE_URL is required and was not set. Set it in GitHub → Settings → Environments → ${target} → Secrets. See docs/release.md.`;
}

const UNCLASSIFIED_MIGRATION_URL =
  "SUPABASE_MIGRATION_DATABASE_URL was rejected before connection. See docs/release.md.";

const MIGRATION_URL_GUIDANCE: Record<MigrationUrlRejectionCode, string> = {
  invalid:
    "The value must be a postgres URL for the development migration login. Use a direct connection or session pooler on port 5432, with username postgres or supabase_admin, on the development project only. See docs/release.md.",
  binding_mismatch:
    "The URL must identify only the target project for MIGRATION_TARGET. Use a direct connection or session pooler on port 5432, with username postgres or supabase_admin. See docs/release.md.",
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
  target: DeploymentEnvironment = "development",
): { ok: true; databaseUrl: string } | { ok: false; message: string } {
  if (!databaseUrl) return { ok: false, message: missingMigrationUrl(target) };
  const inspection = inspectMigrationDatabaseUrl(databaseUrl, target);
  if (!inspection.ok) {
    return {
      ok: false,
      message: migrationUrlRejectionMessage(inspection.code),
    };
  }
  return { ok: true, databaseUrl };
}

export interface ReviewedMigrationFile {
  version: string;
  name: string;
  sha256: string;
}

export interface RecordedMigration {
  version: string;
  name: string | null;
  sha256: string;
}

export type LedgerDriftCode =
  "unknown_version" | "checksum_mismatch" | "name_mismatch" | "history_gap";

/** Recorded rows must be a checksum-matched prefix of the reviewed files. */
export function migrationLedgerDrift(
  files: readonly ReviewedMigrationFile[],
  recorded: readonly RecordedMigration[],
): { ok: true } | { ok: false; code: LedgerDriftCode } {
  const byVersion = new Map(recorded.map((row) => [row.version, row]));
  const expected = new Set(files.map((file) => file.version));
  for (const version of byVersion.keys()) {
    if (!expected.has(version)) return { ok: false, code: "unknown_version" };
  }
  let prefix = 0;
  while (prefix < files.length && byVersion.has(files[prefix]!.version)) {
    prefix += 1;
  }
  for (let index = prefix; index < files.length; index += 1) {
    if (byVersion.has(files[index]!.version)) {
      return { ok: false, code: "history_gap" };
    }
  }
  for (let index = 0; index < prefix; index += 1) {
    const file = files[index]!;
    const row = byVersion.get(file.version)!;
    if (row.name !== file.name) return { ok: false, code: "name_mismatch" };
    if (row.sha256 !== file.sha256) {
      return { ok: false, code: "checksum_mismatch" };
    }
  }
  return { ok: true };
}

export function reviewedMigrationFiles(
  directory = "supabase/migrations",
): ReviewedMigrationFile[] {
  return readdirSync(directory)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((filename) => {
      const version = filename.slice(0, 14);
      const name = filename.slice(15, -4);
      const sha256 = createHash("sha256")
        .update(readFileSync(`${directory}/${filename}`))
        .digest("hex");
      return { version, name, sha256 };
    });
}

function statementsHash(statements: unknown): string | null {
  const text = Array.isArray(statements)
    ? statements.every((part) => typeof part === "string")
      ? statements.join("")
      : null
    : typeof statements === "string"
      ? statements
      : null;
  if (text === null) return null;
  return createHash("sha256").update(text).digest("hex");
}

function rowsFromQuery(stdout: string): RecordedMigration[] | null {
  const start = stdout.indexOf("[");
  const end = stdout.lastIndexOf("]");
  if (start < 0 || end < start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const rows: RecordedMigration[] = [];
  for (const row of parsed) {
    if (!row || typeof row !== "object") return null;
    const record = row as {
      version?: unknown;
      name?: unknown;
      statements?: unknown;
    };
    if (typeof record.version !== "string") return null;
    const sha256 = statementsHash(record.statements);
    if (!sha256) return null;
    rows.push({
      version: record.version,
      name: typeof record.name === "string" ? record.name : null,
      sha256,
    });
  }
  return rows;
}

const LEDGER_SQL =
  "select version, name, statements from supabase_migrations.schema_migrations order by version";

export function readRecordedMigrations(
  databaseUrl: string,
):
  | { ok: true; rows: RecordedMigration[] }
  | { ok: false; code: "missing" | "unreadable" } {
  const result = spawnSync(
    "pnpm",
    [
      "exec",
      "supabase",
      "db",
      "query",
      "--db-url",
      databaseUrl,
      "--output-format",
      "json",
      LEDGER_SQL,
    ],
    { encoding: "utf8" },
  );
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (result.status !== 0) {
    if (
      !output.includes("://") &&
      output.includes("schema_migrations") &&
      output.includes("does not exist")
    ) {
      return { ok: true, rows: [] };
    }
    return { ok: false, code: "unreadable" };
  }
  const rows = rowsFromQuery(result.stdout ?? "");
  if (!rows) return { ok: false, code: "unreadable" };
  return { ok: true, rows };
}

function migrationTarget(): DeploymentEnvironment | null {
  const target = process.env.MIGRATION_TARGET ?? "development";
  if (target === "development" || target === "production") return target;
  return null;
}

function main(): number {
  const target = migrationTarget();
  if (!target) {
    console.error(
      "::error::MIGRATION_TARGET must be development or production.",
    );
    return 1;
  }
  const diagnostic = migrationConnectionDiagnostic(
    process.env.SUPABASE_MIGRATION_DATABASE_URL,
    target,
  );
  if (!diagnostic.ok) {
    console.error(`::error::${diagnostic.message}`);
    return 1;
  }
  if (!process.argv.includes("--ledger")) {
    console.log(`Migration URL accepted for the ${target} project.`);
    return 0;
  }
  const recorded = readRecordedMigrations(diagnostic.databaseUrl);
  if (!recorded.ok) {
    console.error(
      "::error::The migration ledger could not be read. No migration was applied.",
    );
    return 1;
  }
  const drift = migrationLedgerDrift(reviewedMigrationFiles(), recorded.rows);
  if (!drift.ok) {
    console.error(
      `::error::Recorded migration history does not match the reviewed files: ${drift.code}. No migration was applied.`,
    );
    return 1;
  }
  console.log("Recorded migration history matches the reviewed files.");
  return 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = main();
}
