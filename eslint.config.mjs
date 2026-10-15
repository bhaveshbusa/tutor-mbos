import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const frameworkImports = {
  group: ["next", "next/*", "react", "react/*", "react-dom", "react-dom/*"],
  message:
    "Shared server layers stay framework-free so UI, API and MCP reuse them.",
};
const adapterImports = {
  group: ["@/app", "@/app/*", "@/adapters", "@/adapters/*"],
  message: "Shared server layers must not depend on UI or client adapters.",
};

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    ".next/**",
    ".vercel/**",
    "out/**",
    "build/**",
    "coverage/**",
    "next-env.d.ts",
  ]),
  {
    files: ["src/server/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [frameworkImports, adapterImports] },
      ],
    },
  },
  {
    files: ["src/adapters/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/app", "@/app/*"],
              message: "Adapters must not depend on Next.js route files.",
            },
          ],
        },
      ],
    },
  },
]);
