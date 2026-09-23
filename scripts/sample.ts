// Builds public/sample-report.pdf (spec section 19): starts the fixture site,
// runs the real pipeline on it in a throwaway DATA_DIR with the dictionary
// narrative, and copies the PDF into public/. Run with `npm run sample`
// (which sets ALLOW_PRIVATE_TARGETS=1); the Dockerfile runs it at build time.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = path.join(ROOT, "public", "sample-report.pdf");
const SAMPLE_EMAIL = "sample@example.com";
const SAMPLE_PAGE_LIMIT = 6;
const SAMPLE_TOKEN = "sample";
const TIME_LIMIT_MS = 3 * 60 * 1000;

// Environment must be settled before src/config.ts (and therefore src/db.ts) is imported.
process.env.ALLOW_PRIVATE_TARGETS = "1";
delete process.env.ANTHROPIC_API_KEY;
delete process.env.RESEND_API_KEY;
delete process.env.STRIPE_SECRET_KEY;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "accessaudit-sample-"));
process.env.DATA_DIR = dataDir;
if (!process.env.BASE_URL) process.env.BASE_URL = "https://accessaudit.example";

async function main(): Promise<void> {
  const { startFixtureServer } = await import("../fixtures/serve.js");
  const { ensureDirs } = await import("../src/config.js");
  const { migrate } = await import("../src/db.js");
  const { createAudit, getAudit, updateAudit } = await import("../src/audits.js");
  const { runAudit } = await import("../src/jobs/audit.js");
  const { closeBrowser } = await import("../src/scan/browser.js");

  ensureDirs();
  migrate();
  const fixture = await startFixtureServer();
  console.log(`sample: fixture site at ${fixture.url}, data dir ${dataDir}`);

  const started = Date.now();
  const guard = setTimeout(() => {
    console.error(`sample: gave up after ${Math.round(TIME_LIMIT_MS / 1000)}s`);
    process.exit(1);
  }, TIME_LIMIT_MS);
  guard.unref();

  try {
    const created = createAudit({
      email: SAMPLE_EMAIL,
      url: `${fixture.url}/`,
      origin: fixture.url,
      page_limit: SAMPLE_PAGE_LIMIT,
      white_label: 0,
      tier: "single",
    });
    updateAudit(created.id, { token: SAMPLE_TOKEN });

    await runAudit(created.id);
    const audit = getAudit(created.id);
    if (!audit || audit.status !== "ready" || !audit.pdf_path) {
      console.error(`sample: audit ended with status ${audit?.status ?? "missing"}${audit?.error ? ` (${audit.error})` : ""}`);
      console.error(audit?.log ?? "");
      process.exitCode = 1;
      return;
    }
    fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
    fs.copyFileSync(audit.pdf_path, OUTPUT);
    const size = fs.statSync(OUTPUT).size;
    console.log(`sample: wrote ${path.relative(ROOT, OUTPUT)} (${Math.round(size / 1024)} KB) in ${Math.round((Date.now() - started) / 1000)}s`);
  } finally {
    clearTimeout(guard);
    await closeBrowser();
    await fixture.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main()
  .then(() => {
    process.exit(process.exitCode ?? 0);
  })
  .catch((err: unknown) => {
    console.error("sample: failed", err);
    process.exit(1);
  });
