import { defineConfig, devices } from "@playwright/test";

// Runs against a running app (npm run build && npm start, local demo accounts: AUDITFLOW_DEV_AUTH=1) whose
// database holds the analyzed demo (npm run seed -- --reset --analyze). E2E_PASSWORD = AUDITFLOW_DEMO_PASSWORD.
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    viewport: { width: 1400, height: 950 },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1400, height: 950 } } }],
});
