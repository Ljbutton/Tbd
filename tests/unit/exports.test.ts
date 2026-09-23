import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AuditRow, AuditSummary, Delta, Finding, Narrative, PageRow, PageScan } from "../../src/types.js";
import { useFreshDataDir } from "./helpers/data-dir.js";

const dataDir = useFreshDataDir("exports");
const { toCsv, toIssueTableHtml, toJson, toRemediationRecord, csvField, CSV_HEADER, REMEDIATION_RECORD_STATEMENT } =
  await import("../../src/report/exports.js");
const { renderReportHtml, groupPages, DISCLAIMER, formatDate, formatDateTime, resolveScreenshotFile } = await import(
  "../../src/report/render.js"
);
const audits = await import("../../src/audits.js");

// 1x1 transparent PNG.
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

const AUDIT_ID = "5f1c2b3a-9d8e-4f70-a1b2-c3d4e5f60718";

function audit(overrides: Partial<AuditRow> = {}): AuditRow {
  return {
    id: AUDIT_ID,
    token: "tok_abcdefghijklmnopqrs",
    order_id: null,
    credit_code_id: null,
    email: "owner@northwind-candles.example",
    url: "https://northwind-candles.example/",
    origin: "https://northwind-candles.example",
    page_limit: 15,
    white_label: 0,
    agency_name: null,
    agency_logo_path: null,
    tier: "single",
    status: "ready",
    progress_pages: 6,
    progress_issues: 41,
    progress_note: null,
    error: null,
    log: "",
    narrative_json: null,
    summary_json: null,
    pdf_path: null,
    json_path: null,
    csv_path: null,
    rescan_of: null,
    rescan_used: 0,
    reminder_sent: 0,
    created_at: "2026-09-20T10:00:00.000Z",
    started_at: "2026-09-20T10:00:05.000Z",
    finished_at: "2026-09-20T10:07:30.000Z",
    released_at: null,
    ...overrides,
  };
}

function finding(overrides: Partial<Finding> & { rank: number; ruleId: string }): Finding {
  return {
    impact: "serious",
    category: "images",
    wcagTags: ["wcag2a", "wcag111"],
    pagesAffected: 2,
    nodesTotal: 5,
    litigationWeight: 3,
    score: 30.5,
    confidence: "automated",
    examplePageUrl: "https://northwind-candles.example/products.html",
    exampleSelector: ".product > img",
    exampleHtml: '<img src="/img/candle.svg">',
    screenshotPath: null,
    help: "Images must have alternate text",
    helpUrl: "https://dequeuniversity.com/rules/axe/4.10/image-alt",
    affectedUrls: ["https://northwind-candles.example/", "https://northwind-candles.example/products.html"],
    ...overrides,
  };
}

const manyUrls = Array.from({ length: 12 }, (_, i) => `https://northwind-candles.example/page-${i + 1}.html`);

const findings: Finding[] = [
  finding({
    rank: 1,
    ruleId: "image-alt",
    impact: "critical",
    pagesAffected: 12,
    nodesTotal: 23,
    affectedUrls: manyUrls,
    exampleHtml: '<img src="/img/hero.svg" onerror="alert(1)"><script>alert("x")</script>',
  }),
  finding({
    rank: 2,
    ruleId: "color-contrast",
    impact: "serious",
    category: "contrast",
    exampleSelector: 'p.hero-text, a[href="#"]',
    exampleHtml: '<p class="hero-text">Hand-poured, "small batch"</p>',
    helpUrl: "https://dequeuniversity.com/rules/axe/4.10/color-contrast",
  }),
  finding({
    rank: 3,
    ruleId: "link-in-text-block",
    impact: "moderate",
    category: "links_buttons",
    confidence: "needs_manual",
    pagesAffected: 1,
    nodesTotal: 1,
    affectedUrls: [],
    exampleHtml: null,
    exampleSelector: null,
    helpUrl: "javascript:alert(1)",
  }),
  finding({
    rank: 4,
    ruleId: "custom-unknown-rule",
    impact: "minor",
    category: "other",
    help: "Some custom check",
    helpUrl: "https://example.com/rules/custom",
    affectedUrls: ["https://northwind-candles.example/about.html"],
    pagesAffected: 1,
    nodesTotal: 2,
  }),
];

const narrative: Narrative = {
  executiveSummary: "We scanned 6 pages of Northwind Candles and found 4 distinct accessibility issues.\nStart with the images.",
  riskOverview: "Images: 1 issue across 12 pages.\nColor contrast: 1 issue across 2 pages.",
  topPriorities: ["Images without alt text (12 pages)", "Low contrast text (2 pages)", "Links only distinguished by color (1 page)"],
  findings: [
    {
      ruleId: "image-alt",
      title: 'Images are missing "alt" text, <b>everywhere</b>',
      plainEnglish: "Your product photos have no text alternative.",
      whyItMatters: "Screen reader users hear only 'image'.",
      fixSteps: ["Add an alt attribute to every meaningful image.", "Use alt=\"\" for decorative images."],
      beforeHtml: '<img src="/img/hero.svg" onerror="alert(1)"><script>alert("x")</script>',
      afterHtml: '<img src="/img/hero.svg" alt="Harbor candle in a glass jar">',
      effort: "hours",
    },
    {
      ruleId: "color-contrast",
      title: "Text is too light to read",
      plainEnglish: "The hero text is light grey on white.",
      whyItMatters: "People with low vision cannot read it.",
      fixSteps: ["Use color: #1f2937; background: #ffffff; /* 4.5:1 */"],
      beforeHtml: '<p class="hero-text">Hand-poured, "small batch"</p>',
      afterHtml: null,
      effort: "minutes",
    },
    {
      ruleId: "link-in-text-block",
      title: "Links inside paragraphs rely on color alone",
      plainEnglish: "We could not confirm this automatically.",
      whyItMatters: "Color-blind visitors cannot spot the link.",
      fixSteps: ["Underline links inside text."],
      beforeHtml: null,
      afterHtml: null,
      effort: "minutes",
    },
  ],
  manualChecks: [
    { title: "Use the site with only a keyboard", how: "Tab through the main flows." },
    { title: "Zoom to 200%", how: "Make sure nothing is cut off." },
  ],
  nextSteps: ["Fix the top 3 priorities first.", "Run your free re-scan within 30 days."],
  generatedBy: "dictionary",
};

const summary: AuditSummary = {
  pagesRequested: 15,
  pagesScanned: 6,
  pagesFailed: 1,
  totalViolationNodes: 31,
  findingsCount: 4,
  byImpact: { critical: 1, serious: 1, moderate: 1, minor: 1 },
  byConfidence: { automated: 3, needs_manual: 1 },
  scanStartedAt: "2026-09-20T10:00:05.000Z",
  scanFinishedAt: "2026-09-20T10:06:40.000Z",
  viewports: ["desktop", "mobile"],
};

const delta: Delta = {
  originalAuditId: "0a1b2c3d-0000-4000-8000-000000000001",
  originalDate: "2026-08-25T09:00:00.000Z",
  rescanDate: "2026-09-20T10:00:00.000Z",
  fixed: [{ ruleId: "html-has-lang", title: "Page language is not set", before: 6, after: 0 }],
  newIssues: [{ ruleId: "custom-unknown-rule", title: "Some custom check", before: 0, after: 2 }],
  unchanged: [{ ruleId: "image-alt", title: "Images are missing alt text", before: 30, after: 23 }],
  nodesBefore: 60,
  nodesAfter: 31,
  percentFixed: 48,
};

function pageRow(overrides: Partial<PageRow> & { url: string; viewport: "desktop" | "mobile" }): PageRow {
  return {
    id: `${overrides.url}-${overrides.viewport}`,
    audit_id: AUDIT_ID,
    status_code: 200,
    title: "Northwind Candles",
    violations_json: "[]",
    incomplete_json: "[]",
    violation_count: 3,
    scanned_at: "2026-09-20T10:03:00.000Z",
    error: null,
    ...overrides,
  };
}

const pages: PageRow[] = [
  pageRow({ url: "https://northwind-candles.example/", viewport: "desktop", violation_count: 7 }),
  pageRow({ url: "https://northwind-candles.example/", viewport: "mobile", violation_count: 9 }),
  pageRow({ url: "https://northwind-candles.example/products.html", viewport: "desktop", violation_count: 12, title: "Products" }),
  pageRow({
    url: "https://northwind-candles.example/broken.html",
    viewport: "desktop",
    status_code: null,
    title: null,
    violation_count: 0,
    error: "net::ERR_CONNECTION_RESET",
  }),
  pageRow({
    url: "https://northwind-candles.example/broken.html",
    viewport: "mobile",
    status_code: null,
    title: null,
    violation_count: 0,
    error: "timeout",
  }),
];

/** Everything left after the two sanctioned disclaimer sentences are removed must be free of the restricted word. */
function withoutDisclaimers(text: string): string {
  return text.split(DISCLAIMER).join("").split(REMEDIATION_RECORD_STATEMENT).join("");
}

describe("toJson", () => {
  it("has the spec shape, sorts by rank and attaches a narrative to every finding", () => {
    const shuffled = [findings[2]!, findings[0]!, findings[3]!, findings[1]!];
    const json = toJson(audit(), summary, shuffled, narrative);
    expect(json.version).toBe(1);
    expect(json.reportId).toBe(AUDIT_ID);
    expect(json.url).toBe("https://northwind-candles.example/");
    expect(json.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(json.summary).toEqual(summary);
    expect(json.findings.map((f) => f.rank)).toEqual([1, 2, 3, 4]);
    expect(json.findings[0]?.narrative.title).toBe('Images are missing "alt" text, <b>everywhere</b>');
    expect(json.findings[0]?.affectedUrls).toEqual(manyUrls);
    // A finding the narrative does not cover gets a dictionary entry built from the axe help text.
    expect(json.findings[3]?.narrative.ruleId).toBe("custom-unknown-rule");
    expect(json.findings[3]?.narrative.title).toBe("Some custom check");
    expect(json.findings[3]?.narrative.fixSteps[0]).toContain("https://example.com/rules/custom");
    expect(json.manualChecks).toEqual(narrative.manualChecks);
    expect(json.delta).toBeNull();
    expect(Object.keys(json).sort()).toEqual(
      ["delta", "findings", "generatedAt", "manualChecks", "reportId", "summary", "url", "version"].sort(),
    );
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });

  it("carries the delta when given", () => {
    expect(toJson(audit(), summary, findings, narrative, delta).delta).toEqual(delta);
  });
});

describe("toCsv", () => {
  it("writes the exact header, one CRLF-terminated row per finding, in rank order", () => {
    const csv = toCsv([findings[1]!, findings[0]!, findings[3]!, findings[2]!], narrative);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe(CSV_HEADER.join(","));
    expect(lines[0]).toBe(
      "rank,rule_id,title,impact,confidence,category,wcag_tags,pages_affected,elements,effort,example_page,example_selector,help_url",
    );
    expect(csv.endsWith("\r\n")).toBe(true);
    expect(lines.filter((line) => line !== "")).toHaveLength(5);
    expect(lines[1]?.startsWith("1,image-alt,")).toBe(true);
    expect(lines[2]?.startsWith("2,color-contrast,")).toBe(true);
    expect(lines[4]?.startsWith("4,custom-unknown-rule,")).toBe(true);
  });

  it("quotes fields with commas, quotes and newlines per RFC 4180", () => {
    const csv = toCsv(findings, narrative);
    expect(csv).toContain('"Images are missing ""alt"" text, <b>everywhere</b>"');
    expect(csv).toContain('"p.hero-text, a[href=""#""]"');
    expect(csv).toContain(",wcag2a|wcag111,");
    expect(csv).toContain("3,link-in-text-block,Links inside paragraphs rely on color alone,moderate,needs_manual,links_buttons,");
    const row2 = csv.split("\r\n")[2] ?? "";
    expect(row2).toContain(",2,5,minutes,https://northwind-candles.example/products.html,");
  });

  it("csvField neutralises spreadsheet formulas and leaves plain values alone", () => {
    expect(csvField("plain")).toBe("plain");
    expect(csvField(12)).toBe("12");
    expect(csvField(null)).toBe("");
    expect(csvField("a,b")).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField("line1\nline2")).toBe('"line1\nline2"');
    expect(csvField("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(csvField("-5")).toBe("-5");
  });
});

describe("toIssueTableHtml", () => {
  it("is a standalone escaped table with one row per finding", () => {
    const html = toIssueTableHtml(findings, narrative);
    expect(html.startsWith("<table")).toBe(true);
    expect(html.trimEnd().endsWith("</table>")).toBe(true);
    expect(html.match(/<tbody>[\s\S]*<\/tbody>/)?.[0].match(/<tr>/g)).toHaveLength(4);
    expect(html).toContain("Images are missing &quot;alt&quot; text, &lt;b&gt;everywhere&lt;/b&gt;");
    expect(html).not.toContain("<b>everywhere</b>");
    expect(html).toContain("Needs manual check");
    expect(html).toContain("Critical");
    expect(html).toContain('<a href="https://dequeuniversity.com/rules/axe/4.10/image-alt">');
    expect(html).not.toContain("javascript:");
    expect(html).toContain("<code>custom-unknown-rule</code>");
  });

  it("renders a friendly single row when there are no findings", () => {
    const html = toIssueTableHtml([], narrative);
    expect(html).toContain("found no issues");
    expect(html.match(/<tbody>[\s\S]*<\/tbody>/)?.[0].match(/<tr>/g)).toHaveLength(1);
  });
});

describe("toRemediationRecord", () => {
  it("is a printable document with site, report id, dates, tools, counts and the statement", () => {
    const html = toRemediationRecord(audit(), summary, findings);
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain("<title>Accessibility Remediation Record - northwind-candles.example</title>");
    expect(html).toContain("<h1>Accessibility Remediation Record</h1>");
    expect(html).toContain(AUDIT_ID);
    expect(html).toContain("https://northwind-candles.example/");
    expect(html).toContain("September 20, 2026, 10:00 UTC");
    expect(html).toContain("September 20, 2026, 10:06 UTC");
    expect(html).toMatch(/axe-core \d+\.\d+\.\d+/);
    expect(html).toMatch(/Playwright \d+\.\d+\.\d+/);
    expect(html).toContain("6 of 15 requested (1 page could not be loaded)");
    expect(html).toContain(REMEDIATION_RECORD_STATEMENT);
    expect(html).toContain("<td>Critical</td><td class=\"num\">1</td>");
    expect(html).toContain("31 elements affected");
    expect(html).toContain("<code>image-alt</code>");
    expect(html).toContain("Some custom check");
    expect(html).not.toContain("Re-scan date");
  });

  it("adds the re-scan figures when a delta is given and escapes user content", () => {
    const html = toRemediationRecord(
      audit({ url: 'https://northwind-candles.example/?q="><script>alert(1)</script>' }),
      summary,
      findings,
      delta,
    );
    expect(html).toContain("Re-scan date");
    expect(html).toContain("August 25, 2026, 09:00 UTC");
    expect(html).toContain("1 issue type</td>");
    expect(html).toContain("60 before, 31 after");
    expect(html).toContain("48% of affected elements");
    expect(html).toContain("Page language is not set");
    expect(html).toContain(delta.originalAuditId);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("drops the AccessAudit name for white-label audits", () => {
    const html = toRemediationRecord(audit({ white_label: 1, agency_name: "Bright Pixel Studio" }), summary, findings, delta);
    expect(html).toContain("Bright Pixel Studio");
    expect(html).not.toContain("AccessAudit");
  });
});

describe("renderReportHtml (pdf mode)", () => {
  const shotsDir = path.join(dataDir, "audits", AUDIT_ID, "shots");
  fs.mkdirSync(shotsDir, { recursive: true });
  for (const name of ["f1.png", "f2.png", "f3.png"]) fs.writeFileSync(path.join(shotsDir, name), PNG_BYTES);
  const withShots = findings.map((f) => {
    if (f.rank === 1) return { ...f, screenshotPath: path.join(shotsDir, "f1.png") };
    if (f.rank === 2) return { ...f, screenshotPath: path.join("audits", AUDIT_ID, "shots", "f2.png") };
    if (f.rank === 3) return { ...f, screenshotPath: "f3.png" };
    return { ...f, screenshotPath: path.join(shotsDir, "missing.png") };
  });

  const html = renderReportHtml({
    audit: audit(),
    findings: withShots,
    narrative,
    summary,
    mode: "pdf",
    pages,
    baseUrl: "https://accessaudit.example/",
  });

  it("is a full self-contained document with the stylesheet and logo inlined", () => {
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("<title>Website Accessibility Audit - northwind-candles.example</title>");
    expect(html).toContain("@page");
    expect(html).toContain("size: Letter");
    expect(html).toContain("page-break-before: always");
    expect(html).toContain('src="data:image/svg+xml;base64,');
    expect(html).not.toContain('href="/report.css"');
    // Stylesheet comments are stripped (the only "/*" left is the CSS hint inside a fix step).
    expect(html).not.toContain("/* AccessAudit");
    expect(html).not.toContain("report stylesheet");
    expect(html).toContain('<div class="report report--pdf"');
    expect(html.trimEnd().endsWith("</html>")).toBe(true);
    expect(html).not.toContain('class="report-nav"');
  });

  it("has every section in order with the cover details", () => {
    const order = [
      "Website Accessibility Audit",
      "Prepared for",
      "owner@northwind-candles.example",
      "Scope",
      "6 pages, desktop and mobile, WCAG 2.2 A/AA automated checks",
      DISCLAIMER,
      "Executive summary",
      "Pages scanned",
      "Issues found",
      "Critical or serious",
      "Elements affected",
      "Top 3 priorities",
      "Issues at a glance",
      "Findings in detail",
      "Manual checks you still need",
      "Pages scanned</h2>",
      "Method and limits",
      "Scanned with AccessAudit",
    ];
    let cursor = -1;
    for (const marker of order) {
      const index = html.indexOf(marker, cursor + 1);
      expect(index, `expected "${marker}" after position ${cursor}`).toBeGreaterThan(cursor);
      cursor = index;
    }
    expect(html).toContain("September 20, 2026");
    expect(html).toContain("AccessAudit</span>");
    expect(html).toContain('<a href="https://accessaudit.example">https://accessaudit.example</a>');
    // Without a usable base URL the sentence stays and only the link is dropped.
    const noLink = renderReportHtml({ audit: audit(), findings, narrative, summary, mode: "pdf", pages, baseUrl: "" });
    expect(noLink).toContain("Scanned with AccessAudit</p>");
    expect(html).not.toContain("Before / after");
    // Page breaks before sections 2, 4 and 5 (no delta, so no section 7).
    expect(html.match(/class="report-section page-break"/g)).toHaveLength(3);
  });

  it("renders stat tiles, badges and the issue table from the summary and findings", () => {
    expect(html).toContain('<span class="report-stat__value">6</span>');
    expect(html).toContain('<span class="report-stat__value">4</span>');
    expect(html).toContain('<span class="report-stat__value">2</span>');
    expect(html).toContain('<span class="report-stat__value">31</span>');
    expect(html).toContain('badge badge--critical">Critical<');
    expect(html).toContain('badge badge--serious">Serious<');
    expect(html).toContain('badge badge--moderate">Moderate<');
    expect(html).toContain('badge badge--minor">Minor<');
    expect(html).toContain('badge badge--automated">Automated<');
    expect(html).toContain('badge badge--needs_manual">Needs manual check<');
    expect(html).toContain('href="#finding-1"');
    expect(html).toContain('id="finding-4"');
    expect(html).toContain("Effort: Hours");
    expect(html).toContain("Effort: Minutes");
    expect(html).toContain("Links and buttons");
  });

  it("escapes every user-controlled string and shows before/after code", () => {
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain('onerror="alert(1)"');
    expect(html).toContain("&lt;img src=&#34;/img/hero.svg&#34; onerror=&#34;alert(1)&#34;&gt;&lt;script&gt;");
    expect(html).toContain("&lt;img src=&#34;/img/hero.svg&#34; alt=&#34;Harbor candle in a glass jar&#34;&gt;");
    expect(html).toContain("Images are missing &#34;alt&#34; text, &lt;b&gt;everywhere&lt;/b&gt;");
    expect(html).toContain("Hand-poured, &#34;small batch&#34;");
    expect(html).toContain("<code>p.hero-text, a[href=&#34;#&#34;]</code>");
    expect(html).toContain('href="https://dequeuniversity.com/rules/axe/4.10/image-alt"');
    expect(html).not.toContain("javascript:");
    expect(html).toContain("Use color: #1f2937; background: #ffffff; /* 4.5:1 */");
    // Unknown rule: dictionary fallback built from axe's help text and link.
    expect(html).toContain("Read the rule details: https://example.com/rules/custom");
    expect(html).toContain(">Some custom check</h3>");
  });

  it("lists at most 10 affected URLs with a +N more line and embeds screenshots as data URLs", () => {
    expect(html).toContain("https://northwind-candles.example/page-10.html");
    expect(html).not.toContain("https://northwind-candles.example/page-11.html");
    expect(html).toContain("+2 more pages");
    expect(html.match(/src="data:image\/png;base64,/g)).toHaveLength(3);
    expect(html).toContain('alt="Screenshot of the affected element for');
    expect(resolveScreenshotFile({ id: AUDIT_ID }, "f3.png")).toBe(path.join(shotsDir, "f3.png"));
    expect(resolveScreenshotFile({ id: AUDIT_ID }, "missing.png")).toBeNull();
  });

  it("groups page rows per URL for the pages table", () => {
    const grouped = groupPages(pages);
    expect(grouped).toHaveLength(3);
    expect(grouped[0]).toEqual({
      url: "https://northwind-candles.example/",
      title: "Northwind Candles",
      desktopIssues: 7,
      mobileIssues: 9,
      statusCode: 200,
      loaded: true,
    });
    expect(grouped[1]?.mobileIssues).toBeNull();
    expect(grouped[2]?.loaded).toBe(false);
    expect(html).toContain("Could not load");
    expect(html).toContain("<td>Products</td>");
    expect(html).toContain("6 of 15 requested pages scanned, 1 could not be loaded");
  });

  it("names the tools, viewports, page cap and report id in the method section", () => {
    expect(html).toMatch(/axe-core \d+\.\d+\.\d+/);
    expect(html).toMatch(/Playwright \d+\.\d+\.\d+/);
    expect(html).toContain("Desktop, 1280 x 800; Mobile, 390 x 844 (iPhone 13 emulation)");
    expect(html).toContain("Up to 15 pages");
    expect(html).toContain(`<code>${AUDIT_ID}</code>`);
    expect(html).toContain("September 20, 2026, 10:00 UTC");
  });

  it("keeps the restricted word out of everything except the disclaimer sentences", () => {
    expect(withoutDisclaimers(html)).not.toMatch(/complian/i);
    expect(withoutDisclaimers(toRemediationRecord(audit(), summary, findings, delta))).not.toMatch(/complian/i);
    expect(withoutDisclaimers(toIssueTableHtml(findings, narrative))).not.toMatch(/complian/i);
    expect(withoutDisclaimers(toCsv(findings, narrative))).not.toMatch(/complian/i);
  });

  it("uses dictionary text when the narrative is missing a finding and a fallback priority list when empty", () => {
    const bare: Narrative = { ...narrative, findings: [], topPriorities: [], nextSteps: [] };
    const out = renderReportHtml({ audit: audit(), findings, narrative: bare, summary, mode: "pdf", pages });
    expect(out).toContain("Images are missing text descriptions");
    expect(out).toContain("Top 3 priorities");
    expect(out).toContain("(12 pages)");
    expect(out).not.toContain("What to do next");
  });

  it("handles an audit with no findings and no page rows", () => {
    const empty: AuditSummary = {
      ...summary,
      findingsCount: 0,
      totalViolationNodes: 0,
      byImpact: { critical: 0, serious: 0, moderate: 0, minor: 0 },
      byConfidence: { automated: 0, needs_manual: 0 },
    };
    const out = renderReportHtml({
      audit: audit(),
      findings: [],
      narrative: { ...narrative, findings: [], topPriorities: [] },
      summary: empty,
      mode: "pdf",
      pages: [],
    });
    expect(out).toContain("found no issues");
    expect(out).toContain("No page details were recorded");
    expect(out).toContain("report-stat--good");
  });
});

describe("renderReportHtml (web mode, delta, white label)", () => {
  it("returns an embeddable fragment with a sticky section nav and the before/after section", () => {
    const html = renderReportHtml({
      audit: audit({ rescan_of: delta.originalAuditId }),
      findings,
      narrative,
      summary,
      delta,
      mode: "web",
      pages,
    });
    expect(html.startsWith("<style>")).toBe(true);
    expect(html).not.toContain("<!DOCTYPE");
    expect(html).not.toContain("<html");
    expect(html).not.toContain("<body");
    expect(html).toContain('<div class="report report--web"');
    expect(html).toContain('class="report-nav"');
    expect(html).toContain("position: sticky");
    expect(html).toContain('href="#report-delta"');
    expect(html).toContain("Before / after");
    expect(html).toContain("August 25, 2026");
    expect(html).toContain('<span class="report-stat__value">48%</span>');
    expect(html).toContain("Page language is not set");
    expect(html).toContain("Still present (1)");
    expect(html).toContain("New (1)");
    expect(html).toContain('delta-change--down">-7<');
    expect(html).toContain('delta-change--up">+2<');
    expect(html).toContain('<span class="report-section__num">7</span> Before / after');
    expect(html).toContain('<span class="report-section__num">8</span> Method and limits');
    // No cover page break in web mode; the other three breaks remain.
    expect(html).toContain('<section class="report-section" id="report-summary"');
    expect(html.match(/class="report-section page-break"/g)).toHaveLength(3);
    expect(html.trimEnd().endsWith("</div>")).toBe(true);
  });

  it("uses the screenshotUrl callback, and /screenshots URLs with the token by default", () => {
    const shotsDir = path.join(dataDir, "audits", AUDIT_ID, "shots");
    fs.mkdirSync(shotsDir, { recursive: true });
    fs.writeFileSync(path.join(shotsDir, "f1.png"), PNG_BYTES);
    const withShot = findings.map((f) => (f.rank === 1 ? { ...f, screenshotPath: path.join(shotsDir, "f1.png") } : f));

    const custom = renderReportHtml({
      audit: audit(),
      findings: withShot,
      narrative,
      summary,
      mode: "web",
      pages,
      screenshotUrl: (f) => (f.rank === 1 ? "/custom/shot.png" : null),
    });
    expect(custom).toContain('src="/custom/shot.png"');
    expect(custom).not.toContain("data:image/png");

    const byDefault = renderReportHtml({ audit: audit(), findings: withShot, narrative, summary, mode: "web", pages });
    expect(byDefault).toContain(`src="/screenshots/${AUDIT_ID}/f1.png?t=tok_abcdefghijklmnopqrs"`);
    expect(byDefault).not.toContain("data:image/png");
  });

  it("brands white-label reports with the agency and never mentions AccessAudit or the buyer", () => {
    const logoPath = path.join(dataDir, "logos", "order-1.png");
    fs.mkdirSync(path.dirname(logoPath), { recursive: true });
    fs.writeFileSync(logoPath, PNG_BYTES);
    const wl = audit({ white_label: 1, agency_name: "Bright Pixel <Studio>", agency_logo_path: logoPath, tier: "pack5" });
    for (const mode of ["pdf", "web"] as const) {
      const html = renderReportHtml({ audit: wl, findings, narrative, summary, mode, pages });
      expect(html).toContain("Bright Pixel &lt;Studio&gt;");
      expect(html).toContain('alt="Bright Pixel &lt;Studio&gt; logo"');
      expect(html).toContain('class="report-brand__logo report-brand__logo--agency" src="data:image/png;base64,');
      expect(html).not.toContain("AccessAudit");
      expect(html).not.toContain("Prepared for");
      expect(html).not.toContain("owner@northwind-candles.example");
      expect(html).not.toContain("data:image/svg+xml");
      expect(html).toContain(DISCLAIMER);
    }
    const noLogo = renderReportHtml({ audit: { ...wl, agency_logo_path: null }, findings, narrative, summary, mode: "pdf", pages });
    expect(noLogo).toContain("report-brand__name--large");
    expect(noLogo).not.toContain('<img class="report-brand__logo');
  });

  it("loads page rows from the database when they are not passed in", () => {
    const stored = audits.createAudit({
      email: "buyer@example.com",
      url: "https://db-pages.example/",
      origin: "https://db-pages.example",
      page_limit: 6,
      white_label: 0,
      tier: "single",
    });
    const scan: PageScan = {
      url: "https://db-pages.example/contact.html",
      viewport: "desktop",
      statusCode: 200,
      title: "Contact us",
      violations: [],
      incomplete: [],
    };
    audits.insertPages(stored.id, [scan, { ...scan, viewport: "mobile", error: "timeout" }]);
    const html = renderReportHtml({ audit: stored, findings, narrative, summary, mode: "pdf" });
    expect(html).toContain("https://db-pages.example/contact.html");
    expect(html).toContain("<td>Contact us</td>");
    expect(html).toContain("<td>200</td>");
  });
});

describe("date helpers", () => {
  it("format UTC dates and tolerate garbage", () => {
    expect(formatDate("2026-09-20T23:59:00.000Z")).toBe("September 20, 2026");
    expect(formatDateTime("2026-09-20T23:59:00.000Z")).toBe("September 20, 2026, 23:59 UTC");
    expect(formatDate("not a date")).toBe("not a date");
    expect(formatDateTime(null)).toBe("");
  });
});
