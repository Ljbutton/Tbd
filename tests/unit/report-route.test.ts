import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Finding, PageScan } from "../../src/types.js";
import { useFreshDataDir } from "./helpers/data-dir.js";

process.env.BASE_URL = "http://report.test";
// A dot-directory on purpose: downloads must not 403 when DATA_DIR is something like `.e2e-data`.
useFreshDataDir(".report-route");

const { createApp } = await import("../../src/server.js");
const { createAudit, getAudit, insertFindings, insertPages, reportFilePaths, updateAudit, latestRescanOf } = await import("../../src/audits.js");
const { runnerStats } = await import("../../src/jobs/runner.js");
const { buildMockNarrative } = await import("../../src/narrative/mock.js");
const { buildSummary } = await import("../../src/jobs/audit.js");
const { describeFailure, downloadName, rescanBlocker, screenshotTokenAllowed } = await import("../../src/routes/report.js");

const SITE = "http://127.0.0.1:4100";

function finding(rank: number, ruleId: string, impact: Finding["impact"], screenshotPath: string | null): Finding {
  return {
    rank,
    ruleId,
    impact,
    category: ruleId === "image-alt" ? "images" : "forms",
    wcagTags: ["wcag2a", "wcag111"],
    pagesAffected: 2,
    nodesTotal: 4,
    litigationWeight: 3,
    score: 40 - rank,
    confidence: "automated",
    examplePageUrl: `${SITE}/`,
    exampleSelector: ruleId === "image-alt" ? "img" : "input",
    exampleHtml: ruleId === "image-alt" ? '<img src="/img/hero.svg">' : '<input type="text" name="q">',
    screenshotPath,
    help: ruleId === "image-alt" ? "Images must have alternate text" : "Form elements must have labels",
    helpUrl: `https://dequeuniversity.com/rules/axe/4.13/${ruleId}`,
    affectedUrls: [`${SITE}/`, `${SITE}/products.html`],
  };
}

function scan(url: string, viewport: PageScan["viewport"]): PageScan {
  return { url, viewport, statusCode: 200, title: "Northwind Candles", violations: [], incomplete: [] };
}

let baseUrl = "";
let server: ReturnType<ReturnType<typeof createApp>["listen"]>;
let readyToken = "";
let readyId = "";

function seedReadyAudit(): { id: string; token: string } {
  const audit = createAudit({
    email: "buyer@example.com",
    url: `${SITE}/`,
    origin: SITE,
    page_limit: 15,
    white_label: 0,
    tier: "single",
  });
  const files = reportFilePaths(audit.id);
  fs.mkdirSync(files.shots, { recursive: true });
  const shot = path.join(files.shots, "f1.png");
  fs.writeFileSync(shot, Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"));
  const findings = [finding(1, "image-alt", "critical", shot), finding(2, "label", "critical", null)];
  const urls = [`${SITE}/`, `${SITE}/products.html`];
  const scans = urls.flatMap((url) => [scan(url, "desktop"), scan(url, "mobile")]);
  insertPages(audit.id, scans);
  insertFindings(audit.id, findings);
  const started = "2026-09-01T10:00:00.000Z";
  const finished = "2026-09-01T10:05:00.000Z";
  const summary = buildSummary(urls, scans, findings, started, finished);
  const narrative = buildMockNarrative(findings, summary, { url: `${SITE}/`, origin: SITE, siteTitle: "Northwind Candles", platformGuess: "unknown" });
  fs.writeFileSync(files.pdf, "%PDF-1.4 test");
  fs.writeFileSync(files.json, "{}");
  fs.writeFileSync(files.csv, "rank\r\n");
  updateAudit(audit.id, {
    status: "ready",
    summary_json: JSON.stringify(summary),
    narrative_json: JSON.stringify(narrative),
    pdf_path: files.pdf,
    json_path: files.json,
    csv_path: files.csv,
    finished_at: finished,
  });
  return { id: audit.id, token: audit.token };
}

async function get(pathname: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${baseUrl}${pathname}`, { redirect: "manual", ...init });
}

beforeAll(async () => {
  const app = createApp();
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const seeded = seedReadyAudit();
  readyToken = seeded.token;
  readyId = seeded.id;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("GET /r/:token", () => {
  it("404s for an unknown token", async () => {
    const res = await get("/r/AAAAAAAAAAAAAAAAAAAAAA");
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("find that report");
  });

  it("renders the ready page with downloads, the re-scan card and the embedded report", async () => {
    const res = await get(`/r/${readyToken}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-robots-tag")).toContain("noindex");
    const html = await res.text();
    expect(html).toContain("Download PDF");
    expect(html).toContain(`data-copy-url="/r/${readyToken}/html"`);
    expect(html).toContain("1 free re-scan available until");
    expect(html).toContain('class="report report--web"');
    expect(html).toContain("Issues at a glance");
    expect(html).toContain(`/screenshots/${readyId}/f1.png?t=${readyToken}`);
    expect(html).not.toContain("Before / after");
  });

  it("renders the progress card with the polling hooks for a queued audit", async () => {
    const queued = createAudit({ email: "q@example.com", url: `${SITE}/`, origin: SITE, page_limit: 15, white_label: 0, tier: "single" });
    const res = await get(`/r/${queued.token}`);
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain(`data-poll-url="/api/audits/${queued.token}/status"`);
    expect(html).toContain("Waiting in line");
    expect(html).toContain('data-poll-field="progressPages"');
    expect(html).toContain('http-equiv="refresh"');
  });

  it("renders the held and failed states", async () => {
    const held = createAudit({ email: "h@example.com", url: `${SITE}/`, origin: SITE, page_limit: 15, white_label: 0, tier: "reviewed" });
    updateAudit(held.id, { status: "held" });
    const heldHtml = await (await get(`/r/${held.token}`)).text();
    expect(heldHtml).toContain("being checked by a human");
    expect(heldHtml).toContain("2 business days");

    const failed = createAudit({ email: "f@example.com", url: `${SITE}/`, origin: SITE, page_limit: 15, white_label: 0, tier: "single" });
    updateAudit(failed.id, { status: "failed", error: "start_url_unreachable: page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:4100/" });
    const failedHtml = await (await get(`/r/${failed.token}`)).text();
    expect(failedHtml).toContain("reply to your receipt email for a refund or re-run");
    expect(failedHtml).toContain("net::ERR_CONNECTION_REFUSED");
    expect(failedHtml).not.toContain("page.goto");
  });
});

describe("GET /api/audits/:token/status", () => {
  it("returns the polling shape", async () => {
    const res = await get(`/api/audits/${readyToken}/status`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "ready",
      label: "Ready",
      progressPages: 0,
      pageLimit: 15,
      progressIssues: 0,
      note: null,
      ready: true,
      error: null,
    });
  });

  it("404s as JSON for an unknown token", async () => {
    const res = await get("/api/audits/nope/status");
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("report_not_found");
  });
});

describe("downloads and fragments", () => {
  it("serves the PDF, JSON and CSV with the accessaudit-{host}-{date} names", async () => {
    const pdf = await get(`/r/${readyToken}/pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toContain("application/pdf");
    expect(pdf.headers.get("content-disposition")).toContain('filename="accessaudit-127.0.0.1-2026-09-01.pdf"');
    expect((await pdf.text()).startsWith("%PDF")).toBe(true);
    const json = await get(`/r/${readyToken}/json`);
    expect(json.headers.get("content-disposition")).toContain("accessaudit-127.0.0.1-2026-09-01.json");
    const csv = await get(`/r/${readyToken}/csv`);
    expect(csv.headers.get("content-disposition")).toContain("accessaudit-127.0.0.1-2026-09-01.csv");
  });

  it("serves the remediation record inline and the issue table fragment", async () => {
    const record = await get(`/r/${readyToken}/record`);
    expect(record.status).toBe(200);
    expect(record.headers.get("content-disposition")).toContain("inline");
    expect(await record.text()).toContain("Accessibility Remediation Record");
    const table = await get(`/r/${readyToken}/html`);
    expect(table.status).toBe(200);
    const html = await table.text();
    expect(html.startsWith("<table")).toBe(true);
    expect(html).toContain("image-alt");
  });

  it("404s downloads for an audit that is not ready", async () => {
    const queued = createAudit({ email: "q2@example.com", url: `${SITE}/`, origin: SITE, page_limit: 15, white_label: 0, tier: "single" });
    for (const suffix of ["pdf", "json", "csv", "record", "html"]) {
      expect((await get(`/r/${queued.token}/${suffix}`)).status).toBe(404);
    }
  });
});

describe("GET /screenshots/:auditId/:file", () => {
  it("requires the audit token (or the original's token for a re-scan) and blocks traversal", async () => {
    expect((await get(`/screenshots/${readyId}/f1.png?t=${readyToken}`)).status).toBe(200);
    expect((await get(`/screenshots/${readyId}/f1.png`)).status).toBe(404);
    expect((await get(`/screenshots/${readyId}/f1.png?t=AAAAAAAAAAAAAAAAAAAAAA`)).status).toBe(404);
    expect((await get(`/screenshots/${readyId}/missing.png?t=${readyToken}`)).status).toBe(404);
    expect((await get(`/screenshots/${readyId}/..%2Freport.pdf?t=${readyToken}`)).status).toBe(404);
    const audit = getAudit(readyId);
    expect(audit && screenshotTokenAllowed(audit, readyToken)).toBe(true);
    expect(audit && screenshotTokenAllowed(audit, "")).toBe(false);
  });
});

describe("POST /r/:token/rescan", () => {
  it("creates the re-scan audit once, marks the original used and queues a job", async () => {
    const before = runnerStats().queued;
    const res = await get(`/r/${readyToken}/rescan`, { method: "POST" });
    expect(res.status).toBe(303);
    const location = res.headers.get("location") ?? "";
    expect(location).toMatch(/^\/r\/[A-Za-z0-9_-]{22}$/);
    const original = getAudit(readyId);
    expect(original?.rescan_used).toBe(1);
    const rescan = latestRescanOf(readyId);
    expect(rescan).not.toBeNull();
    expect(rescan?.rescan_of).toBe(readyId);
    expect(rescan?.tier).toBe("single");
    expect(rescan?.status).toBe("queued");
    expect(`/r/${rescan?.token}`).toBe(location);
    expect(runnerStats().queued).toBe(before + 1);

    const again = await get(`/r/${readyToken}/rescan`, { method: "POST" });
    expect(again.status).toBe(400);
    expect(await again.text()).toContain("already been used");

    const page = await (await get(`/r/${readyToken}`)).text();
    expect(page).toContain("Re-scan used");
    expect(page).toContain(`href="/r/${rescan?.token}"`);

    const rescanPage = await (await get(`/r/${rescan?.token}`)).text();
    expect(rescanPage).toContain("Waiting in line");
    expect((await get(`/screenshots/${rescan?.id}/f1.png?t=${readyToken}`)).status).toBe(404); // no file yet, but the token itself is accepted
    expect(rescan && screenshotTokenAllowed(rescan, readyToken)).toBe(true);
  });

  it("refuses re-scans of re-scans, unready audits and audits older than 30 days", () => {
    const base = getAudit(readyId);
    expect(base).not.toBeNull();
    if (!base) return;
    expect(rescanBlocker({ ...base, rescan_used: 0, status: "queued" })).toContain("isn't ready");
    expect(rescanBlocker({ ...base, rescan_used: 0, rescan_of: "other" })).toContain("itself a re-scan");
    expect(rescanBlocker({ ...base, rescan_used: 0, created_at: "2020-01-01T00:00:00.000Z" })).toContain("window");
    expect(rescanBlocker({ ...base, rescan_used: 0, created_at: new Date().toISOString() })).toBeNull();
  });
});

describe("helpers", () => {
  it("names downloads after the host and the finish date", () => {
    const audit = getAudit(readyId);
    expect(audit && downloadName(audit, "pdf")).toBe("accessaudit-127.0.0.1-2026-09-01.pdf");
  });

  it("describes failures in plain words", () => {
    expect(describeFailure({ url: "https://x.test/", error: "timeout" })).toContain("ran out of time");
    expect(describeFailure({ url: "https://x.test/", error: "crashed twice" })).toContain("stopped unexpectedly twice");
    expect(describeFailure({ url: "https://x.test/", error: null })).toContain("stopped before");
    expect(describeFailure({ url: "https://x.test/", error: "start_url_unreachable: page.goto: boom" })).toBe(
      "We couldn't load https://x.test/ (boom). Check that the address is right and the site is online.",
    );
  });
});
