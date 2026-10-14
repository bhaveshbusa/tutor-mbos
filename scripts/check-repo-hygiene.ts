/**
 * Fails when private files, credentials or real data would enter Git or a
 * deployment artifact. Reports file, line and rule only, never the value.
 *
 *   node scripts/check-repo-hygiene.ts               # tracked + unignored files
 *   node scripts/check-repo-hygiene.ts --artifact D  # build/deploy output in D
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export interface Finding {
  file: string;
  rule: string;
  line?: number;
}

export type ScanMode = "repository" | "artifact";

const PATH_RULES: {
  rule: string;
  modes: ScanMode[];
  test: (p: string) => boolean;
}[] = [
  {
    rule: "env-file",
    modes: ["repository", "artifact"],
    test: (p) => {
      const name = path.posix.basename(p);
      return (
        (name === ".env" || name.startsWith(".env.")) && name !== ".env.example"
      );
    },
  },
  {
    rule: "key-material",
    modes: ["repository", "artifact"],
    test: (p) =>
      /\.(pem|key|p12|pfx)$/i.test(p) || /(^|\/)id_(rsa|ed25519)/.test(p),
  },
  {
    rule: "vercel-local-state",
    modes: ["repository"],
    test: (p) => /(^|\/)\.vercel\//.test(p),
  },
  {
    rule: "private-data-directory",
    modes: ["repository", "artifact"],
    test: (p) => /(^|\/)(private|exports)\//.test(p) || /^data\//.test(p),
  },
  {
    rule: "database-file",
    modes: ["repository", "artifact"],
    test: (p) => /\.(sqlite3?|db|dump|backup)$/i.test(p),
  },
  {
    rule: "spreadsheet-outside-synthetic-fixtures",
    modes: ["repository", "artifact"],
    test: (p) =>
      /\.(csv|xlsx?)$/i.test(p) && !p.startsWith("tests/fixtures/synthetic/"),
  },
];

const CONTENT_RULES: { rule: string; modes: ScanMode[]; pattern: RegExp }[] = [
  {
    rule: "private-key",
    modes: ["repository", "artifact"],
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  },
  {
    rule: "supabase-secret-key",
    modes: ["repository", "artifact"],
    pattern: /sb_secret_[A-Za-z0-9_-]{10,}/,
  },
  {
    rule: "github-token",
    modes: ["repository", "artifact"],
    pattern: /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/,
  },
  {
    rule: "jwt",
    modes: ["repository"],
    pattern: /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  },
  {
    rule: "supabase-publishable-key",
    modes: ["repository"],
    pattern: /sb_publishable_[A-Za-z0-9_-]{10,}/,
  },
  {
    rule: "database-url-with-password",
    modes: ["repository", "artifact"],
    pattern: /postgres(?:ql)?:\/\/[^\s:/@"'`]+:(?![<[{$])[^\s@"'`<>]+@/,
  },
];

const JWT = /eyJ[A-Za-z0-9_-]{8,}\.(eyJ[A-Za-z0-9_-]{8,})\.[A-Za-z0-9_-]{8,}/g;

function hasPrivilegedJwt(line: string): boolean {
  for (const match of line.matchAll(JWT)) {
    try {
      const payload = JSON.parse(
        Buffer.from(match[1] ?? "", "base64url").toString("utf8"),
      ) as { role?: unknown };
      if (payload.role === "service_role") return true;
    } catch {
      // Not a decodable token payload.
    }
  }
  return false;
}

export function scanPath(file: string, mode: ScanMode): Finding[] {
  const normalized = file.split(path.sep).join("/");
  return PATH_RULES.filter(
    (r) => r.modes.includes(mode) && r.test(normalized),
  ).map((r) => ({ file: normalized, rule: r.rule }));
}

export function scanContent(
  file: string,
  content: string,
  mode: ScanMode,
): Finding[] {
  const findings: Finding[] = [];
  const rules = CONTENT_RULES.filter((r) => r.modes.includes(mode));
  content.split("\n").forEach((text, index) => {
    for (const rule of rules) {
      if (rule.pattern.test(text)) {
        findings.push({ file, rule: rule.rule, line: index + 1 });
      }
    }
    if (mode === "artifact" && hasPrivilegedJwt(text)) {
      findings.push({ file, rule: "service-role-jwt", line: index + 1 });
    }
  });
  return findings;
}

function scanFile(root: string, file: string, mode: ScanMode): Finding[] {
  const findings = scanPath(file, mode);
  const absolute = path.join(root, file);
  const stats = statSync(absolute, { throwIfNoEntry: false });
  if (!stats?.isFile()) return findings;
  const buffer = readFileSync(absolute);
  if (buffer.includes(0)) return findings;
  return findings.concat(scanContent(file, buffer.toString("utf8"), mode));
}

function listRepositoryFiles(): string[] {
  const output = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { encoding: "utf8" },
  );
  return output.split("\0").filter(Boolean);
}

function listArtifactFiles(root: string, dir = ""): string[] {
  return readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap(
    (entry) => {
      const relative = path.join(dir, entry.name);
      if (entry.isDirectory()) return listArtifactFiles(root, relative);
      return entry.isFile() ? [relative] : [];
    },
  );
}

export function scanRepository(root = process.cwd()): Finding[] {
  return listRepositoryFiles().flatMap((file) =>
    scanFile(root, file, "repository"),
  );
}

export function scanArtifact(root: string): Finding[] {
  // Next.js writes its own cache under .next/cache; it is never deployed.
  return listArtifactFiles(root)
    .filter((file) => !file.split(path.sep).join("/").startsWith("cache/"))
    .flatMap((file) => scanFile(root, file, "artifact"));
}

function main(argv: string[]): number {
  const artifactIndex = argv.indexOf("--artifact");
  const artifactDir = artifactIndex >= 0 ? argv[artifactIndex + 1] : undefined;
  if (artifactIndex >= 0 && !artifactDir) {
    console.error("Usage: check-repo-hygiene.ts [--artifact <dir>]");
    return 2;
  }
  const findings = artifactDir ? scanArtifact(artifactDir) : scanRepository();
  const scope = artifactDir ? `artifact ${artifactDir}` : "repository";
  if (findings.length === 0) {
    console.log(`Hygiene check passed for ${scope}.`);
    return 0;
  }
  for (const f of findings) {
    console.error(`${f.file}${f.line ? `:${f.line}` : ""}: ${f.rule}`);
  }
  console.error(
    `Hygiene check failed for ${scope}: ${findings.length} finding(s).`,
  );
  return 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = main(process.argv.slice(2));
}
