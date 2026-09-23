import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Root temp directory for one vitest run. Computed from the main process pid so
 * vitest.config.ts (which passes it to workers as DATA_DIR) and the global setup
 * (which creates and removes it) agree without sharing state.
 */
export function runDataDir(): string {
  return path.join(os.tmpdir(), `accessaudit-vitest-${process.pid}`);
}

/**
 * Gives the calling test file its own DATA_DIR (a fresh mkdtemp under the run
 * directory) and returns it. Call this BEFORE dynamically importing src/db.js
 * or any module that imports it, e.g.
 *
 *   const dataDir = useFreshDataDir("orders");
 *   const { db } = await import("../../src/db.js");
 */
export function useFreshDataDir(label = "test"): string {
  const base = process.env.DATA_DIR && process.env.DATA_DIR.trim() !== "" ? process.env.DATA_DIR : runDataDir();
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, `${label}-`));
  process.env.DATA_DIR = dir;
  return dir;
}
