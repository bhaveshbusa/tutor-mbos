import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import * as access from "@/server/config/access";
import { ENVIRONMENT_BINDINGS } from "@/server/config/environments";
import {
  MIGRATION_URL_REJECTION_CODES,
  migrationConnectionDiagnostic,
  migrationUrlRejectionMessage,
} from "../scripts/apply-migrations.ts";

const devRef = ENVIRONMENT_BINDINGS.development.supabaseProjectRef;
const prodRef = ENVIRONMENT_BINDINGS.production.supabaseProjectRef;
const password = "pw-sentinel-9f3a";
const host = "host-sentinel-9f3a.example";
const user = "user-sentinel-9f3a";

function connection(username: string, hostname: string, port: string): string {
  return `postgresql://${username}:${password}@${hostname}:${port}/postgres`;
}

function labeledCode(message: string): string {
  const match = message.match(
    /^SUPABASE_MIGRATION_DATABASE_URL was rejected before connection: (invalid|binding_mismatch|app_runtime|privileged_user|transaction_pooler)\. /,
  );
  expect(match?.[1]).toBeDefined();
  const code = match?.[1] ?? "";
  const guidance = message.slice(message.indexOf(". ") + 2);
  for (const candidate of MIGRATION_URL_REJECTION_CODES) {
    expect(guidance).not.toContain(candidate);
  }
  return code;
}

function expectValueFree(message: string, supplied: string): void {
  expect(message).not.toContain(supplied);
  expect(message).not.toContain(password);
  expect(message).not.toContain(host);
  expect(message).not.toContain(user);
  expect(message).not.toMatch(/\blength\b|\bsha256\b|\bhash\b/i);
  expect(message).not.toMatch(/postgres(ql)?:\/\//i);
  expect(message).not.toContain("@");
  expect(message).not.toContain("Invalid URL");
  expect(message).not.toContain("process.env");
  expect(message).not.toContain(
    createHash("sha256").update(supplied).digest("hex"),
  );
  expect(message).not.toContain(
    createHash("sha256").update(supplied).digest("base64url"),
  );
}

describe("migration URL preconnection diagnostic", () => {
  it("reports a missing URL without a reason code or an inspection", () => {
    const spy = vi.spyOn(access, "inspectMigrationDatabaseUrl");
    for (const missing of [undefined, ""]) {
      const diagnostic = migrationConnectionDiagnostic(missing);
      expect(diagnostic.ok).toBe(false);
      if (diagnostic.ok) continue;
      expect(diagnostic.message).toBe(
        "SUPABASE_MIGRATION_DATABASE_URL is required and was not set. Set it in GitHub → Settings → Environments → development → Secrets. See docs/release.md.",
      );
      for (const code of MIGRATION_URL_REJECTION_CODES) {
        expect(diagnostic.message).not.toContain(code);
      }
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("keeps the existing development-only decision and prints only that reason", () => {
    const cases = [
      "not-a-postgres-url",
      `http://[${user}`,
      `postgresql://${user}@${host}:5432/postgres`,
      connection(`postgres.${prodRef}`, `db.${prodRef}.supabase.co`, "5432"),
      connection("postgres", host, "5432"),
      connection(`app_runtime.${devRef}`, `db.${devRef}.supabase.co`, "5432"),
      connection(`service_role.${devRef}`, `db.${devRef}.supabase.co`, "5432"),
      connection(`${user}.${devRef}`, `db.${devRef}.supabase.co`, "5432"),
      connection(
        `postgres.${devRef}`,
        "aws-0-eu-west-2.pooler.supabase.com",
        "6543",
      ),
      ` ${user} `,
    ];
    for (const supplied of cases) {
      const inspection = access.inspectMigrationDatabaseUrl(supplied);
      const spy = vi.spyOn(access, "inspectMigrationDatabaseUrl");
      const diagnostic = migrationConnectionDiagnostic(supplied);
      expect(inspection.ok).toBe(false);
      expect(diagnostic.ok).toBe(inspection.ok);
      if (diagnostic.ok || inspection.ok) continue;
      expect(diagnostic.message).toBe(
        migrationUrlRejectionMessage(inspection.code),
      );
      expect(labeledCode(diagnostic.message)).toBe(inspection.code);
      expectValueFree(diagnostic.message, supplied);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(supplied);
      spy.mockRestore();
    }
  });

  it("accepts the same development migration logins the inspector accepts", () => {
    const accepted = [
      connection(`postgres.${devRef}`, `db.${devRef}.supabase.co`, "5432"),
      connection(
        `supabase_admin.${devRef}`,
        `db.${devRef}.supabase.co`,
        "5432",
      ),
      connection(
        `postgres.${devRef}`,
        "aws-0-eu-west-2.pooler.supabase.com",
        "5432",
      ),
    ];
    for (const supplied of accepted) {
      const inspection = access.inspectMigrationDatabaseUrl(supplied);
      const spy = vi.spyOn(access, "inspectMigrationDatabaseUrl");
      const diagnostic = migrationConnectionDiagnostic(supplied);
      expect(inspection).toEqual({ ok: true });
      expect(diagnostic).toEqual({ ok: true, databaseUrl: supplied });
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    }
  });

  it("does not print a reason code outside the allowlist", () => {
    const tainted = `postgresql://${user}:${password}@${host}:5432/postgres`;
    vi.spyOn(access, "inspectMigrationDatabaseUrl").mockReturnValue({
      ok: false,
      code: tainted as "invalid",
    });
    const diagnostic = migrationConnectionDiagnostic("present-but-unused");
    expect(diagnostic).toEqual({
      ok: false,
      message:
        "SUPABASE_MIGRATION_DATABASE_URL was rejected before connection. See docs/release.md.",
    });
    if (!diagnostic.ok) expectValueFree(diagnostic.message, tainted);
  });

  it("inspects the migration URL at exactly one call site", () => {
    const source = readFileSync("scripts/apply-migrations.ts", "utf8");
    expect(source.match(/inspectMigrationDatabaseUrl\(/g)).toHaveLength(1);
    expect(source).not.toContain("JSON.stringify(process.env)");
    expect(source).not.toContain("createHash");
  });
});
