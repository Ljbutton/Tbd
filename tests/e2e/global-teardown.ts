import fs from "node:fs";

// Removes the temporary data directory playwright.config.ts created for this
// run. The prefix check keeps a misconfigured environment variable from ever
// pointing this at a real data directory.
export default function globalTeardown(): void {
  const dir = process.env.ACCESSAUDIT_E2E_DATA_DIR;
  if (dir && dir.includes("accessaudit-e2e-")) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
