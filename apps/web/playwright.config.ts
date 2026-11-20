import { defineConfig } from "@playwright/test";

// Visual and layout checks. They run against the local dev servers
// (see docs/local-testing.md). Playwright starts them if they are not
// already running, and reuses them if they are.
export default defineConfig({
  testDir: "e2e",
  outputDir: "e2e/results",
  timeout: 60_000,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:5173",
    trace: "off",
  },
  webServer: [
    {
      command: "npm run dev:api",
      cwd: "../..",
      url: "http://localhost:8787/dev/users",
      reuseExistingServer: true,
      timeout: 120_000,
    },
    {
      command: "npm run dev:web",
      cwd: "../..",
      url: "http://localhost:5173",
      reuseExistingServer: true,
      timeout: 60_000,
    },
  ],
});
