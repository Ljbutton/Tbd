import { defineConfig } from "@playwright/test";

const BASE_URL = "http://localhost:3101";

// The webServer command wipes .e2e-data itself (before the server opens the
// database) so every e2e run starts from an empty store. Do not delete
// .e2e-data from a Playwright globalSetup: that runs after the server starts.
const CLEAN_E2E_DATA = `node -e "require('node:fs').rmSync('.e2e-data', { recursive: true, force: true })"`;

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 300000,
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
  },
  webServer: {
    command: `${CLEAN_E2E_DATA} && npx tsx src/server.ts`,
    url: `${BASE_URL}/healthz`,
    reuseExistingServer: false,
    timeout: 60000,
    env: {
      E2E: "1",
      ALLOW_PRIVATE_TARGETS: "1",
      PORT: "3101",
      DATA_DIR: ".e2e-data",
      BASE_URL,
      // The teaser limiter is per process and counts every POST /api/teaser,
      // including the invalid-URL cases the specs exercise.
      TEASER_RATE_LIMIT: "50",
    },
  },
});
