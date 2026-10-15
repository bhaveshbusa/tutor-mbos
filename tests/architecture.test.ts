import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

type Layer =
  | "app"
  | "adapters/http"
  | "adapters/mcp"
  | "server/application"
  | "server/config"
  | "server/domain"
  | "server/query";

const LAYERS: Layer[] = [
  "app",
  "adapters/http",
  "adapters/mcp",
  "server/application",
  "server/config",
  "server/domain",
  "server/query",
];

const ALLOWED_INTERNAL: Record<Layer, Layer[]> = {
  app: [
    "app",
    "adapters/http",
    "adapters/mcp",
    "server/application",
    "server/query",
  ],
  "adapters/http": [
    "adapters/http",
    "server/application",
    "server/config",
    "server/query",
    "server/domain",
  ],
  "adapters/mcp": [
    "adapters/mcp",
    "adapters/http",
    "server/application",
    "server/config",
    "server/query",
    "server/domain",
  ],
  "server/application": [
    "server/application",
    "server/config",
    "server/query",
    "server/domain",
  ],
  "server/config": ["server/config"],
  "server/domain": ["server/domain"],
  "server/query": ["server/query", "server/domain"],
};

const FRAMEWORK_PACKAGES = /^(next|react|react-dom)(\/|$)/;
const DOMAIN_PACKAGES = /^zod(\/|$)/;

function layerOf(file: string): Layer | undefined {
  const relative = file.replace(/^src\//, "");
  return [...LAYERS]
    .sort((a, b) => b.length - a.length)
    .find((layer) => relative === layer || relative.startsWith(`${layer}/`));
}

export function importSpecifiers(source: string): string[] {
  const pattern =
    /(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
  return [...source.matchAll(pattern)].map((m) => (m[1] ?? m[2]) as string);
}

export function layerViolations(file: string, specifiers: string[]): string[] {
  const from = layerOf(file);
  if (!from) return [`${file}: not inside a known layer`];
  const violations: string[] = [];
  for (const spec of specifiers) {
    let target: string | undefined;
    if (spec.startsWith("@/")) target = `src/${spec.slice(2)}`;
    else if (spec.startsWith("."))
      target = path.posix.join(path.posix.dirname(file), spec);
    if (target) {
      const to = layerOf(target);
      if (!to || !ALLOWED_INTERNAL[from].includes(to)) {
        violations.push(`${file}: ${from} must not import ${spec}`);
      }
      continue;
    }
    if (from.startsWith("server/") && FRAMEWORK_PACKAGES.test(spec)) {
      violations.push(`${file}: ${from} must stay framework-free (${spec})`);
    }
    if (from === "server/domain" && !DOMAIN_PACKAGES.test(spec)) {
      violations.push(`${file}: domain may only depend on zod (${spec})`);
    }
  }
  return violations;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

describe("source layering", () => {
  it("has every layer directory", () => {
    const dirs = LAYERS.map((layer) => {
      try {
        return readdirSync(`src/${layer}`).length > 0;
      } catch {
        return false;
      }
    });
    expect(dirs.every(Boolean)).toBe(true);
  });

  it("respects the dependency rules in every source file", () => {
    const files = sourceFiles("src");
    expect(files.length).toBeGreaterThan(5);
    const violations = files.flatMap((file) =>
      layerViolations(file, importSpecifiers(readFileSync(file, "utf8"))),
    );
    expect(violations).toEqual([]);
  });

  it("detects forbidden dependencies", () => {
    expect(
      layerViolations("src/server/domain/money.ts", [
        "@/server/config/environments",
      ]),
    ).toHaveLength(1);
    expect(
      layerViolations("src/server/application/x.ts", ["next/server"]),
    ).toHaveLength(1);
    expect(
      layerViolations("src/server/query/x.ts", [
        "@/server/application/service-status",
      ]),
    ).toHaveLength(1);
    expect(
      layerViolations("src/adapters/http/x.ts", ["../../app/page"]),
    ).toHaveLength(1);
    expect(
      layerViolations("src/adapters/http/x.ts", ["@/adapters/mcp/unavailable"]),
    ).toHaveLength(1);
    expect(
      layerViolations("src/server/domain/x.ts", ["date-fns"]),
    ).toHaveLength(1);
    expect(
      layerViolations("src/server/domain/x.ts", ["zod", "./other"]),
    ).toEqual([]);
  });

  it("gives database tests more than Vitest's five second default", () => {
    const timeout = readFileSync("vitest.config.ts", "utf8").match(
      /testTimeout:\s*(\d[\d_]*)/,
    );
    expect(Number(timeout?.[1]?.replaceAll("_", ""))).toBeGreaterThanOrEqual(
      15_000,
    );
  });

  it("parses static, type-only, re-export and dynamic imports", () => {
    expect(
      importSpecifiers(
        `import a from "a";\nimport type { B } from 'b';\nexport { c } from "c";\nimport "d";\nconst e = await import("e");`,
      ),
    ).toEqual(["a", "b", "c", "d", "e"]);
  });
});
