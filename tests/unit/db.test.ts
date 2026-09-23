import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Finding, PageScan } from "../../src/types.js";
import { useFreshDataDir } from "./helpers/data-dir.js";

const dataDir = useFreshDataDir("db");
const { db, migrate, TABLES } = await import("../../src/db.js");
const audits = await import("../../src/audits.js");
const { track, funnelCounts } = await import("../../src/routes/funnel.js");
const { enqueueAudit, runnerStats } = await import("../../src/jobs/runner.js");
const { findingToRow, rowToFinding } = await import("../../src/report/finding-rows.js");

function sampleFinding(rank: number): Finding {
  return {
    rank,
    ruleId: rank === 1 ? "image-alt" : "color-contrast",
    impact: rank === 1 ? "critical" : "serious",
    category: rank === 1 ? "images" : "contrast",
    wcagTags: ["wcag2a", "wcag111"],
    pagesAffected: 3,
    nodesTotal: 7,
    litigationWeight: 3,
    score: 42.5,
    confidence: "automated",
    examplePageUrl: "http://127.0.0.1:4100/products.html",
    exampleSelector: ".product > img",
    exampleHtml: '<img src="/img/candle-harbor.svg">',
    screenshotPath: null,
    help: "Images must have alternate text",
    helpUrl: "https://dequeuniversity.com/rules/axe/4.10/image-alt",
    affectedUrls: ["http://127.0.0.1:4100/", "http://127.0.0.1:4100/products.html"],
  };
}

function samplePage(viewport: "desktop" | "mobile"): PageScan {
  return {
    url: "http://127.0.0.1:4100/",
    viewport,
    statusCode: 200,
    title: "Northwind Candles",
    violations: [
      {
        id: "image-alt",
        impact: "critical",
        tags: ["wcag2a"],
        help: "Images must have alternate text",
        helpUrl: "https://example.test/image-alt",
        description: "Ensures <img> elements have alternate text",
        nodes: [
          { target: ["img"], html: "<img src=\"/img/hero-candle.svg\">" },
          { target: [".product > img"], html: "<img src=\"/img/candle-harbor.svg\">" },
        ],
      },
    ],
    incomplete: [],
  };
}

describe("migrate", () => {
  it("uses the DATA_DIR set before import and creates every table and index", () => {
    migrate();
    expect(fs.existsSync(path.join(dataDir, "app.db"))).toBe(true);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
      (r) => r.name,
    );
    for (const table of TABLES) expect(tables).toContain(table);
    const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]).map(
      (r) => r.name,
    );
    for (const index of [
      "idx_audits_status",
      "idx_jobs_status",
      "idx_pages_audit",
      "idx_findings_audit",
      "idx_orders_session",
    ]) {
      expect(indexes).toContain(index);
    }
  });

  it("is idempotent and keeps the pragmas", () => {
    expect(() => migrate()).not.toThrow();
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
  });
});

describe("audits repository", () => {
  it("createAudit / getAuditByToken round-trip", () => {
    const created = audits.createAudit({
      email: "buyer@example.com",
      url: "https://example.com/",
      origin: "https://example.com",
      page_limit: 15,
      white_label: false,
      tier: "single",
    });
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.token).toHaveLength(22);
    expect(created.status).toBe("queued");
    expect(created.white_label).toBe(0);
    expect(created.log).toBe("");
    expect(created.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const byToken = audits.getAuditByToken(created.token);
    expect(byToken).toEqual(created);
    expect(audits.getAudit(created.id)).toEqual(created);
    expect(audits.getAuditByToken("nope")).toBeNull();
    expect(audits.getAuditByToken("")).toBeNull();
    expect(audits.listAudits(10).some((a) => a.id === created.id)).toBe(true);
  });

  it("stores agency, order and rescan links", () => {
    const original = audits.createAudit({
      email: "agency@example.com",
      url: "https://client.example/",
      origin: "https://client.example",
      page_limit: 30,
      white_label: true,
      agency_name: "Bright Pixel Studio",
      tier: "pack5",
    });
    const rescan = audits.createAudit({
      email: original.email,
      url: original.url,
      origin: original.origin,
      page_limit: original.page_limit,
      white_label: original.white_label,
      agency_name: original.agency_name,
      tier: original.tier,
      rescan_of: original.id,
    });
    expect(rescan.rescan_of).toBe(original.id);
    expect(rescan.white_label).toBe(1);
    expect(rescan.agency_name).toBe("Bright Pixel Studio");
  });

  it("updateAudit only touches allowed columns and setProgress/appendAuditLog write through", () => {
    const audit = audits.createAudit({
      email: "buyer@example.com",
      url: "https://example.com/",
      origin: "https://example.com",
      page_limit: 15,
      white_label: 0,
      tier: "reviewed",
    });
    const updated = audits.updateAudit(audit.id, {
      status: "scanning",
      progress_note: "Found 6 pages",
      // @ts-expect-error unknown columns must be ignored, not interpolated
      bogus: "DROP TABLE audits",
    });
    expect(updated?.status).toBe("scanning");
    expect(updated?.progress_note).toBe("Found 6 pages");

    audits.setProgress(audit.id, { status: "writing", progress_pages: 6, progress_issues: 41 });
    audits.appendAuditLog(audit.id, "narrative: using dictionary");
    audits.appendAuditLog(audit.id, "done");
    const after = audits.getAudit(audit.id);
    expect(after?.status).toBe("writing");
    expect(after?.progress_pages).toBe(6);
    expect(after?.progress_issues).toBe(41);
    expect(after?.log).toMatch(/^\[\d{2}:\d{2}:\d{2}\] narrative: using dictionary\n\[\d{2}:\d{2}:\d{2}\] done\n$/);
    expect(audits.updateAudit("missing-id", { status: "ready" })).toBeNull();
  });

  it("insertPages / insertFindings / findingsForAudit / clearAuditResults", () => {
    const audit = audits.createAudit({
      email: "buyer@example.com",
      url: "http://127.0.0.1:4100/",
      origin: "http://127.0.0.1:4100",
      page_limit: 6,
      white_label: 0,
      tier: "single",
    });
    audits.insertPages(audit.id, [samplePage("desktop"), samplePage("mobile")]);
    const pages = audits.pagesForAudit(audit.id);
    expect(pages).toHaveLength(2);
    expect(pages[0]?.viewport).toBe("desktop");
    expect(pages[0]?.violation_count).toBe(2);
    expect(JSON.parse(pages[0]?.violations_json ?? "[]")).toHaveLength(1);

    const findings = [sampleFinding(1), sampleFinding(2)];
    audits.insertFindings(audit.id, findings);
    const loaded = audits.findingsForAudit(audit.id);
    expect(loaded).toEqual(findings);

    audits.setProgress(audit.id, { progress_pages: 2, progress_issues: 9, progress_note: "x" });
    audits.clearAuditResults(audit.id);
    expect(audits.pagesForAudit(audit.id)).toHaveLength(0);
    expect(audits.findingsForAudit(audit.id)).toHaveLength(0);
    const reset = audits.getAudit(audit.id);
    expect(reset?.progress_pages).toBe(0);
    expect(reset?.progress_issues).toBe(0);
    expect(reset?.progress_note).toBeNull();
  });

  it("findingToRow / rowToFinding are inverse and tolerate bad JSON", () => {
    const finding = sampleFinding(3);
    const row = findingToRow("audit-x", finding);
    expect(row.audit_id).toBe("audit-x");
    expect(JSON.parse(row.wcag_tags)).toEqual(finding.wcagTags);
    expect(rowToFinding(row)).toEqual(finding);
    expect(rowToFinding({ ...row, wcag_tags: "{oops", affected_urls: "null" })).toMatchObject({
      wcagTags: [],
      affectedUrls: [],
    });
  });
});

describe("funnel events", () => {
  it("track inserts rows and funnelCounts groups them by type", () => {
    const before = funnelCounts(30);
    track("teaser_scan", { url: "https://example.com" });
    track("teaser_scan");
    track("paid", { order: "o1" });
    track("custom_event");
    const after = funnelCounts(30);
    expect(after.teaser_scan).toBe((before.teaser_scan ?? 0) + 2);
    expect(after.paid).toBe((before.paid ?? 0) + 1);
    expect(after.custom_event).toBe((before.custom_event ?? 0) + 1);
    for (const key of ["teaser_scan", "checkout_start", "paid", "report_ready", "rescan"]) {
      expect(typeof after[key]).toBe("number");
    }
    const stored = db.prepare("SELECT meta_json FROM events WHERE type = 'paid' ORDER BY created_at DESC LIMIT 1").get() as {
      meta_json: string;
    };
    expect(JSON.parse(stored.meta_json)).toEqual({ order: "o1" });
  });

  it("funnelCounts ignores events older than the window", () => {
    db.prepare("INSERT INTO events (id, type, meta_json, created_at) VALUES (?, ?, '{}', ?)").run(
      "old-event",
      "report_ready",
      "2000-01-01T00:00:00.000Z",
    );
    expect(funnelCounts(30).report_ready).toBe(0);
    expect(funnelCounts(365 * 100).report_ready).toBe(1);
  });
});

describe("job queue", () => {
  it("enqueueAudit adds a queued job that runnerStats counts", () => {
    const audit = audits.createAudit({
      email: "buyer@example.com",
      url: "https://example.com/",
      origin: "https://example.com",
      page_limit: 15,
      white_label: 0,
      tier: "single",
    });
    const before = runnerStats();
    enqueueAudit(audit.id);
    const after = runnerStats();
    expect(after.queued).toBe(before.queued + 1);
    expect(after.running).toBe(before.running);
    const job = db.prepare("SELECT * FROM jobs WHERE ref_id = ?").get(audit.id) as {
      type: string;
      status: string;
      attempts: number;
    };
    expect(job).toMatchObject({ type: "audit", status: "queued", attempts: 0 });

    db.prepare("UPDATE jobs SET status = 'running' WHERE ref_id = ?").run(audit.id);
    expect(runnerStats().running).toBe(before.running + 1);
  });
});
