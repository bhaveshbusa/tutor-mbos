import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  formatRuntimeRoleEvidence,
  formatSchemaLedgerLine,
  provisionAppRuntime,
  readRuntimeRole,
  readSchemaLedger,
  restrictedRuntimeAttributes,
  runtimeRoleNotReady,
  safeRuntimeFailure,
  unexpectedRuntimeMemberships,
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

const safeRole: RuntimeRoleState = {
  login: true,
  inherit: false,
  superuser: false,
  bypassrls: false,
  createrole: false,
  createdb: false,
  replication: false,
  memberOf: ["app_request"],
};

describe("app runtime role provisioning", () => {
  it("names restricted attributes without treating them as ordinary changes", () => {
    expect(restrictedRuntimeAttributes(safeRole)).toEqual([]);
    expect(
      unexpectedRuntimeMemberships(["app_request", "platform_admin"]),
    ).toEqual(["platform_admin"]);
    const unsafe: RuntimeRoleState = {
      ...safeRole,
      login: false,
      bypassrls: true,
      memberOf: ["platform_admin"],
    };
    expect(restrictedRuntimeAttributes(unsafe)).toEqual(["bypassrls"]);
    const message = runtimeRoleNotReady(unsafe);
    expect(message).toContain("bypassrls=true");
    expect(message).toContain("superuser=false");
    expect(message).toContain("member_of=platform_admin");
    expect(message).toContain("Restricted attributes were not changed.");
    expect(message).not.toContain("is ready");
    expect(formatRuntimeRoleEvidence(unsafe)).not.toContain(password);
    expect(safeRuntimeFailure(new Error(message), password)).toBe(message);
    expect(safeRuntimeFailure(new Error(`bad ${password}`), password)).toBe(
      "app_runtime is not ready.",
    );
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
    const role = await provisionAppRuntime(recorded.sql, password);
    expect(role).toEqual(safeRole);
    expectOrdinarySql(recorded.statements);
    expect(recorded.statements).toContain(
      "create role app_runtime login noinherit",
    );
    expect(
      recorded.statements.some((statement) => statement.includes(password)),
    ).toBe(true);
    const evidence = formatRuntimeRoleEvidence(role);
    expect(evidence).not.toContain(password);
    expect(evidence).not.toContain("is ready");
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
    const role = await provisionAppRuntime(recorded.sql, password);
    expect(role).toEqual(safeRole);
    expectOrdinarySql(recorded.statements);
    expect(recorded.statements).toContain(
      "alter role app_runtime login noinherit",
    );
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
    expect(await provisionAppRuntime(first.sql, password)).toEqual(safeRole);
    const second = recording(connection);
    expect(await provisionAppRuntime(second.sql, password)).toEqual(safeRole);
    expectOrdinarySql(first.statements);
    expectOrdinarySql(second.statements);
    expect(second.statements.join("\n")).not.toContain("create role");
    expect(second.statements.join("\n")).not.toContain("login noinherit");
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
    ).rejects.toThrow(/member_of=platform_admin/);
    expect(memberCalls.statements.join("\n")).not.toContain("password");
    expect(memberCalls.statements.join("\n")).not.toContain("is ready");
    expect(await readRuntimeRole(memberDb)).toMatchObject({
      memberOf: ["platform_admin"],
    });
  });

  it("keeps the ready log after provisioning and out of the role statements", () => {
    const script = readFileSync("scripts/apply-migrations.ts", "utf8");
    const provision = script.indexOf("provisionAppRuntime");
    const ready = script.indexOf(
      "app_runtime is ready for user-scoped requests.",
    );
    expect(provision).toBeGreaterThan(0);
    expect(ready).toBeGreaterThan(provision);
    expect(script).not.toContain("nosuperuser");
    expect(script).not.toContain("nobypassrls");
    const source = readFileSync(
      "src/server/application/app-runtime-role.ts",
      "utf8",
    );
    expect(source).not.toContain("nosuperuser");
    expect(source).not.toContain("nobypassrls");
    expect(source).not.toContain("drop role");
  });
});
