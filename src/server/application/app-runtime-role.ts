import { hashSql } from "./migration-runner";
import type { Sql } from "./sql";

/**
 * Provisions the request login used by the running app.
 *
 * supabase/postgres 17 with supautils rejects an explicit NOSUPERUSER or
 * NOBYPASSRLS option from a non-superuser login, including the hosted
 * `postgres` role, even when the target role does not have that attribute.
 * The resulting "alter roles with the SUPERUSER attribute" error does not
 * describe the role's actual flags. This module never sets SUPERUSER,
 * BYPASSRLS, CREATEROLE, CREATEDB, or REPLICATION. It reads those flags and
 * memberships, and it only creates the role or sets LOGIN and NOINHERIT.
 * A dangerous flag or any membership other than app_request fails closed
 * before the password is set.
 */

export const CREATE_APP_RUNTIME_SQL = "create role app_runtime login noinherit";
export const ALIGN_APP_RUNTIME_SQL = "alter role app_runtime login noinherit";
export const GRANT_APP_REQUEST_SQL =
  "grant app_request to app_runtime with inherit false, set true";

const ALLOWED_MEMBERSHIP = "app_request";
const PRINTABLE = /^[A-Za-z0-9_]+$/;
const SHA256 = /^[a-f0-9]{64}$/;

export interface RuntimeRoleState {
  login: boolean;
  inherit: boolean;
  superuser: boolean;
  bypassrls: boolean;
  createrole: boolean;
  createdb: boolean;
  replication: boolean;
  memberOf: readonly string[];
}

export interface SchemaLedgerEntry {
  version: string;
  name: string;
  sha256: string;
}

interface RoleFlagRow {
  rolcanlogin: unknown;
  rolinherit: unknown;
  rolsuper: unknown;
  rolbypassrls: unknown;
  rolcreaterole: unknown;
  rolcreatedb: unknown;
  rolreplication: unknown;
}

export function restrictedRuntimeAttributes(role: RuntimeRoleState): string[] {
  const found: string[] = [];
  if (role.superuser) found.push("superuser");
  if (role.bypassrls) found.push("bypassrls");
  if (role.createrole) found.push("createrole");
  if (role.createdb) found.push("createdb");
  if (role.replication) found.push("replication");
  return found;
}

export function unexpectedRuntimeMemberships(
  memberOf: readonly string[],
): string[] {
  return memberOf.filter((name) => name !== ALLOWED_MEMBERSHIP).sort();
}

export function formatRuntimeRoleEvidence(role: RuntimeRoleState): string {
  const members =
    role.memberOf.length > 0 ? [...role.memberOf].sort().join(",") : "none";
  return [
    "role app_runtime",
    `login=${role.login}`,
    `inherit=${role.inherit}`,
    `superuser=${role.superuser}`,
    `bypassrls=${role.bypassrls}`,
    `createrole=${role.createrole}`,
    `createdb=${role.createdb}`,
    `replication=${role.replication}`,
    `member_of=${members}`,
  ].join(" ");
}

export function runtimeRoleNotReady(role: RuntimeRoleState): string {
  return `${formatRuntimeRoleEvidence(role)}. Restricted attributes were not changed.`;
}

export function formatSchemaLedgerLine(entry: SchemaLedgerEntry): string {
  return `schema ledger version=${entry.version} name=${entry.name} sha256=${entry.sha256}`;
}

export function safeRuntimeFailure(error: unknown, password: string): string {
  const message = error instanceof Error ? error.message : "";
  if (!message || message.includes(password)) {
    return "app_runtime is not ready.";
  }
  return message;
}

function flag(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(
      `app_runtime is not ready: ${name} was not readable. Restricted attributes were not changed.`,
    );
  }
  return value;
}

function assertSafe(role: RuntimeRoleState): void {
  if (
    restrictedRuntimeAttributes(role).length > 0 ||
    unexpectedRuntimeMemberships(role.memberOf).length > 0
  ) {
    throw new Error(runtimeRoleNotReady(role));
  }
}

export async function readRuntimeRole(
  db: Sql,
): Promise<RuntimeRoleState | null> {
  const role = await db.query<RoleFlagRow>(
    `select rolcanlogin, rolinherit, rolsuper, rolbypassrls, rolcreaterole,
            rolcreatedb, rolreplication
     from pg_roles
     where rolname = 'app_runtime'`,
  );
  const row = role.rows[0];
  if (!row) return null;
  if (role.rows.length !== 1) {
    throw new Error(
      "app_runtime is not ready: role metadata was not unique. Restricted attributes were not changed.",
    );
  }
  const members = await db.query<{ role_name: unknown }>(
    `select granted.rolname as role_name
     from pg_auth_members membership
     join pg_roles member on member.oid = membership.member
     join pg_roles granted on granted.oid = membership.roleid
     where member.rolname = 'app_runtime'
     order by granted.rolname`,
  );
  const memberOf: string[] = [];
  for (const member of members.rows) {
    if (
      typeof member.role_name !== "string" ||
      !PRINTABLE.test(member.role_name)
    ) {
      throw new Error(
        "app_runtime is not ready: a role membership was not printable. Restricted attributes were not changed.",
      );
    }
    memberOf.push(member.role_name);
  }
  return {
    login: flag(row.rolcanlogin, "login"),
    inherit: flag(row.rolinherit, "inherit"),
    superuser: flag(row.rolsuper, "superuser"),
    bypassrls: flag(row.rolbypassrls, "bypassrls"),
    createrole: flag(row.rolcreaterole, "createrole"),
    createdb: flag(row.rolcreatedb, "createdb"),
    replication: flag(row.rolreplication, "replication"),
    memberOf,
  };
}

async function requireRole(db: Sql): Promise<RuntimeRoleState> {
  const role = await readRuntimeRole(db);
  if (!role) {
    throw new Error(
      "app_runtime is not ready: role metadata was not readable. Restricted attributes were not changed.",
    );
  }
  return role;
}

export async function provisionAppRuntime(
  db: Sql,
  password: string,
): Promise<RuntimeRoleState> {
  let role = await readRuntimeRole(db);
  if (!role) {
    try {
      await db.exec(CREATE_APP_RUNTIME_SQL);
    } catch {
      throw new Error(
        "app_runtime is not ready: the role could not be created. Restricted attributes were not changed.",
      );
    }
    role = await requireRole(db);
  }
  assertSafe(role);
  if (!role.login || role.inherit) {
    try {
      await db.exec(ALIGN_APP_RUNTIME_SQL);
    } catch {
      throw new Error(
        "app_runtime is not ready: login and noinherit could not be set. Restricted attributes were not changed.",
      );
    }
    role = await requireRole(db);
    assertSafe(role);
  }
  if (!role.login || role.inherit) {
    throw new Error(runtimeRoleNotReady(role));
  }
  try {
    await db.exec(GRANT_APP_REQUEST_SQL);
  } catch {
    throw new Error(
      "app_runtime is not ready: app_request could not be granted. Restricted attributes were not changed.",
    );
  }
  role = await requireRole(db);
  assertSafe(role);
  if (
    !role.login ||
    role.inherit ||
    role.memberOf.length !== 1 ||
    role.memberOf[0] !== ALLOWED_MEMBERSHIP
  ) {
    throw new Error(runtimeRoleNotReady(role));
  }
  const quoted = await db.query<{ statement: unknown }>(
    "select format('alter role app_runtime password %L', $1::text) as statement",
    [password],
  );
  const statement = quoted.rows[0]?.statement;
  if (
    typeof statement !== "string" ||
    !statement.startsWith("alter role app_runtime password ")
  ) {
    throw new Error("Could not set the app runtime password.");
  }
  try {
    await db.exec(statement);
  } catch {
    throw new Error("Could not set the app runtime password.");
  }
  return role;
}

export async function readSchemaLedger(db: Sql): Promise<SchemaLedgerEntry[]> {
  const recorded = await db.query<{
    version: unknown;
    name: unknown;
    statements: unknown;
  }>(
    `select version, name, statements
     from supabase_migrations.schema_migrations
     order by version`,
  );
  return recorded.rows.map((row) => {
    if (
      typeof row.version !== "string" ||
      typeof row.name !== "string" ||
      !PRINTABLE.test(row.version) ||
      !PRINTABLE.test(row.name) ||
      !Array.isArray(row.statements) ||
      row.statements.length === 0 ||
      row.statements.some((statement) => typeof statement !== "string")
    ) {
      throw new Error("schema ledger entry is not printable");
    }
    const sha256 = hashSql((row.statements as string[]).join(""));
    if (!SHA256.test(sha256)) {
      throw new Error("schema ledger entry is not printable");
    }
    return { version: row.version, name: row.name, sha256 };
  });
}
