import { hashSql } from "./migration-runner";
import { scramSha256Verifier } from "./scram-password";
import type { Sql } from "./sql";

/**
 * Provisions the request login used by the running app.
 *
 * Postgres 16 and later reject a non-superuser statement that edits the
 * SUPERUSER attribute. The detail says only a superuser may change that
 * attribute. The detail that only a superuser may alter roles with the
 * SUPERUSER attribute can mean the target role has rolsuper, including when
 * the statement only sets LOGIN. The BYPASSRLS attribute has the matching
 * detail. This module reports the flags it read from pg_roles and does not
 * treat either sentence as proof by itself. It creates a missing role with
 * LOGIN NOINHERIT only, and may set LOGIN and NOINHERIT on an existing safe
 * role. It grants app_request with INHERIT FALSE and SET TRUE, then revokes
 * only that membership's ADMIN option. A second grantor row fails closed
 * with every row's options and grantor still visible. The password is a
 * SCRAM-SHA-256 verifier. SUPERUSER, BYPASSRLS, CREATEROLE, CREATEDB,
 * REPLICATION, any direct membership other than one non-admin app_request
 * grant, any other effective membership, a privileged or login-capable
 * app_request, another role reachable through app_request, or an
 * app_runtime ownership or direct ACL dependency fails closed before the
 * password and before the ready log. app_request's reviewed grants on
 * schema app, its tables, and its functions stay in place, including
 * execute on the migration-owned auth wrappers. Those grants are not
 * app_runtime dependencies. Refusal still prints the role flags.
 */

export const CREATE_APP_RUNTIME_SQL = "create role app_runtime login noinherit";
export const ALIGN_APP_RUNTIME_SQL = "alter role app_runtime login noinherit";
export const GRANT_APP_REQUEST_SQL =
  "grant app_request to app_runtime with inherit false, set true";
export const REVOKE_APP_REQUEST_ADMIN_SQL =
  "revoke admin option for app_request from app_runtime";

const ALLOWED_MEMBERSHIP = "app_request";
const PRINTABLE = /^[A-Za-z0-9_]+$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SQLSTATE = /^[0-9A-Z]{5}$/;
const NOT_READY_SUFFIX = "Restricted attributes were not changed.";

export interface RoleMembership {
  role: string;
  admin: boolean;
  inherit: boolean;
  set: boolean;
  grantor: string;
}

export interface RuntimeRoleState {
  login: boolean;
  inherit: boolean;
  superuser: boolean;
  bypassrls: boolean;
  createrole: boolean;
  createdb: boolean;
  replication: boolean;
  memberOf: readonly RoleMembership[];
}

export interface RequestRoleFlags {
  login: boolean;
  superuser: boolean;
  bypassrls: boolean;
  createrole: boolean;
  createdb: boolean;
  replication: boolean;
}

export interface RuntimePrivilegeEvidence {
  role: RuntimeRoleState;
  effectiveMembers: readonly string[];
  requestRole: RequestRoleFlags;
  requestMembers: readonly string[];
  ownedOrAcl: number;
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

interface MembershipRow {
  role_name: unknown;
  admin_option: unknown;
  inherit_option: unknown;
  set_option: unknown;
  grantor_name: unknown;
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
  memberOf: readonly RoleMembership[],
): string[] {
  return [
    ...new Set(
      memberOf
        .filter((member) => member.role !== ALLOWED_MEMBERSHIP)
        .map((member) => member.role),
    ),
  ].sort();
}

function formatMembership(member: RoleMembership): string {
  return `${member.role}(admin=${member.admin},inherit=${member.inherit},set=${member.set},grantor=${member.grantor})`;
}

function orderedMemberships(
  memberOf: readonly RoleMembership[],
): RoleMembership[] {
  return [...memberOf].sort(
    (left, right) =>
      left.role.localeCompare(right.role) ||
      Number(left.admin) - Number(right.admin) ||
      Number(left.inherit) - Number(right.inherit) ||
      Number(left.set) - Number(right.set) ||
      left.grantor.localeCompare(right.grantor),
  );
}

export function formatRuntimeRoleEvidence(role: RuntimeRoleState): string {
  const members =
    role.memberOf.length > 0
      ? orderedMemberships(role.memberOf).map(formatMembership).join(",")
      : "none";
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

function formatRequestRole(role: RequestRoleFlags): string {
  return [
    `app_request_login=${role.login}`,
    `app_request_superuser=${role.superuser}`,
    `app_request_bypassrls=${role.bypassrls}`,
    `app_request_createrole=${role.createrole}`,
    `app_request_createdb=${role.createdb}`,
    `app_request_replication=${role.replication}`,
  ].join(" ");
}

export function formatRuntimePrivilegeEvidence(
  evidence: RuntimePrivilegeEvidence,
): string {
  const members =
    evidence.effectiveMembers.length > 0
      ? evidence.effectiveMembers.join(",")
      : "none";
  return [
    formatRuntimeRoleEvidence(evidence.role),
    `effective_member_of=${members}`,
    formatRequestRole(evidence.requestRole),
    `app_request_member_of=${evidence.requestMembers.join(",") || "none"}`,
    `owned_or_acl=${evidence.ownedOrAcl}`,
  ].join(" ");
}

export function runtimeRoleNotReady(role: RuntimeRoleState): string {
  return `${formatRuntimeRoleEvidence(role)}. ${NOT_READY_SUFFIX}`;
}

function notReady(detail: string): string {
  return `app_runtime is not ready: ${detail}. ${NOT_READY_SUFFIX}`;
}

export function formatSchemaLedgerLine(entry: SchemaLedgerEntry): string {
  return `schema ledger version=${entry.version} name=${entry.name} sha256=${entry.sha256}`;
}

export function assertLedgerMatches(
  ledger: readonly SchemaLedgerEntry[],
  expected: readonly Pick<SchemaLedgerEntry, "version" | "name" | "sha256">[],
): void {
  const matches =
    ledger.length === expected.length &&
    ledger.every(
      (entry, index) =>
        entry.version === expected[index]?.version &&
        entry.name === expected[index]?.name &&
        entry.sha256 === expected[index]?.sha256,
    );
  if (!matches) {
    throw new Error("schema ledger does not match the reviewed migration set");
  }
}

export function safeRuntimeFailure(error: unknown, password: string): string {
  const message = error instanceof Error ? error.message : "";
  if (
    !message ||
    (password !== "" && message.includes(password)) ||
    message.includes("SCRAM-SHA-256$")
  ) {
    return "app_runtime is not ready.";
  }
  return message;
}

function flag(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(notReady(`${name} was not readable`));
  }
  return value;
}

function sqlStateSuffix(error: unknown): string {
  if (
    typeof error !== "object" ||
    error === null ||
    !("code" in error) ||
    typeof error.code !== "string" ||
    !SQLSTATE.test(error.code)
  ) {
    return "";
  }
  return ` sqlstate=${error.code}`;
}

function roleEvidence(role: RuntimeRoleState | null): string {
  return role ? formatRuntimeRoleEvidence(role) : "role app_runtime absent";
}

function refuse(
  phase: string,
  role: RuntimeRoleState | null,
  detail?: string,
  error?: unknown,
): Error {
  const extra = detail ? ` ${detail}` : "";
  const message = `${roleEvidence(role)} phase=${phase}${extra}. ${NOT_READY_SUFFIX}`;
  const suffix = error === undefined ? "" : sqlStateSuffix(error);
  return new Error(`${message}${suffix}`);
}

function assertSafe(role: RuntimeRoleState): void {
  if (restrictedRuntimeAttributes(role).length > 0) {
    throw refuse("flags", role);
  }
  if (
    unexpectedRuntimeMemberships(role.memberOf).length > 0 ||
    role.memberOf.length > 1
  ) {
    throw refuse("membership", role);
  }
}

function isExactMembership(role: RuntimeRoleState): boolean {
  const member = role.memberOf[0];
  return (
    role.login &&
    !role.inherit &&
    role.memberOf.length === 1 &&
    member !== undefined &&
    member.role === ALLOWED_MEMBERSHIP &&
    !member.admin &&
    !member.inherit &&
    member.set
  );
}

function isSafeRequestRole(role: RequestRoleFlags): boolean {
  return (
    !role.login &&
    !role.superuser &&
    !role.bypassrls &&
    !role.createrole &&
    !role.createdb &&
    !role.replication
  );
}

function requestRoleFlags(row: RoleFlagRow): RequestRoleFlags {
  return {
    login: flag(row.rolcanlogin, "app_request login"),
    superuser: flag(row.rolsuper, "app_request superuser"),
    bypassrls: flag(row.rolbypassrls, "app_request bypassrls"),
    createrole: flag(row.rolcreaterole, "app_request createrole"),
    createdb: flag(row.rolcreatedb, "app_request createdb"),
    replication: flag(row.rolreplication, "app_request replication"),
  };
}

function isExactEffective(members: readonly string[]): boolean {
  return (
    members.length === 2 &&
    members[0] === ALLOWED_MEMBERSHIP &&
    members[1] === "app_runtime"
  );
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
    throw new Error(notReady("role metadata was not unique"));
  }
  const members = await db.query<MembershipRow>(
    `select granted.rolname as role_name,
            membership.admin_option,
            membership.inherit_option,
            membership.set_option,
            grantor.rolname as grantor_name
     from pg_auth_members membership
     join pg_roles member on member.oid = membership.member
     join pg_roles granted on granted.oid = membership.roleid
     join pg_roles grantor on grantor.oid = membership.grantor
     where member.rolname = 'app_runtime'
     order by granted.rolname,
              membership.admin_option,
              membership.inherit_option,
              membership.set_option,
              grantor.rolname`,
  );
  const memberOf: RoleMembership[] = [];
  for (const member of members.rows) {
    if (
      typeof member.role_name !== "string" ||
      !PRINTABLE.test(member.role_name)
    ) {
      throw new Error(notReady("a role membership was not printable"));
    }
    if (
      typeof member.grantor_name !== "string" ||
      !PRINTABLE.test(member.grantor_name)
    ) {
      throw new Error(notReady("a membership grantor was not printable"));
    }
    memberOf.push({
      role: member.role_name,
      admin: flag(member.admin_option, "membership admin"),
      inherit: flag(member.inherit_option, "membership inherit"),
      set: flag(member.set_option, "membership set"),
      grantor: member.grantor_name,
    });
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
    throw new Error(notReady("role metadata was not readable"));
  }
  return role;
}

async function readRequestRole(db: Sql): Promise<RequestRoleFlags | null> {
  const role = await db.query<RoleFlagRow>(
    `select rolcanlogin, rolinherit, rolsuper, rolbypassrls, rolcreaterole,
            rolcreatedb, rolreplication
     from pg_roles
     where rolname = 'app_request'`,
  );
  const row = role.rows[0];
  if (!row) return null;
  if (role.rows.length !== 1) {
    throw new Error(notReady("app_request metadata was not unique"));
  }
  return requestRoleFlags(row);
}

async function readEffectiveMembers(
  db: Sql,
  roleName: "app_request" | "app_runtime",
): Promise<string[]> {
  const result = await db.query<{ rolname: unknown }>(
    roleName === "app_request"
      ? `select rolname
         from pg_roles
         where pg_has_role('app_request', oid, 'MEMBER')
         order by rolname`
      : `select rolname
         from pg_roles
         where pg_has_role('app_runtime', oid, 'MEMBER')
         order by rolname`,
  );
  const names: string[] = [];
  for (const row of result.rows) {
    if (typeof row.rolname !== "string" || !PRINTABLE.test(row.rolname)) {
      throw new Error(notReady("an effective membership was not printable"));
    }
    names.push(row.rolname);
  }
  return names;
}

function requestRefusal(
  role: RuntimeRoleState | null,
  request: RequestRoleFlags | null,
  members: readonly string[],
): Error {
  const flags = request ? formatRequestRole(request) : "app_request=missing";
  const listed = members.length > 0 ? members.join(",") : "none";
  return refuse(
    "request_role",
    role,
    `${flags} app_request_member_of=${listed}`,
  );
}

async function readOwnedOrAcl(db: Sql): Promise<number> {
  const result = await db.query<{ dependency_count: unknown }>(
    `select count(*)::int as dependency_count
     from pg_shdepend
     where refclassid = 'pg_authid'::regclass
       and refobjid = (select oid from pg_roles where rolname = 'app_runtime')
       and deptype in ('a', 'o')`,
  );
  const value = result.rows[0]?.dependency_count;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  throw new Error(notReady("ownership metadata was not readable"));
}

export async function provisionAppRuntime(
  db: Sql,
  password: string,
): Promise<RuntimePrivilegeEvidence> {
  const requestRole = await readRequestRole(db);
  const requestMembers = await readEffectiveMembers(db, "app_request");
  let role = await readRuntimeRole(db);
  if (
    !requestRole ||
    !isSafeRequestRole(requestRole) ||
    requestMembers.length !== 1 ||
    requestMembers[0] !== ALLOWED_MEMBERSHIP
  ) {
    throw requestRefusal(role, requestRole, requestMembers);
  }
  if (!role) {
    try {
      await db.exec(CREATE_APP_RUNTIME_SQL);
    } catch (error) {
      throw refuse("create", role, undefined, error);
    }
    role = await requireRole(db);
  }
  assertSafe(role);
  if (!role.login || role.inherit) {
    try {
      await db.exec(ALIGN_APP_RUNTIME_SQL);
    } catch (error) {
      throw refuse("align", role, undefined, error);
    }
    role = await requireRole(db);
    assertSafe(role);
  }
  if (!role.login || role.inherit) {
    throw refuse("align", role);
  }

  const ownedOrAcl = await readOwnedOrAcl(db);
  if (ownedOrAcl !== 0) {
    throw refuse("dependency", role, `owned_or_acl=${ownedOrAcl}`);
  }

  try {
    await db.exec(GRANT_APP_REQUEST_SQL);
  } catch (error) {
    throw refuse("grant", role, undefined, error);
  }
  try {
    await db.exec(REVOKE_APP_REQUEST_ADMIN_SQL);
  } catch (error) {
    throw refuse("revoke_admin", role, undefined, error);
  }
  role = await requireRole(db);
  assertSafe(role);
  if (!isExactMembership(role)) {
    throw refuse("membership", role);
  }

  const effectiveMembers = await readEffectiveMembers(db, "app_runtime");
  if (!isExactEffective(effectiveMembers)) {
    const listed =
      effectiveMembers.length > 0 ? effectiveMembers.join(",") : "none";
    throw refuse("effective", role, `effective_member_of=${listed}`);
  }

  const verifier = scramSha256Verifier(password);
  const quoted = await db.query<{ statement: unknown }>(
    "select format('alter role app_runtime password %L', $1::text) as statement",
    [verifier],
  );
  const statement = quoted.rows[0]?.statement;
  if (
    typeof statement !== "string" ||
    !statement.startsWith("alter role app_runtime password 'SCRAM-SHA-256$")
  ) {
    throw refuse("password", role);
  }
  try {
    await db.exec(statement);
  } catch (error) {
    throw refuse("password", role, undefined, error);
  }
  return {
    role,
    effectiveMembers,
    requestRole,
    requestMembers,
    ownedOrAcl,
  };
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
