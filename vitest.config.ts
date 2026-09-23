import os from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";

// Same formula as tests/unit/helpers/data-dir.ts runDataDir(): one temp
// directory per vitest run, created and removed by tests/unit/global-setup.ts.
const runDataDir = path.join(os.tmpdir(), `accessaudit-vitest-${process.pid}`);

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
    globalSetup: ["tests/unit/global-setup.ts"],
    env: {
      DATA_DIR: runDataDir,
      NODE_ENV: "test",
    },
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
