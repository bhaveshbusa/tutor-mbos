import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    restoreMocks: true,
    // PGlite startup on GitHub runners has exceeded Vitest's 5000ms default
    // and stopped development delivery before migrations.
    testTimeout: 20_000,
  },
});
