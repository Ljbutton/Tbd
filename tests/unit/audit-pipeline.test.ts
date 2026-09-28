import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PageScan, RawViolation, Viewport } from "../../src/types.js";
import { useFreshDataDir } from "./helpers/data-dir.js";

useFreshDataDir("audit-pipeline");
delete process.env.ANTHROPIC_API_KEY;
delete process.env.RESEND_API_KEY;

// runAudit() end to end with the browser, network and PDF printer stubbed out:
// the crawl returns `stub.urls`, each page scan answers from `stub.scan`, and
// everything after (ranking, narrative, report HTML, exports, emails, status)
// is the real code.
const stub = vi.hoisted(() => ({
  urls: [] as string[],
  scan: (url: string, viewport: Viewport): Omit<PageScan, "url" | "viewport"> => {
    void url;
    void viewport;
    return { statusCode: 200, title: "Shop", violations: [], incomplete: [] };
  },
  calls: [] as { url: string; viewport: Viewport; timeoutMs: number | undefined }[],
  /** Called after each page scan; lets a test move the clock forward. */
  afterScan: (url: string, viewport: Viewport): void => {
    void url;
    void viewport;
  },
}));

function fakePage() {
  let current = "about:blank";
  return {
    url: () => current,
    goto: async (url: string) => {
      current = url;
      return null;
    },
    waitForTimeout: async () => undefined,
    content: async () => "<html><body></body></html>",
    close: async () => undefined,
  };
}

vi.mock("../../src/scan/ssrf.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/scan/ssrf.js")>();
  return { ...actual, assertPublicUrl: async (input: string) => new URL(input) };
});

vi.mock("../../src/scan/robots.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/scan/robots.js")>();
  return { ...actual, loadRobots: async () => actual.allowAll() };
});

vi.mock("../../src/scan/crawler.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/scan/crawler.js")>();
  return { ...actual, crawl: async () => [...stub.urls] };
});

vi.mock("../../src/scan/browser.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/scan/browser.js")>();
  return {
    ...actual,
    newScanContext: async () => ({ newPage: async () => fakePage(), close: async () => undefined }),
    closeContext: async () => undefined,
    closeBrowser: async () => undefined,
  };
});

vi.mock("../../src/scan/axe.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/scan/axe.js")>();
  return {
    ...actual,
    scanPage: async (page: { goto: (url: string) => Promise<unknown> }, url: string, viewport: Viewport, timeoutMs?: number): Promise<PageScan> => {
      stub.calls.push({ url, viewport, timeoutMs });
      await page.goto(url);
      const result: PageScan = { url, viewport, ...stub.scan(url, viewport) };
      stub.afterScan(url, viewport);
      return result;
    },
  };
});

vi.mock("../../src/scan/screenshots.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/scan/screenshots.js")>();
  return { ...actual, captureElement: async () => false };
});

vi.mock("../../src/report/pdf.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/report/pdf.js")>();
  return {
    ...actual,
    htmlToPdf: async (_html: string, outPath: string) => {
      fs.writeFileSync(outPath, "%PDF-1.4 stub");
    },
  };
});

const { createAudit, getAudit, auditSummary, auditNarrative, findingsForAudit } = await import("../../src/audits.js");
const { renderReportHtml } = await import("../../src/report/render.js");
const { listOutbox } = await import("../../src/email/send.js");
const { describeAuditFailure } = await import("../../src/email/templates.js");
const { PAGE_SCAN_TIMEOUT_MS } = await import("../../src/scan/axe.js");
const audit = await import("../../src/jobs/audit.js");

const SITE = "http://127.0.0.1:4106";

const imageAlt: RawViolation = {
  id: "image-alt",
  impact: "critical",
  tags: ["wcag2a", "wcag111"],
  help: "Images must have alternate text",
  helpUrl: "https://dequeuniversity.com/rules/axe/4.13/image-alt",
  description: "Ensure <img> elements have alternate text",
  nodes: [{ target: ["img"], html: '<img src="/hero.jpg">' }],
  nodeCount: 1,
};

function makeAudit() {
  return createAudit({ email: "buyer@example.com", url: `${SITE}/`, origin: SITE, page_limit: 15, white_label: 0, tier: "single" });
}

function mailsFor(token: string) {
  return listOutbox(100).filter((mail) => mail.html.includes(`/r/${token}`));
}

beforeEach(() => {
  stub.urls = [`${SITE}/`, `${SITE}/products`, `${SITE}/contact`];
  stub.calls.length = 0;
  stub.scan = () => ({ statusCode: 200, title: "Northwind Candles", violations: [imageAlt], incomplete: [] });
  stub.afterScan = () => undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("pageScanTimeout", () => {
  it("uses the normal 45s cap without a deadline or with plenty of time left", () => {
    expect(audit.pageScanTimeout(null)).toBe(PAGE_SCAN_TIMEOUT_MS);
    expect(audit.pageScanTimeout(1_000_000, 0)).toBe(PAGE_SCAN_TIMEOUT_MS);
  });

  it("shrinks to the time left before the scan deadline, but not below the floor", () => {
    expect(audit.pageScanTimeout(20_000, 0)).toBe(20_000);
    expect(audit.pageScanTimeout(2_000, 0)).toBe(audit.MIN_PAGE_SCAN_MS);
    expect(audit.pageScanTimeout(0, 60_000)).toBe(audit.MIN_PAGE_SCAN_MS);
  });
});

describe("buildSummary", () => {
  const scan = (url: string, viewport: Viewport, error?: string): PageScan => ({
    url,
    viewport,
    statusCode: error ? null : 200,
    title: "",
    violations: [],
    incomplete: [],
    ...(error ? { error } : {}),
  });

  it("splits found pages into scanned, failed and skipped (never scanned)", () => {
    const urls = ["a", "b", "c", "d"];
    const scans = [scan("a", "desktop"), scan("a", "mobile"), scan("b", "desktop", "HTTP 503"), scan("b", "mobile", "HTTP 503"), scan("c", "desktop", "timeout"), scan("c", "mobile")];
    const summary = audit.buildSummary(urls, scans, [], "s", "f");
    expect(summary).toMatchObject({ pagesRequested: 4, pagesScanned: 2, pagesFailed: 1, pagesSkipped: 1 });
  });
});

describe("runAudit", () => {
  it("fails the audit instead of reporting 'no issues' when every page scan failed", async () => {
    stub.scan = () => ({ statusCode: null, title: "", violations: [], incomplete: [], error: "page.goto: net::ERR_EMPTY_RESPONSE at http://127.0.0.1:4106/" });
    const row = makeAudit();
    await audit.runAudit(row.id);

    const after = getAudit(row.id);
    expect(after?.status).toBe("failed");
    expect(after?.error).toBe("no_pages_scanned: page.goto: net::ERR_EMPTY_RESPONSE at http://127.0.0.1:4106/");
    expect(after?.pdf_path).toBeNull();
    expect(after?.summary_json).toBeNull();
    expect(after?.log).not.toContain("finished: report ready");
    expect(mailsFor(row.token).some((mail) => mail.subject === "Your accessibility audit is ready")).toBe(false);
    // What the buyer is told on the report page and in the failure email.
    expect(describeAuditFailure(after ?? row)).toBe(
      "We found pages on 127.0.0.1 but none of them could be loaded for scanning (net::ERR_EMPTY_RESPONSE at http://127.0.0.1:4106/). The site may be blocking automated visits or was briefly unavailable.",
    );
  });

  it("still delivers the report when only some pages failed, and says so up front", async () => {
    stub.scan = (url) =>
      url.endsWith("/contact")
        ? { statusCode: 503, title: "", violations: [], incomplete: [], error: "HTTP 503" }
        : { statusCode: 200, title: "Northwind Candles", violations: [imageAlt], incomplete: [] };
    const row = makeAudit();
    await audit.runAudit(row.id);

    const after = getAudit(row.id);
    expect(after?.status).toBe("ready");
    expect(stub.calls).toHaveLength(6);
    expect(stub.calls.every((call) => call.timeoutMs === PAGE_SCAN_TIMEOUT_MS)).toBe(true);
    expect(auditSummary(after ?? row)).toMatchObject({ pagesRequested: 3, pagesScanned: 2, pagesFailed: 1, pagesSkipped: 0 });
    expect(auditNarrative(after ?? row)?.executiveSummary).toMatch(
      /^We scanned 2 pages of Northwind Candles \(http:\/\/127\.0\.0\.1:4106\) at desktop and mobile sizes \(1 of the 3 pages we found could not be loaded\) and found 1 distinct accessibility issue/,
    );
  });

  it("stops scanning at the time budget and delivers the pages it scanned instead of timing out", async () => {
    // The scan deadline is 10 minutes out; scanning the second page "takes" 11 minutes.
    const realNow = Date.now.bind(Date);
    let offset = 0;
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + offset);
    stub.afterScan = (url, viewport) => {
      if (url.endsWith("/products") && viewport === "mobile") offset = 11 * 60 * 1000;
    };
    const row = makeAudit();
    await audit.runAudit(row.id, { deadline: realNow() + audit.POST_SCAN_RESERVE_MS + 10 * 60 * 1000 });

    const after = getAudit(row.id);
    expect(after?.status).toBe("ready");
    // Pages are never split: both viewports of the first two pages, nothing of the third.
    expect(stub.calls.map((call) => `${call.url} ${call.viewport}`)).toEqual([
      `${SITE}/ desktop`,
      `${SITE}/ mobile`,
      `${SITE}/products desktop`,
      `${SITE}/products mobile`,
    ]);
    expect(after?.log).toContain("stopped scanning after 2 pages (time budget); 1 page not scanned");
    expect(auditSummary(after ?? row)).toMatchObject({ pagesRequested: 3, pagesScanned: 2, pagesFailed: 0, pagesSkipped: 1 });
    expect(auditNarrative(after ?? row)?.executiveSummary).toContain(
      "(1 of the 3 pages we found was not scanned because the audit reached its time limit)",
    );
    expect(after?.pdf_path).toBeTruthy();
    expect(mailsFor(row.token).some((mail) => mail.subject === "Your accessibility audit is ready")).toBe(true);
    const summary = auditSummary(after ?? row);
    const narrative = auditNarrative(after ?? row);
    if (!after || !summary || !narrative) throw new Error("report data missing");
    const html = renderReportHtml({ audit: after, findings: findingsForAudit(after.id), narrative, summary, mode: "web" });
    expect(html).toContain("2 of 3 requested pages scanned, 1 not scanned because the audit reached its time limit.");
  });

  it("always scans the first page, with a shortened per-page cap, when the crawl used up the budget", async () => {
    const row = makeAudit();
    await audit.runAudit(row.id, { deadline: Date.now() + audit.POST_SCAN_RESERVE_MS - 1000 });

    const after = getAudit(row.id);
    expect(after?.status).toBe("ready");
    expect(stub.calls.map((call) => `${call.url} ${call.viewport}`)).toEqual([`${SITE}/ desktop`, `${SITE}/ mobile`]);
    expect(stub.calls.every((call) => call.timeoutMs === audit.MIN_PAGE_SCAN_MS)).toBe(true);
    expect(auditSummary(after ?? row)).toMatchObject({ pagesScanned: 1, pagesFailed: 0, pagesSkipped: 2 });
  });
});
