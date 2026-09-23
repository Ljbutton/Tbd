// Builds public/sample-report.pdf (spec section 19): starts the fixture site,
// runs the real pipeline on it in a throwaway DATA_DIR with the dictionary
// narrative, and copies the PDF into public/. Run with `npm run sample`
// (which sets ALLOW_PRIVATE_TARGETS=1); the Dockerfile runs it at build time.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AuditSummary, Narrative } from "../src/types.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = path.join(ROOT, "public", "sample-report.pdf");
// A picture of the report for the landing page: phone browsers often refuse to
// render a PDF inside an iframe, so the page shows this image and links to the PDF.
const PREVIEW = path.join(ROOT, "public", "sample-report-preview.png");
const PREVIEW_WIDTH = 816; // Letter width at 96 dpi
const PREVIEW_HEIGHT = 1056; // Letter height at 96 dpi
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

    await writePreview(created.id);
    const previewSize = fs.statSync(PREVIEW).size;
    console.log(`sample: wrote ${path.relative(ROOT, PREVIEW)} (${Math.round(previewSize / 1024)} KB)`);
  } finally {
    clearTimeout(guard);
    await closeBrowser();
    await fixture.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

// Renders the same HTML the PDF was made from and photographs one Letter-sized
// page of it, starting at the executive summary (the report's first page break)
// because that page says more about the product than the cover does.
async function writePreview(auditId: string): Promise<void> {
  const { findingsForAudit, getAudit, pagesForAudit } = await import("../src/audits.js");
  const { renderReportHtml } = await import("../src/report/render.js");
  const { newScanContext } = await import("../src/scan/browser.js");

  const audit = getAudit(auditId);
  if (!audit?.summary_json || !audit.narrative_json) throw new Error("sample: summary or narrative missing for the preview");
  const html = renderReportHtml({
    audit,
    findings: findingsForAudit(auditId),
    narrative: JSON.parse(audit.narrative_json) as Narrative,
    summary: JSON.parse(audit.summary_json) as AuditSummary,
    delta: null,
    mode: "pdf",
    pages: pagesForAudit(auditId),
  });

  const context = await newScanContext("desktop");
  try {
    const page = await context.newPage();
    await page.setViewportSize({ width: PREVIEW_WIDTH, height: PREVIEW_HEIGHT });
    // Screen rendering ignores the PDF's @page margins, so give the picture the
    // margins a printed page would have: side padding on the body and top
    // padding inside the first page-broken section (the executive summary), so
    // the clip starts on that section and shows no sliver of the cover above it.
    const margin = 28;
    const pageStyle = `<style>body{padding:0 ${margin}px !important}.report .page-break{padding-top:${margin}px !important}</style>`;
    await page.setContent(html.replace("</head>", `${pageStyle}</head>`), { waitUntil: "load" });
    await page.emulateMedia({ media: "print" });
    const summaryTop = await page
      .locator(".page-break")
      .first()
      .evaluate((el) => Math.round(el.getBoundingClientRect().top + window.scrollY))
      .catch(() => 0);
    await page.screenshot({
      path: PREVIEW,
      fullPage: true,
      clip: { x: 0, y: summaryTop, width: PREVIEW_WIDTH, height: PREVIEW_HEIGHT },
    });
  } finally {
    await context.close();
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
