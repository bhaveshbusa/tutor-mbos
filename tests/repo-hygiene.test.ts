import { describe, expect, it } from "vitest";
import {
  scanContent,
  scanPath,
  scanRepository,
} from "../scripts/check-repo-hygiene.ts";

const fake = {
  supabaseSecret: "sb_" + "secret_" + "Q".repeat(24),
  publishable: "sb_" + "publishable_" + "Q".repeat(24),
  githubToken: "gh" + "p_" + "A".repeat(36),
  privateKey: "-----BEGIN " + "RSA PRIVATE KEY-----",
  databaseUrl:
    "postgresql://" +
    "postgres:hunter2" +
    "@db.example.supabase.co:5432/postgres",
  serviceRoleJwt: [
    Buffer.from('{"alg":"HS256"}').toString("base64url"),
    Buffer.from('{"role":"service_role"}').toString("base64url"),
    "c2lnbmF0dXJlLXZhbHVl",
  ].join("."),
};

describe("repository hygiene paths", () => {
  it.each([
    [".env", "env-file"],
    [".env.local", "env-file"],
    ["apps/web/.env.production", "env-file"],
    ["certs/server.pem", "key-material"],
    [".vercel/project.json", "vercel-local-state"],
    ["private/students.json", "private-data-directory"],
    ["exports/fees-2026.json", "private-data-directory"],
    ["data/roster.json", "private-data-directory"],
    ["backups/prod.dump", "database-file"],
    ["workbook.xlsx", "spreadsheet-outside-synthetic-fixtures"],
    [
      "tests/fixtures/real/roster.csv",
      "spreadsheet-outside-synthetic-fixtures",
    ],
  ])("rejects %s", (file, rule) => {
    expect(scanPath(file, "repository")).toEqual([{ file, rule }]);
  });

  it.each([
    ".env.example",
    "tests/fixtures/synthetic/students.csv",
    "src/server/domain/README.md",
  ])("allows %s", (file) => {
    expect(scanPath(file, "repository")).toEqual([]);
  });
});

describe("repository hygiene content", () => {
  it.each([
    [fake.supabaseSecret, "supabase-secret-key"],
    [fake.publishable, "supabase-publishable-key"],
    [fake.githubToken, "github-token"],
    [fake.privateKey, "private-key"],
    [fake.databaseUrl, "database-url-with-password"],
    [fake.serviceRoleJwt, "jwt"],
  ])("flags a credential-like value as %#", (value, rule) => {
    const findings = scanContent(
      "x.ts",
      `line one\nconst v = "${value}";\n`,
      "repository",
    );
    expect(findings).toEqual([{ file: "x.ts", rule, line: 2 }]);
    expect(JSON.stringify(findings)).not.toContain(value);
  });

  it("allows documented placeholders", () => {
    const text = [
      "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_<placeholder>",
      "DATABASE_URL=postgresql://postgres:<password>@db.<project-ref>.supabase.co:5432/postgres",
      "DATABASE_URL=postgresql://postgres:[YOUR-PASSWORD]@host/postgres",
      "DATABASE_URL=postgresql://postgres:${DB_PASSWORD}@host/postgres",
    ].join("\n");
    expect(scanContent("docs/x.md", text, "repository")).toEqual([]);
  });

  it("in artifacts, allows inlined public keys but flags service-role tokens", () => {
    expect(
      scanContent("chunk.js", `"${fake.publishable}"`, "artifact"),
    ).toEqual([]);
    expect(
      scanContent("chunk.js", `"${fake.serviceRoleJwt}"`, "artifact"),
    ).toEqual([{ file: "chunk.js", rule: "service-role-jwt", line: 1 }]);
    expect(
      scanContent("chunk.js", fake.supabaseSecret, "artifact"),
    ).toHaveLength(1);
  });

  it("passes for the current repository", () => {
    expect(scanRepository()).toEqual([]);
  });
});
