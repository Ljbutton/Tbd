import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConfig } from "@playwright/test";

const BASE_URL = "http://localhost:3101";

// Every e2e run gets its own empty data directory under the OS temp dir, so two
// runs (or a run and a stray server) can never share or wipe each other's
// database. The path is pinned in the environment because Playwright worker
// processes re-evaluate this file: they must reuse the runner's directory, not
// mint another one. tests/e2e/global-teardown.ts removes it afterwards.
const DATA_DIR = process.env.ACCESSAUDIT_E2E_DATA_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), "accessaudit-e2e-"));
process.env.ACCESSAUDIT_E2E_DATA_DIR = DATA_DIR;

export default defineConfig({
  testDir: "tests/e2e",
  globalTeardown: "./tests/e2e/global-teardown.ts",
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
    command: "npx tsx src/server.ts",
    url: `${BASE_URL}/healthz`,
    reuseExistingServer: false,
    timeout: 60000,
    env: {
      E2E: "1",
      ALLOW_PRIVATE_TARGETS: "1",
      PORT: "3101",
      DATA_DIR,
      BASE_URL,
      // The teaser limiter is per process and counts every POST /api/teaser,
      // including the invalid-URL cases the specs exercise.
      TEASER_RATE_LIMIT: "50",
    },
  },
});
