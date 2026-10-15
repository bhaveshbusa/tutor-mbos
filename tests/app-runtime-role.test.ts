import { pbkdf2Sync } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  SCRAM_SHA256_ITERATIONS,
  scramSha256Accepts,
  scramSha256ReproducesStoredSecret,
  scramSha256Verifier,
} from "@/server/application/scram-password";
import {
  ALIGN_APP_RUNTIME_SQL,
  CREATE_APP_RUNTIME_SQL,
  GRANT_APP_REQUEST_SQL,
  REVOKE_APP_REQUEST_ADMIN_SQL,
  assertLedgerMatches,
  formatRuntimePrivilegeEvidence,
  formatRuntimeRoleEvidence,
  formatSchemaLedgerLine,
  provisionAppRuntime,
  readRuntimeRole,
  readSchemaLedger,
  restrictedRuntimeAttributes,
  runtimeRoleNotReady,
  safeRuntimeFailure,
  unexpectedRuntimeMemberships,
  type RequestRoleFlags,
  type RoleMembership,
  type RuntimePrivilegeEvidence,
  type RuntimeRoleState,
} from "@/server/application/app-runtime-role";
import {
  applyMigrations,
  hashSql,
  loadMigrationFiles,
} from "@/server/application/migration-runner";
import type { Sql, SqlConnection } from "@/server/application/sql";
import { emptyDatabase, migrationManifest } from "./helpers/database";

const password = "pw-sentinel-9f3a";

const requestGrant: RoleMembership = {
  role: "app_request",
  admin: false,
  inherit: false,
  set: true,
  grantor: "migration_login",
};

const safeRequest: RequestRoleFlags = {
  login: false,
  superuser: false,
  bypassrls: false,
  createrole: false,
  createdb: false,
  replication: false,
};

const safeRole: RuntimeRoleState = {
  login: true,
  inherit: false,
  superuser: false,
  bypassrls: false,
  createrole: false,
  createdb: false,
  replication: false,
  memberOf: [requestGrant],
};

const ready: RuntimePrivilegeEvidence = {
  role: safeRole,
  effectiveMembers: ["app_request", "app_runtime"],
  requestRole: safeRequest,
  requestMembers: ["app_request"],
  ownedOrAcl: 0,
};

function recording(connection: Sql): { sql: Sql; statements: string[] } {
  const statements: string[] = [];
  const sql: Sql = {
    async query(text, params) {
      statements.push(text);
      return connection.query(text, params);
    },
    async exec(text) {
      statements.push(text);
      await connection.exec(text);
    },
  };
  return { sql, statements };
}

async function migrated(): Promise<SqlConnection> {
  const { connection } = await emptyDatabase();
  const manifest = migrationManifest();
  await applyMigrations(
    connection,
    loadMigrationFiles("supabase/migrations", manifest),
    manifest.lockKey,
  );
  return connection;
}

async function useMigrationLogin(connection: SqlConnection): Promise<void> {
  await connection.exec(`
    create role migration_login
      nosuperuser createrole nobypassrls nocreatedb noreplication noinherit
  `);
  await connection.exec(
    "grant app_request to migration_login with admin true, inherit false, set false",
  );
  await connection.exec("set session authorization migration_login");
}

function statementVerifier(statements: readonly string[]): string {
  const statement = statements.find((entry) =>
    entry.startsWith("alter role app_runtime password '"),
  );
  if (!statement?.endsWith("'")) return "";
  return statement.slice("alter role app_runtime password '".length, -1);
}

function expectOrdinarySql(statements: readonly string[]): void {
  const sql = statements.join("\n").toLowerCase();
  expect(sql).not.toMatch(/\bnosuperuser\b/);
  expect(sql).not.toMatch(/\bnobypassrls\b/);
  expect(sql).not.toMatch(/\bbypassrls\b/);
  expect(sql).not.toMatch(/\bsuperuser\b/);
  expect(sql).not.toMatch(/\bcreaterole\b/);
  expect(sql).not.toMatch(/\bcreatedb\b/);
  expect(sql).not.toMatch(/\breplication\b/);
}

function expectVerifierOnly(statements: readonly string[]): void {
  const sql = statements.join("\n");
  expect(sql).toContain("SCRAM-SHA-256$");
  expect(sql).not.toContain(password);
}

async function rejection(
  connection: SqlConnection,
  passwordText: string,
): Promise<{ message: string; statements: string[] }> {
  const recorded = recording(connection);
  let message = "";
  try {
    await provisionAppRuntime(recorded.sql, passwordText);
  } catch (error) {
    message = error instanceof Error ? error.message : "";
  }
  return { message, statements: recorded.statements };
}

describe("app runtime role provisioning", () => {
  it("names restricted attributes without treating them as ordinary changes", () => {
    expect(restrictedRuntimeAttributes(safeRole)).toEqual([]);
    expect(
      unexpectedRuntimeMemberships([
        requestGrant,
        {
          role: "platform_admin",
          admin: true,
          inherit: true,
          set: true,
          grantor: "postgres",
        },
      ]),
    ).toEqual(["platform_admin"]);
    const unsafe: RuntimeRoleState = {
      ...safeRole,
      login: false,
      bypassrls: true,
      memberOf: [
        {
          role: "platform_admin",
          admin: false,
          inherit: true,
          set: true,
          grantor: "postgres",
        },
      ],
    };
    expect(restrictedRuntimeAttributes(unsafe)).toEqual(["bypassrls"]);
    const message = runtimeRoleNotReady(unsafe);
    expect(message).toContain("bypassrls=true");
    expect(message).toContain("superuser=false");
    expect(message).toContain(
      "member_of=platform_admin(admin=false,inherit=true,set=true,grantor=postgres)",
    );
    expect(message).not.toContain("member_of=platform_admin,");
    expect(message).toContain("Restricted attributes were not changed.");
    expect(message).not.toContain("is ready");
    const duplicated: RuntimeRoleState = {
      ...safeRole,
      memberOf: [
        {
          role: "app_request",
          admin: true,
          inherit: true,
          set: true,
          grantor: "other_grantor",
        },
        requestGrant,
      ],
    };
    const duplicateLine = formatRuntimeRoleEvidence(duplicated);
    expect(duplicateLine).toContain(
      "member_of=app_request(admin=false,inherit=false,set=true,grantor=migration_login),app_request(admin=true,inherit=true,set=true,grantor=other_grantor)",
    );
    expect(duplicateLine).not.toContain("member_of=app_request,app_request");
    expect(formatRuntimeRoleEvidence(unsafe)).not.toContain(password);
    expect(safeRuntimeFailure(new Error(message), password)).toBe(message);
    expect(safeRuntimeFailure(new Error(`bad ${password}`), password)).toBe(
      "app_runtime is not ready.",
    );
    expect(
      safeRuntimeFailure(
        new Error(
          "alter role password 'SCRAM-SHA-256$4096:salt$stored:server'",
        ),
        password,
      ),
    ).toBe("app_runtime is not ready.");
    const verifier = scramSha256Verifier(password);
    expect(verifier).toMatch(
      /^SCRAM-SHA-256\$4096:[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$/,
    );
    expect(verifier).not.toContain(password);
    expect(scramSha256Verifier(password)).not.toBe(verifier);
  });

  it("prints ledger hashes that match the reviewed files", async () => {
    const connection = await migrated();
    const manifest = migrationManifest();
    const ledger = await readSchemaLedger(connection);
    expect(ledger.map((entry) => entry.version)).toEqual(
      manifest.migrations.map((entry) => entry.version),
    );
    expect(ledger.map((entry) => entry.sha256)).toEqual(
      manifest.migrations.map((entry) => entry.sha256),
    );
    const files = loadMigrationFiles("supabase/migrations", manifest);
    expect(ledger.map((entry) => entry.sha256)).toEqual(
      files.map((file) => hashSql(file.sql)),
    );
    expect(() =>
      assertLedgerMatches(ledger, manifest.migrations),
    ).not.toThrow();
    expect(() =>
      assertLedgerMatches(
        ledger.map((entry, index) =>
          index === 0 ? { ...entry, sha256: "a".repeat(64) } : entry,
        ),
        manifest.migrations,
      ),
    ).toThrow(/^schema ledger does not match the reviewed migration set$/);
    const line = formatSchemaLedgerLine(ledger[0]!);
    expect(line).toMatch(
      /^schema ledger version=\d+ name=[A-Za-z0-9_]+ sha256=[a-f0-9]{64}$/,
    );
    expect(line).not.toContain("create table");
    expect(line).not.toContain(password);
  });

  it("rejects explicit nosuperuser from a non-superuser login", async () => {
    const connection = await migrated();
    await connection.exec(
      "create role app_runtime login noinherit nosuperuser nobypassrls",
    );
    await connection.exec(`
      create role migration_login
        nosuperuser createrole nobypassrls nocreatedb noreplication noinherit
    `);
    await connection.exec(
      "grant app_runtime to migration_login with admin true, inherit false, set false",
    );
    await connection.exec("set session authorization migration_login");
    await connection.exec("alter role app_runtime login noinherit");
    await expect(
      connection.exec(
        "alter role app_runtime login nosuperuser nobypassrls noinherit",
      ),
    ).rejects.toThrow(/permission denied to alter role/);
  });

  it("provisions a missing role as a non-superuser migration login", async () => {
    const connection = await migrated();
    await useMigrationLogin(connection);
    const recorded = recording(connection);
    const evidence = await provisionAppRuntime(recorded.sql, password);
    expect(evidence).toEqual(ready);
    expectOrdinarySql(recorded.statements);
    expect(recorded.statements).toContain(CREATE_APP_RUNTIME_SQL);
    expect(recorded.statements).toContain(REVOKE_APP_REQUEST_ADMIN_SQL);
    expectVerifierOnly(recorded.statements);
    expect(
      scramSha256Accepts(statementVerifier(recorded.statements), password),
    ).toBe(true);
    expect(
      scramSha256Accepts(
        statementVerifier(recorded.statements),
        "other-secret",
      ),
    ).toBe(false);
    const line = formatRuntimePrivilegeEvidence(evidence);
    expect(line).toContain(
      "member_of=app_request(admin=false,inherit=false,set=true,grantor=migration_login)",
    );
    expect(line).toContain("app_request_member_of=app_request");
    expect(line).toContain("effective_member_of=app_request,app_runtime");
    expect(line).toContain("owned_or_acl=0");
    expect(line).not.toContain(password);
    expect(line).not.toContain("SCRAM-SHA-256");
    expect(line).not.toContain("is ready");
  });

  it("sets login and noinherit on an existing safe role", async () => {
    const connection = await migrated();
    await connection.exec("create role app_runtime nosuperuser nobypassrls");
    await connection.exec(`
      create role migration_login
        nosuperuser createrole nobypassrls nocreatedb noreplication noinherit
    `);
    await connection.exec(
      "grant app_request to migration_login with admin true, inherit false, set false",
    );
    await connection.exec(
      "grant app_runtime to migration_login with admin true, inherit false, set false",
    );
    await connection.exec("set session authorization migration_login");
    const recorded = recording(connection);
    const evidence = await provisionAppRuntime(recorded.sql, password);
    expect(evidence).toEqual(ready);
    expectOrdinarySql(recorded.statements);
    expect(recorded.statements).toContain(ALIGN_APP_RUNTIME_SQL);
    expectVerifierOnly(recorded.statements);
  });

  it("revokes an existing admin option on the same grant", async () => {
    const connection = await migrated();
    await connection.exec(`
      create role migration_login
        nosuperuser createrole nobypassrls nocreatedb noreplication noinherit
    `);
    await connection.exec(
      "grant app_request to migration_login with admin true, inherit false, set false",
    );
    await connection.exec(
      "create role app_runtime login noinherit nosuperuser nobypassrls",
    );
    await connection.exec(
      "grant app_runtime to migration_login with admin true, inherit false, set false",
    );
    await connection.exec("set session authorization migration_login");
    await connection.exec(
      "grant app_request to app_runtime with admin true, inherit true, set false",
    );
    const recorded = recording(connection);
    const evidence = await provisionAppRuntime(recorded.sql, password);
    expect(evidence).toEqual(ready);
    expect(recorded.statements).toContain(GRANT_APP_REQUEST_SQL);
    expect(recorded.statements).toContain(REVOKE_APP_REQUEST_ADMIN_SQL);
    expectOrdinarySql(recorded.statements);
    expectVerifierOnly(recorded.statements);
  });

  it("reprovisions an existing safe role without altering restricted attributes", async () => {
    const connection = await migrated();
    await connection.exec(
      "create role app_runtime login noinherit nosuperuser nobypassrls",
    );
    await connection.exec(`
      create role migration_login
        nosuperuser createrole nobypassrls nocreatedb noreplication noinherit
    `);
    await connection.exec(
      "grant app_request to migration_login with admin true, inherit false, set false",
    );
    await connection.exec(
      "grant app_runtime to migration_login with admin true, inherit false, set false",
    );
    await connection.exec("set session authorization migration_login");
    const first = recording(connection);
    expect(await provisionAppRuntime(first.sql, password)).toEqual(ready);
    const second = recording(connection);
    expect(await provisionAppRuntime(second.sql, password)).toEqual(ready);
    expectOrdinarySql(first.statements);
    expectOrdinarySql(second.statements);
    expectVerifierOnly(second.statements);
    expect(second.statements.join("\n")).not.toContain("create role");
    expect(second.statements.join("\n")).not.toContain(ALIGN_APP_RUNTIME_SQL);
    expect(await readRuntimeRole(connection)).toEqual(safeRole);
  });

  it("rejects an existing bypassrls role before it can serve requests", async () => {
    const connection = await migrated();
    await connection.exec(
      "create role app_runtime bypassrls nologin noinherit nosuperuser",
    );
    await useMigrationLogin(connection);
    const recorded = recording(connection);
    let message = "";
    await expect(provisionAppRuntime(recorded.sql, password)).rejects.toThrow(
      /bypassrls=true/,
    );
    try {
      await provisionAppRuntime(recorded.sql, password);
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }
    expect(message).toContain("superuser=false");
    expect(message).toContain("phase=flags");
    expect(message).toContain("Restricted attributes were not changed.");
    expect(message).not.toContain("is ready");
    expect(message).not.toContain(password);
    const issued = recorded.statements.join("\n");
    expect(issued).not.toContain("alter role");
    expect(issued).not.toContain("grant app_request");
    expect(issued).not.toContain("password");
    expect(await readRuntimeRole(connection)).toMatchObject({
      bypassrls: true,
      superuser: false,
    });
  });

  it("rejects superuser and unexpected membership before the runtime role is ready", async () => {
    const superuserDb = await migrated();
    await superuserDb.exec("create role app_runtime superuser nologin");
    await useMigrationLogin(superuserDb);
    const superuserCalls = recording(superuserDb);
    await expect(
      provisionAppRuntime(superuserCalls.sql, password),
    ).rejects.toThrow(/superuser=true/);
    expect(superuserCalls.statements.join("\n")).not.toContain("password");
    expect(await readRuntimeRole(superuserDb)).toMatchObject({
      superuser: true,
    });

    const memberDb = await migrated();
    await memberDb.exec(`
      create role platform_admin nologin nosuperuser nobypassrls;
      create role app_runtime login noinherit nosuperuser nobypassrls;
      grant platform_admin to app_runtime;
    `);
    await useMigrationLogin(memberDb);
    const memberCalls = recording(memberDb);
    await expect(
      provisionAppRuntime(memberCalls.sql, password),
    ).rejects.toThrow(
      /member_of=platform_admin\(admin=false,inherit=false,set=true,grantor=postgres\)/,
    );
    expect(memberCalls.statements.join("\n")).not.toContain("password");
    expect(memberCalls.statements.join("\n")).not.toContain("is ready");
    expect(memberCalls.statements.join("\n")).not.toContain("alter role");
    expect(await readRuntimeRole(memberDb)).toMatchObject({
      memberOf: [
        {
          role: "platform_admin",
          admin: false,
          inherit: false,
          set: true,
          grantor: "postgres",
        },
      ],
    });
  });

  it("rejects a second grantor row and keeps both option tuples visible", async () => {
    const connection = await migrated();
    await connection.exec(`
      create role app_runtime login noinherit nosuperuser nobypassrls;
      create role other_grantor
        nosuperuser createrole nobypassrls nocreatedb noreplication noinherit;
    `);
    await connection.exec(
      "grant app_request to other_grantor with admin true, inherit false, set false",
    );
    await connection.exec(
      "grant app_request to app_runtime with admin false, inherit true, set true",
    );
    await connection.exec("set session authorization other_grantor");
    await connection.exec(
      "grant app_request to app_runtime with admin true, inherit false, set false",
    );
    await connection.exec("reset session authorization");
    await useMigrationLogin(connection);
    const { message, statements } = await rejection(connection, password);
    expect(message).toContain(
      "app_request(admin=false,inherit=true,set=true,grantor=postgres)",
    );
    expect(message).toContain(
      "app_request(admin=true,inherit=false,set=false,grantor=other_grantor)",
    );
    expect(message).toContain("phase=membership");
    expect(message).not.toContain("member_of=app_request,app_request");
    expect(message).toContain("Restricted attributes were not changed.");
    expect(message).not.toContain("is ready");
    expect(message).not.toContain(password);
    expect(message).not.toContain("SCRAM-SHA-256");
    const issued = statements.join("\n");
    expect(issued).not.toContain("password");
    expect(issued).not.toContain(password);
    expect(issued).not.toContain(GRANT_APP_REQUEST_SQL);
  });

  it("rejects transitive membership before the password is set", async () => {
    const connection = await migrated();
    await connection.exec(`
      create role transit_role nologin nosuperuser nobypassrls nocreatedb noreplication noinherit;
      grant transit_role to app_request;
      create role app_runtime login noinherit nosuperuser nobypassrls;
    `);
    await useMigrationLogin(connection);
    const { message, statements } = await rejection(connection, password);
    expect(message).toContain("app_request_member_of=app_request,transit_role");
    expect(message).toContain("phase=request_role");
    expect(message).toContain("login=");
    expect(message).toContain("Restricted attributes were not changed.");
    expect(message).not.toContain("is ready");
    expect(message).not.toContain(password);
    expect(statements.join("\n")).not.toContain(password);
    expect(statements.join("\n")).not.toContain("SCRAM-SHA-256$");
    expect(statements.join("\n")).not.toContain(GRANT_APP_REQUEST_SQL);
    expect(statements.join("\n")).not.toContain("alter role app_request");
  });

  it("rejects a request role that can bypass row level security", async () => {
    const connection = await migrated();
    await connection.exec("alter role app_request bypassrls");
    await connection.exec(
      "create role app_runtime login noinherit nosuperuser nobypassrls",
    );
    await useMigrationLogin(connection);
    const { message, statements } = await rejection(connection, password);
    expect(message).toContain("phase=request_role");
    expect(message).toContain("app_request_bypassrls=true");
    expect(message).toContain("app_request_login=false");
    expect(message).toContain("login=true");
    expect(message).toContain("Restricted attributes were not changed.");
    expect(message).not.toContain("is ready");
    expect(message).not.toContain(password);
    const issued = statements.join("\n");
    expect(issued).not.toContain("alter role");
    expect(issued).not.toContain(GRANT_APP_REQUEST_SQL);
    expect(issued).not.toContain("password");
  });

  it("rejects ownership and direct ACLs before the password is set", async () => {
    const owned = await migrated();
    await owned.exec(`
      create role app_runtime login noinherit nosuperuser nobypassrls;
      create table app.owned_probe (id int);
      alter table app.owned_probe owner to app_runtime;
    `);
    await useMigrationLogin(owned);
    const ownedFailure = await rejection(owned, password);
    expect(ownedFailure.message).toContain("phase=dependency");
    expect(ownedFailure.message).toContain("login=true");
    expect(ownedFailure.message).toMatch(/owned_or_acl=[1-9]/);
    expect(ownedFailure.message).not.toContain("is ready");
    expect(ownedFailure.message).not.toContain(password);
    expect(ownedFailure.statements.join("\n")).not.toContain("password");
    expect(ownedFailure.statements.join("\n")).not.toContain(
      GRANT_APP_REQUEST_SQL,
    );

    const acl = await migrated();
    await acl.exec(`
      create role app_runtime login noinherit nosuperuser nobypassrls;
      create table app.acl_probe (id int);
      grant select on app.acl_probe to app_runtime;
    `);
    await useMigrationLogin(acl);
    const aclFailure = await rejection(acl, password);
    expect(aclFailure.message).toMatch(/owned_or_acl=[1-9]/);
    expect(aclFailure.message).not.toContain(password);
    expect(aclFailure.statements.join("\n")).not.toContain("SCRAM-SHA-256$");
  });

  it("appends only the sqlstate when the password change is denied", async () => {
    const connection = await migrated();
    await connection.exec(
      "create role app_runtime login noinherit nosuperuser nobypassrls",
    );
    await useMigrationLogin(connection);
    const { message, statements } = await rejection(connection, password);
    expect(message).toContain("phase=password");
    expect(message).toContain("sqlstate=42501");
    expect(message).toContain("login=true");
    expect(message).toContain("superuser=false");
    expect(message).toMatch(/sqlstate=42501$/);
    expect(message).not.toContain("permission denied");
    expect(message).not.toContain("alter role app_runtime password");
    expect(message).not.toContain(password);
    expect(message).not.toContain("SCRAM-SHA-256");
    expectVerifierOnly(statements);
  });

  it("keeps reviewed app_request grants and migration-owned auth wrappers", async () => {
    const connection = await migrated();
    const privileges = await connection.query<{
      schema_usage: boolean;
      auth_uid: boolean;
      businesses: boolean;
      request_dependencies: number | string;
      owner_name: string;
    }>(`
      select
        has_schema_privilege('app_request', 'app', 'USAGE') as schema_usage,
        has_function_privilege('app_request', 'app.auth_uid()', 'EXECUTE') as auth_uid,
        has_table_privilege('app_request', 'app.businesses', 'SELECT') as businesses,
        (
          select count(*)::int
          from pg_shdepend
          where refclassid = 'pg_authid'::regclass
            and refobjid = (select oid from pg_roles where rolname = 'app_request')
            and deptype in ('a', 'o')
        ) as request_dependencies,
        (
          select owner.rolname
          from pg_proc function
          join pg_namespace namespace on namespace.oid = function.pronamespace
          join pg_roles owner on owner.oid = function.proowner
          where namespace.nspname = 'app' and function.proname = 'auth_uid'
        ) as owner_name
    `);
    const row = privileges.rows[0];
    expect(row?.schema_usage).toBe(true);
    expect(row?.auth_uid).toBe(true);
    expect(row?.businesses).toBe(true);
    expect(Number(row?.request_dependencies)).toBeGreaterThan(0);
    expect(row?.owner_name).toBe("postgres");
    await useMigrationLogin(connection);
    const first = recording(connection);
    expect(await provisionAppRuntime(first.sql, password)).toEqual(ready);
    const second = recording(connection);
    expect(await provisionAppRuntime(second.sql, password)).toEqual(ready);
    expect(first.statements.join("\n")).not.toContain("alter role app_request");
    expect(second.statements.join("\n")).not.toContain("drop role");
  });

  it("does not create app_runtime when the request role is unsafe", async () => {
    const connection = await migrated();
    await connection.exec("alter role app_request bypassrls");
    await useMigrationLogin(connection);
    const { message, statements } = await rejection(connection, password);
    expect(message).toContain("role app_runtime absent");
    expect(message).toContain("phase=request_role");
    expect(message).toContain("app_request_bypassrls=true");
    expect(message).not.toContain(password);
    const issued = statements.join("\n");
    expect(issued).not.toContain("create role");
    expect(issued).not.toContain("alter role app_request");
    expect(issued).not.toContain("password");
    const still = await connection.query<{ present: boolean }>(
      "select exists(select 1 from pg_roles where rolname = 'app_runtime') as present",
    );
    expect(still.rows[0]?.present).toBe(false);
  });

  it("reproduces PostgreSQL SCRAM secrets and checks the password exchange", async () => {
    expect(
      pbkdf2Sync("password", "salt", 4096, 32, "sha256").toString("hex"),
    ).toBe("c5e478d59288c841aa530db6845c4c8d962893a001ce4e11a4963873aa98134a");
    const { connection } = await emptyDatabase();
    const setting = await connection.query<{ scram_iterations: string }>(
      "show scram_iterations",
    );
    expect(setting.rows[0]?.scram_iterations).toBe(
      String(SCRAM_SHA256_ITERATIONS),
    );
    const encryption = await connection.query<{ password_encryption: string }>(
      "show password_encryption",
    );
    expect(encryption.rows[0]?.password_encryption).toBe("scram-sha-256");
    const cases = [
      { password: "\u2168", same: "IX" },
      { password: "pen\u00adcils", same: "pencils" },
      { password: "pen\u00a0cil", same: "pen cil" },
      { password: "a\u0001b", same: "a\u0001b" },
    ];
    for (const entry of cases) {
      await connection.exec("drop role if exists scram_probe");
      await connection.exec("create role scram_probe login");
      const quoted = await connection.query<{ statement: unknown }>(
        "select format('alter role scram_probe password %L', $1::text) as statement",
        [entry.password],
      );
      const statement = quoted.rows[0]?.statement;
      if (typeof statement !== "string") throw new Error("password statement");
      await connection.exec(statement);
      const stored = await connection.query<{ rolpassword: unknown }>(
        "select rolpassword from pg_authid where rolname = 'scram_probe'",
      );
      const secret = stored.rows[0]?.rolpassword;
      if (typeof secret !== "string") throw new Error("stored secret");
      expect(secret.includes(entry.password)).toBe(false);
      expect(scramSha256ReproducesStoredSecret(entry.password, secret)).toBe(
        true,
      );
      expect(scramSha256Accepts(secret, entry.password)).toBe(true);
      expect(scramSha256Accepts(secret, entry.same)).toBe(true);
      expect(scramSha256Accepts(secret, "other-secret")).toBe(false);
    }
  });

  it("keeps the ready log after provisioning and out of the role statements", () => {
    const script = readFileSync("scripts/apply-migrations.ts", "utf8");
    const ledgerCheck = script.indexOf("assertLedgerMatches");
    const provision = script.indexOf("await provisionAppRuntime");
    const readyLog = script.indexOf(
      "app_runtime is ready for user-scoped requests.",
    );
    expect(ledgerCheck).toBeGreaterThan(0);
    expect(provision).toBeGreaterThan(ledgerCheck);
    expect(readyLog).toBeGreaterThan(provision);
    expect(script).not.toContain("nosuperuser");
    expect(script).not.toContain("nobypassrls");
    const source = readFileSync(
      "src/server/application/app-runtime-role.ts",
      "utf8",
    );
    expect(source).not.toContain("nosuperuser");
    expect(source).not.toContain("nobypassrls");
    expect(source).not.toContain("drop role");
    expect(source).toContain("Postgres 16 and later");
    const scram = readFileSync(
      "src/server/application/scram-password.ts",
      "utf8",
    );
    expect(scram).toContain("saslprep");
    expect(scram).not.toContain("console.log");
    expect(scram).not.toContain(password);
    const release = readFileSync("docs/release.md", "utf8");
    expect(release).toContain("Postgres 16 and later");
    expect(release).toContain("rolsuper");
    expect(release).not.toContain("with supautils, a non-superuser");
  });
});
