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
import { splitAndTrim } from "./sql-split.ts";

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
  /** Exact file text. Present for files read from disk. */
  text?: string;
}

export interface RecordedMigration {
  version: string;
  name: string | null;
  sha256: string;
  /** Statement list from the ledger, when the query returned one. */
  statements?: readonly string[];
}

export type LedgerDriftCode =
  "unknown_version" | "checksum_mismatch" | "name_mismatch" | "history_gap";

export interface LedgerDrift {
  ok: false;
  code: LedgerDriftCode;
  /** Safe diagnostic. Never includes SQL, a URL, or a secret. */
  detail?: string;
}

/**
 * A recorded statement list matches a reviewed file when the statements
 * concatenate to the file bytes, or when they are the list CLI 2.121.0 stores.
 * That CLI list is `splitAndTrim`: semicolons and surrounding whitespace are
 * dropped, and dollar-quoted bodies stay intact. A different statement body
 * does not match.
 */
export function recordedStatementsMatch(
  fileText: string,
  statements: readonly string[],
):
  | { ok: true }
  | { ok: false; recorded: number; reviewed: number; index?: number } {
  if (statements.join("") === fileText) return { ok: true };
  const expected = splitAndTrim(fileText);
  if (statements.length !== expected.length) {
    return {
      ok: false,
      recorded: statements.length,
      reviewed: expected.length,
    };
  }
  for (let index = 0; index < expected.length; index += 1) {
    if (statements[index] !== expected[index]) {
      return {
        ok: false,
        recorded: statements.length,
        reviewed: expected.length,
        index,
      };
    }
  }
  return { ok: true };
}

/** Recorded rows must be a checksum-matched prefix of the reviewed files. */
export function migrationLedgerDrift(
  files: readonly ReviewedMigrationFile[],
  recorded: readonly RecordedMigration[],
): { ok: true } | LedgerDrift {
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
    const statements = row.statements;
    if (statements && file.text !== undefined) {
      const match = recordedStatementsMatch(file.text, statements);
      if (!match.ok) {
        const at =
          match.index === undefined ? "" : ` statement_index=${match.index}`;
        return {
          ok: false,
          code: "checksum_mismatch",
          detail: `version=${file.version} recorded_statements=${match.recorded} reviewed_statements=${match.reviewed}${at}`,
        };
      }
      continue;
    }
    if (row.sha256 !== file.sha256) {
      return {
        ok: false,
        code: "checksum_mismatch",
        detail: `version=${file.version}`,
      };
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
      const bytes = readFileSync(`${directory}/${filename}`);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      return { version, name, sha256, text: bytes.toString("utf8") };
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

export function parseRecordedMigrations(
  stdout: string,
): RecordedMigration[] | null {
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
    const statements = Array.isArray(record.statements)
      ? record.statements.every((part) => typeof part === "string")
        ? record.statements
        : undefined
      : undefined;
    rows.push({
      version: record.version,
      name: typeof record.name === "string" ? record.name : null,
      sha256,
      ...(statements ? { statements } : {}),
    });
  }
  return rows;
}

const LEDGER_SQL =
  "select version, name, statements from supabase_migrations.schema_migrations order by version";

/**
 * CLI 2.121.0 accepts a database URL only as `--db-url`. It does not read
 * `SUPABASE_DB_URL`. The password travels in `PGPASSWORD`, which this CLI
 * sends to Postgres, and the argument URL has no password.
 */
export function migrationCliInvocation(
  databaseUrl: string,
  mode: "query" | "push",
): { args: string[]; env: NodeJS.ProcessEnv } {
  const parsed = new URL(databaseUrl);
  const password = decodePassword(parsed.password);
  parsed.password = "";
  const argsUrl = parsed.href.replace(/:\/\/([^/?#@]+):@/, "://$1@");
  if (new URL(argsUrl).password) {
    throw new Error(
      "Refusing to pass the migration password on the command line.",
    );
  }
  const args =
    mode === "query"
      ? [
          "exec",
          "supabase",
          "db",
          "query",
          "--db-url",
          argsUrl,
          "--output-format",
          "json",
          LEDGER_SQL,
        ]
      : [
          "exec",
          "supabase",
          "db",
          "push",
          "--db-url",
          argsUrl,
          "--yes",
          "--skip-vault",
        ];
  return { args, env: { ...process.env, PGPASSWORD: password } };
}

function decodePassword(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function readRecordedMigrations(
  databaseUrl: string,
):
  | { ok: true; rows: RecordedMigration[] }
  | { ok: false; code: "missing" | "unreadable" } {
  const invocation = migrationCliInvocation(databaseUrl, "query");
  const result = spawnSync("pnpm", invocation.args, {
    encoding: "utf8",
    env: invocation.env,
  });
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
  const rows = parseRecordedMigrations(result.stdout ?? "");
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
  if (process.argv.includes("--ledger") && process.argv.includes("--push")) {
    console.error("::error::Pass only one of --ledger or --push.");
    return 1;
  }
  if (!process.argv.includes("--ledger") && !process.argv.includes("--push")) {
    console.log(`Migration URL accepted for the ${target} project.`);
    return 0;
  }
  if (!ledgerMatches(diagnostic.databaseUrl)) return 1;
  if (!process.argv.includes("--push")) {
    console.log("Recorded migration history matches the reviewed files.");
    return 0;
  }
  const invocation = migrationCliInvocation(diagnostic.databaseUrl, "push");
  const applied = spawnSync("pnpm", invocation.args, {
    env: invocation.env,
    stdio: "inherit",
  });
  if (applied.status !== 0) {
    console.error(
      "::error::supabase db push did not apply the pending migrations.",
    );
    return 1;
  }
  return 0;
}

function ledgerMatches(databaseUrl: string): boolean {
  const recorded = readRecordedMigrations(databaseUrl);
  if (!recorded.ok) {
    console.error(
      "::error::The migration ledger could not be read. No migration was applied.",
    );
    return false;
  }
  const drift = migrationLedgerDrift(reviewedMigrationFiles(), recorded.rows);
  if (!drift.ok) {
    const detail = drift.detail ? ` ${drift.detail}` : "";
    console.error(
      `::error::Recorded migration history does not match the reviewed files: ${drift.code}${detail}. No migration was applied.`,
    );
    return false;
  }
  return true;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = main();
}
