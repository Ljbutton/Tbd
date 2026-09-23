// Shared helpers for the end-to-end specs. playwright.config.ts starts the real
// server on port 3101 with E2E=1, ALLOW_PRIVATE_TARGETS=1 and an empty
// temporary data directory; each spec starts the bundled fixture store in beforeAll
// and audits it. Nothing here touches Stripe, Anthropic or Resend.

import zlib from "node:zlib";
import { expect, type APIRequestContext, type Page } from "@playwright/test";

/** Report tokens are 128-bit base64url strings: exactly 22 characters. */
export const TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;
/** A report page URL, with or without a query string or fragment. */
export const REPORT_URL_RE = /\/r\/[A-Za-z0-9_-]{22}(?:[?#].*)?$/;
/** A five-page fixture audit takes 30-60 seconds here; leave room for a slow machine. */
export const AUDIT_WAIT_MS = 240000;
/** How long the free single-page scan may take through the UI. */
export const TEASER_WAIT_MS = 90000;
export const ADMIN_CREDENTIALS = { username: "admin", password: "admin" };
export const CSV_HEADER =
  "rank,rule_id,title,impact,confidence,category,wcag_tags,pages_affected,elements,effort,example_page,example_selector,help_url";
/** Rules the fixture store is built to fail (fixtures/site/*.html). */
export const FIXTURE_RULES = ["image-alt", "label", "button-name", "html-has-lang"] as const;

export interface StatusResponse {
  status: string;
  label: string;
  progressPages: number;
  pageLimit: number;
  progressIssues: number;
  note: string | null;
  ready: boolean;
  error: string | null;
}

export interface JsonFinding {
  rank: number;
  ruleId: string;
  impact: string;
  confidence: string;
  pagesAffected: number;
  nodesTotal: number;
  affectedUrls: string[];
  narrative: { ruleId: string; title: string; plainEnglish: string; fixSteps: string[]; effort: string };
}

export interface JsonDelta {
  originalAuditId: string;
  originalDate: string;
  rescanDate: string;
  fixed: unknown[];
  newIssues: unknown[];
  unchanged: unknown[];
  nodesBefore: number;
  nodesAfter: number;
  percentFixed: number;
}

export interface JsonReport {
  version: number;
  reportId: string;
  url: string;
  generatedAt: string;
  summary: {
    pagesRequested: number;
    pagesScanned: number;
    pagesFailed: number;
    totalViolationNodes: number;
    findingsCount: number;
    byImpact: Record<string, number>;
    byConfidence: Record<string, number>;
  };
  findings: JsonFinding[];
  manualChecks: { title: string; how: string }[];
  delta: JsonDelta | null;
}

export interface TeaserResponse {
  url: string;
  title: string;
  violationNodes: number;
  rulesFailed: number;
  top: { ruleId: string; title: string; impact: string; nodes: number; plainEnglish: string; exampleHtml: string }[];
  needsManualCount: number;
  cached: boolean;
}

/** Extracts the 22-character token from a report URL or path. */
export function tokenFromReportUrl(url: string): string {
  const match = /\/r\/([A-Za-z0-9_-]{22})(?:[?#/]|$)/.exec(url);
  if (!match) throw new Error(`Expected a report URL, got ${url}`);
  return match[1] as string;
}

/** Polls the status endpoint until the audit is ready, held or failed and returns the last response. */
export async function waitForAudit(request: APIRequestContext, token: string, timeout = AUDIT_WAIT_MS): Promise<StatusResponse> {
  const seen: { last: StatusResponse | null } = { last: null };
  await expect
    .poll(
      async () => {
        const res = await request.get(`/api/audits/${token}/status`);
        expect(res.status(), `GET /api/audits/${token}/status`).toBe(200);
        seen.last = (await res.json()) as StatusResponse;
        return seen.last.status;
      },
      { timeout, intervals: [2000], message: `audit ${token} did not reach a final status` },
    )
    .toMatch(/^(ready|failed|held)$/);
  if (!seen.last) throw new Error(`audit ${token}: the status endpoint was never read`);
  return seen.last;
}

/**
 * Fills the Site Audit / Reviewed Audit order form, pays on the mock checkout
 * and returns the report path (/r/:token) from the success page.
 */
export async function orderAndPay(page: Page, options: { product: "single" | "reviewed"; url: string; email: string }): Promise<string> {
  await page.goto(`/order?product=${options.product}&url=${encodeURIComponent(options.url)}`);
  await expect(page.getByLabel("Website address")).toHaveValue(options.url);
  await page.getByLabel("Email").fill(options.email);
  await page.getByLabel(/I understand this is an automated audit/).check();
  await page.getByRole("button", { name: "Continue to payment" }).click();

  await expect(page).toHaveURL(/\/mock\/checkout\/[^/?]+/);
  await expect(page.getByText("Test mode: simulated checkout.")).toBeVisible();
  await expect(page.locator("dd", { hasText: options.url })).toBeVisible();
  await page.getByRole("button", { name: /^Pay \$[\d,.]+ \(test mode\)$/ }).click();

  await expect(page).toHaveURL(/\/success\?order=/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your audit is running");
  const href = await page.getByTestId("report-link").getAttribute("href");
  if (!href) throw new Error("success page has no report link");
  expect(tokenFromReportUrl(href)).toMatch(TOKEN_RE);
  return href;
}

/** Reads "(N left)" from the founding-offer note on the landing page. */
export async function foundingSeatsLeft(page: Page): Promise<number> {
  await page.goto("/");
  const note = (await page.locator(".founding-note").first().textContent()) ?? "";
  const match = /\((\d+) left\)/.exec(note);
  if (!match) throw new Error(`founding note not found on the landing page: "${note}"`);
  return Number(match[1]);
}

// ---------------------------------------------------------------------------
// A real PNG for the agency logo upload (no fixtures needed on disk)
// ---------------------------------------------------------------------------

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/** A solid-colour 8-bit RGB PNG (default 48x48 blue), valid for multer's filter and the PDF renderer. */
export function pngLogo(width = 48, height = 48, rgb: [number, number, number] = [29, 78, 216]): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: RGB
  header[10] = 0; // compression
  header[11] = 0; // filter
  header[12] = 0; // interlace
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x += 1) {
    row[1 + x * 3] = rgb[0];
    row[2 + x * 3] = rgb[1];
    row[3 + x * 3] = rgb[2];
  }
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
