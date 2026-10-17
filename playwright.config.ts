import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests/browser",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: "http://127.0.0.1:3100",
    trace: "off",
  },
  webServer: {
    command: "pnpm exec next dev --hostname 127.0.0.1 --port 3100",
    url: "http://127.0.0.1:3100/api/v1/health",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      TUTOR_MBOS_ENV: "development",
      NEXT_PUBLIC_SUPABASE_URL: "https://idvzjqrkgnihvxoswuxu.supabase.co",
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_" + "publishable_ci",
      NEXT_TELEMETRY_DISABLED: "1",
    },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
