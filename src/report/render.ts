// Report document renderer (spec section 10). Turns an audit's findings,
// narrative and summary into one self-contained HTML document.
//
//   mode "pdf": a full HTML document. The stylesheet, the logo and every
//               screenshot are inlined as data URLs so Chromium can print it
//               with no network access (see pdf.ts).
//   mode "web": a fragment (inline <style> + <div class="report">) that
//               report-page.ejs embeds with <%- reportHtml %>. Screenshots are
//               referenced through /screenshots/:auditId/:file?t=:token.
//
// Everything that reaches views/report.ejs is escaped there with <%= %>; the
// only raw outputs are our own stylesheet and narrative strings passed through
// textToHtml (escapeHtml then nl2br).

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ejs from "ejs";
import { pagesForAudit } from "../audits.js";
import { config, dataPaths } from "../config.js";
import { dictionaryFindingNarrative } from "../narrative/mock.js";
import type {
  AuditRow,
  AuditSummary,
  Confidence,
  Delta,
  DeltaEntry,
  Effort,
  Finding,
  FindingNarrative,
  Impact,
  Narrative,
  PageRow,
  Viewport,
} from "../types.js";
import { escapeHtml, textToHtml } from "../util/http.js";
import { CATEGORY_LABELS, type Category } from "./litigation.js";

// ---------------------------------------------------------------------------
// Paths (relative to this file so the module works from any cwd)
// ---------------------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
export const REPORT_CSS_PATH = path.join(ROOT, "public", "report.css");
export const LOGO_PATH = path.join(ROOT, "public", "logo.svg");
export const REPORT_TEMPLATE_PATH = path.join(ROOT, "views", "report.ejs");

// ---------------------------------------------------------------------------
// Copy and labels shared with exports.ts
// ---------------------------------------------------------------------------

/** The disclaimer sentence pair from spec section 1, reproduced verbatim on the cover and in the method section. */
export const DISCLAIMER =
  "Automated checks find roughly 30-40% of WCAG issues. This is an automated audit plus a manual checklist, not a legal opinion or a compliance certification.";

/** First half of the disclaimer, reused wherever the coverage limit is restated. */
export const AUTOMATED_COVERAGE = "Automated checks find roughly 30-40% of WCAG issues.";

export const IMPACT_LABELS: Record<Impact, string> = {
  critical: "Critical",
  serious: "Serious",
  moderate: "Moderate",
  minor: "Minor",
};

export const CONFIDENCE_LABELS: Record<Confidence, string> = {
  automated: "Automated",
  needs_manual: "Needs manual check",
};

export const EFFORT_LABELS: Record<Effort, string> = {
  minutes: "Minutes",
  hours: "Hours",
  days: "Days",
};

export const VIEWPORT_LABELS: Record<Viewport, string> = {
  desktop: "Desktop, 1280 x 800",
  mobile: "Mobile, 390 x 844 (iPhone 13 emulation)",
};

/** Maximum affected URLs listed per finding before "+N more". */
export const MAX_WHERE_URLS = 10;

/** Largest image (screenshot or uploaded logo) embedded as a data URL. */
export const MAX_EMBEDDED_IMAGE_BYTES = 2 * 1024 * 1024;

const IMPACT_ORDER: readonly Impact[] = ["critical", "serious", "moderate", "minor"];

export function impactLabel(impact: string): string {
  return (IMPACT_LABELS as Record<string, string | undefined>)[impact] ?? capitalize(impact);
}

export function confidenceLabel(confidence: string): string {
  return (CONFIDENCE_LABELS as Record<string, string | undefined>)[confidence] ?? capitalize(confidence);
}

export function effortLabel(effort: string): string {
  return (EFFORT_LABELS as Record<string, string | undefined>)[effort] ?? capitalize(effort);
}

export function categoryLabel(category: string): string {
  return Object.prototype.hasOwnProperty.call(CATEGORY_LABELS, category)
    ? CATEGORY_LABELS[category as Category]
    : CATEGORY_LABELS.other;
}

function capitalize(value: string): string {
  const text = value.replace(/_/g, " ").trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "";
}

// ---------------------------------------------------------------------------
// Small formatting helpers (also used by exports.ts)
// ---------------------------------------------------------------------------

function parseDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "September 23, 2026" (UTC). Falls back to the raw string when it is not a date. */
export function formatDate(iso: string | null | undefined): string {
  const date = parseDate(iso);
  if (!date) return (iso ?? "").trim();
  return date.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}

/** "September 23, 2026, 14:05 UTC". Falls back to the raw string when it is not a date. */
export function formatDateTime(iso: string | null | undefined): string {
  const date = parseDate(iso);
  if (!date) return (iso ?? "").trim();
  return `${formatDate(iso)}, ${date.toISOString().slice(11, 16)} UTC`;
}

/** "yyyy-mm-dd" (UTC) for file names; empty string when not a date. */
export function formatIsoDate(iso: string | null | undefined): string {
  const date = parseDate(iso);
  return date ? date.toISOString().slice(0, 10) : "";
}

export function formatNumber(value: number): string {
  return Number.isFinite(value) ? Math.round(value).toLocaleString("en-US") : "0";
}

export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** Returns the URL when it is http(s), otherwise null (never emits javascript: links). */
export function safeHttpUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? trimmed : null;
  } catch {
    return null;
  }
}

export function sortByRank(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => a.rank - b.rank);
}

/** The narrative entry for a finding, or a dictionary entry when the narrative lacks one. */
export function narrativeFor(finding: Finding, narrative: Narrative): FindingNarrative {
  const entry = narrative.findings.find((candidate) => candidate.ruleId === finding.ruleId);
  return entry ?? dictionaryFindingNarrative(finding);
}

// ---------------------------------------------------------------------------
// Tool versions
// ---------------------------------------------------------------------------

export interface ToolVersions {
  accessAudit: string;
  axeCore: string;
  playwright: string;
}

const require = createRequire(import.meta.url);

function packageVersion(name: string): string {
  try {
    const pkg = require(`${name}/package.json`) as { version?: unknown };
    return typeof pkg.version === "string" && pkg.version.trim() !== "" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

function ownVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" && pkg.version.trim() !== "" ? pkg.version : "1.0";
  } catch {
    return "1.0";
  }
}

let versionsCache: ToolVersions | null = null;

/** Versions of the tools named in the method section and the remediation record. */
export function toolVersions(): ToolVersions {
  if (versionsCache) return versionsCache;
  versionsCache = {
    accessAudit: ownVersion(),
    axeCore: packageVersion("axe-core"),
    playwright: packageVersion("playwright"),
  };
  return versionsCache;
}

// ---------------------------------------------------------------------------
// Static assets (stylesheet, logo, template)
// ---------------------------------------------------------------------------

const textCache = new Map<string, string>();

function readTextCached(file: string): string {
  if (config.nodeEnv === "production") {
    const cached = textCache.get(file);
    if (cached !== undefined) return cached;
  }
  const text = fs.readFileSync(file, "utf8");
  textCache.set(file, text);
  return text;
}

/** Contents of public/report.css with comments stripped (a white-label document must not carry our name anywhere). */
export function reportCss(): string {
  return readTextCached(REPORT_CSS_PATH)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** public/logo.svg as a data URL. */
export function logoDataUrl(): string {
  const svg = readTextCached(LOGO_PATH);
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

let compiledTemplate: ejs.TemplateFunction | null = null;

function template(): ejs.TemplateFunction {
  if (compiledTemplate && config.nodeEnv === "production") return compiledTemplate;
  const source = fs.readFileSync(REPORT_TEMPLATE_PATH, "utf8");
  compiledTemplate = ejs.compile(source, { filename: REPORT_TEMPLATE_PATH, rmWhitespace: false });
  return compiledTemplate;
}

// ---------------------------------------------------------------------------
// Images: screenshots and agency logos
// ---------------------------------------------------------------------------

function imageMime(file: string, bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6 && bytes.toString("ascii", 0, 3) === "GIF") return "image/gif";
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
    return "image/webp";
  }
  const head = bytes.subarray(0, 1024).toString("utf8").replace(/^﻿/, "").trimStart();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return "image/svg+xml";
  switch (path.extname(file).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".svg":
      return "image/svg+xml";
    default:
      return null;
  }
}

/** Reads an image file into a data URL; null when missing, empty, too large or not an image. */
export function fileToDataUrl(file: string, maxBytes = MAX_EMBEDDED_IMAGE_BYTES): string | null {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size === 0 || stat.size > maxBytes) return null;
    const bytes = fs.readFileSync(file);
    const mime = imageMime(file, bytes);
    return mime ? `data:${mime};base64,${bytes.toString("base64")}` : null;
  } catch {
    return null;
  }
}

function firstExistingFile(candidates: string[]): string | null {
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/**
 * Locates a finding's screenshot on disk. Accepts absolute paths, paths
 * relative to the data dir or to the audit dir, and bare file names inside
 * ${dataDir}/audits/${auditId}/shots/.
 */
export function resolveScreenshotFile(audit: Pick<AuditRow, "id">, screenshotPath: string | null): string | null {
  const raw = (screenshotPath ?? "").trim();
  if (!raw) return null;
  if (path.isAbsolute(raw)) return firstExistingFile([raw]);
  const auditDir = path.join(dataPaths().audits, audit.id);
  return firstExistingFile([
    path.resolve(config.dataDir, raw),
    path.resolve(auditDir, raw),
    path.join(auditDir, "shots", path.basename(raw)),
  ]);
}

/** Locates an uploaded agency logo (absolute, data-dir relative, or a bare name in the logos dir). */
export function resolveLogoFile(logoPath: string | null): string | null {
  const raw = (logoPath ?? "").trim();
  if (!raw) return null;
  if (path.isAbsolute(raw)) return firstExistingFile([raw]);
  return firstExistingFile([path.resolve(config.dataDir, raw), path.join(dataPaths().logos, path.basename(raw))]);
}

/**
 * Default screenshot resolver: a /screenshots/... URL in web mode (spec 6.5),
 * a data URL in pdf mode. Null when the file cannot be found.
 */
export function defaultScreenshotUrl(audit: Pick<AuditRow, "id" | "token">, finding: Finding, mode: ReportMode): string | null {
  const file = resolveScreenshotFile(audit, finding.screenshotPath);
  if (!file) return null;
  if (mode === "web") {
    return `/screenshots/${encodeURIComponent(audit.id)}/${encodeURIComponent(path.basename(file))}?t=${encodeURIComponent(audit.token)}`;
  }
  return fileToDataUrl(file);
}

// ---------------------------------------------------------------------------
// Pages table (section 6)
// ---------------------------------------------------------------------------

export interface PageSummaryRow {
  url: string;
  title: string;
  desktopIssues: number | null;
  mobileIssues: number | null;
  statusCode: number | null;
  /** False when no viewport of this URL could be loaded ("Could not load"). */
  loaded: boolean;
}

/** Collapses one pages row per url+viewport into one row per URL. */
export function groupPages(rows: PageRow[]): PageSummaryRow[] {
  const byUrl = new Map<string, PageSummaryRow>();
  for (const row of rows) {
    let entry = byUrl.get(row.url);
    if (!entry) {
      entry = { url: row.url, title: "", desktopIssues: null, mobileIssues: null, statusCode: null, loaded: false };
      byUrl.set(row.url, entry);
    }
    const ok = !row.error;
    if (ok) {
      entry.loaded = true;
      if (row.viewport === "mobile") entry.mobileIssues = row.violation_count;
      else entry.desktopIssues = row.violation_count;
    }
    if (entry.statusCode === null && row.status_code !== null && (ok || !entry.loaded)) {
      entry.statusCode = row.status_code;
    }
    if (!entry.title && row.title) entry.title = row.title.trim();
  }
  return [...byUrl.values()];
}

function safePagesForAudit(auditId: string): PageRow[] {
  try {
    return pagesForAudit(auditId);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// View model
// ---------------------------------------------------------------------------

export type ReportMode = "pdf" | "web";

export interface RenderReportOptions {
  audit: AuditRow;
  findings: Finding[];
  narrative: Narrative;
  summary: AuditSummary;
  delta?: Delta | null;
  mode: ReportMode;
  /**
   * Resolves a finding's screenshot to an <img src> value (URL or data URL),
   * or null for no screenshot. Defaults to defaultScreenshotUrl() for the mode.
   */
  screenshotUrl?: (finding: Finding) => string | null;
  /** Rows of the pages table (section 6). Loaded from the database when omitted. */
  pages?: PageRow[];
  /** Base URL for the "Scanned with AccessAudit" link. Defaults to config.baseUrl. */
  baseUrl?: string;
}

interface IssueRowView {
  rank: number;
  anchor: string;
  title: string;
  ruleId: string;
  impact: Impact;
  impactLabel: string;
  confidence: Confidence;
  confidenceLabel: string;
  pagesAffected: number;
  nodesTotal: number;
  effortLabel: string;
}

interface FindingView extends IssueRowView {
  text: FindingNarrative;
  categoryLabel: string;
  wcagTags: string[];
  helpUrl: string | null;
  where: string[];
  moreCount: number;
  exampleSelector: string | null;
  examplePageUrl: string | null;
  screenshot: string | null;
  screenshotAlt: string;
}

interface DeltaRowView {
  ruleId: string;
  title: string;
  before: number;
  after: number;
  direction: "down" | "up" | "same";
  changeLabel: string;
}

interface DeltaGroupView {
  label: string;
  empty: string;
  rows: DeltaRowView[];
}

function anchorFor(finding: Finding): string {
  return `finding-${Math.max(0, Math.floor(finding.rank))}`;
}

function issueRow(finding: Finding, text: FindingNarrative): IssueRowView {
  return {
    rank: finding.rank,
    anchor: anchorFor(finding),
    title: text.title.trim() || finding.help || finding.ruleId,
    ruleId: finding.ruleId,
    impact: IMPACT_ORDER.includes(finding.impact) ? finding.impact : "moderate",
    impactLabel: impactLabel(finding.impact),
    confidence: finding.confidence === "needs_manual" ? "needs_manual" : "automated",
    confidenceLabel: confidenceLabel(finding.confidence),
    pagesAffected: finding.pagesAffected,
    nodesTotal: finding.nodesTotal,
    effortLabel: effortLabel(text.effort),
  };
}

function findingView(finding: Finding, text: FindingNarrative, screenshotUrl: (finding: Finding) => string | null): FindingView {
  const urls = finding.affectedUrls.filter((url) => typeof url === "string" && url.trim() !== "");
  const where = urls.length > 0 ? urls.slice(0, MAX_WHERE_URLS) : finding.examplePageUrl ? [finding.examplePageUrl] : [];
  const moreCount = Math.max(0, Math.max(finding.pagesAffected, urls.length) - where.length);
  let screenshot: string | null = null;
  try {
    screenshot = screenshotUrl(finding);
  } catch {
    screenshot = null;
  }
  const row = issueRow(finding, text);
  return {
    ...row,
    text,
    categoryLabel: categoryLabel(finding.category),
    wcagTags: finding.wcagTags.filter((tag) => typeof tag === "string" && tag.trim() !== ""),
    helpUrl: safeHttpUrl(finding.helpUrl),
    where,
    moreCount,
    exampleSelector: finding.exampleSelector,
    examplePageUrl: finding.examplePageUrl,
    screenshot: screenshot && screenshot.trim() !== "" ? screenshot : null,
    screenshotAlt: `Screenshot of the affected element for "${row.title}"${finding.examplePageUrl ? ` on ${finding.examplePageUrl}` : ""}`,
  };
}

function deltaRow(entry: DeltaEntry): DeltaRowView {
  const change = entry.after - entry.before;
  const direction: DeltaRowView["direction"] = change < 0 ? "down" : change > 0 ? "up" : "same";
  const changeLabel = change === 0 ? "No change" : change < 0 ? `-${formatNumber(-change)}` : `+${formatNumber(change)}`;
  return { ruleId: entry.ruleId, title: entry.title || entry.ruleId, before: entry.before, after: entry.after, direction, changeLabel };
}

function deltaGroups(delta: Delta): DeltaGroupView[] {
  const byBefore = (a: DeltaEntry, b: DeltaEntry): number => b.before - a.before || a.ruleId.localeCompare(b.ruleId);
  const byAfter = (a: DeltaEntry, b: DeltaEntry): number => b.after - a.after || a.ruleId.localeCompare(b.ruleId);
  return [
    { label: "Fixed", empty: "No issue types were fully fixed between the two scans.", rows: [...delta.fixed].sort(byBefore).map(deltaRow) },
    { label: "Still present", empty: "No issue types carried over from the original scan.", rows: [...delta.unchanged].sort(byAfter).map(deltaRow) },
    { label: "New", empty: "No new issue types appeared in the re-scan.", rows: [...delta.newIssues].sort(byAfter).map(deltaRow) },
  ];
}

function count(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Renders the report document. In pdf mode the result is a complete HTML page
 * with everything inlined; in web mode it is a fragment for report-page.ejs.
 */
export function renderReportHtml(options: RenderReportOptions): string {
  const { audit, narrative, summary, mode } = options;
  const delta = options.delta ?? null;
  const findings = sortByRank(options.findings);
  const whiteLabel = Boolean(audit.white_label);
  const agencyName = (audit.agency_name ?? "").trim();
  const agencyLogoFile = whiteLabel ? resolveLogoFile(audit.agency_logo_path) : null;
  const agencyLogo = agencyLogoFile ? fileToDataUrl(agencyLogoFile) : null;
  const screenshotUrl = options.screenshotUrl ?? ((finding: Finding): string | null => defaultScreenshotUrl(audit, finding, mode));
  const pages = groupPages(options.pages ?? safePagesForAudit(audit.id));
  const versions = toolVersions();
  const now = new Date().toISOString();

  const withText = findings.map((finding) => ({ finding, text: narrativeFor(finding, narrative) }));
  const issues = withText.map(({ finding, text }) => issueRow(finding, text));
  const details = withText.map(({ finding, text }) => findingView(finding, text, screenshotUrl));

  const topPriorities =
    narrative.topPriorities.filter((line) => line.trim() !== "").length > 0
      ? narrative.topPriorities.filter((line) => line.trim() !== "")
      : issues.slice(0, 3).map((row) => `${row.title} (${formatNumber(row.pagesAffected)} ${row.pagesAffected === 1 ? "page" : "pages"})`);

  const pagesScanned = count(summary.pagesScanned);
  const stats = {
    pagesRequested: count(summary.pagesRequested),
    pagesScanned,
    pagesFailed: count(summary.pagesFailed),
    findingsCount: count(summary.findingsCount),
    criticalSerious: count(summary.byImpact?.critical) + count(summary.byImpact?.serious),
    elements: count(summary.totalViolationNodes),
  };

  const sections = {
    summary: 2,
    issues: 3,
    findings: 4,
    manual: 5,
    pages: 6,
    delta: delta ? 7 : null,
    method: delta ? 8 : 7,
  };

  const viewports: Viewport[] = summary.viewports && summary.viewports.length > 0 ? summary.viewports : ["desktop", "mobile"];
  const baseUrl = (options.baseUrl ?? config.baseUrl).replace(/\/$/, "");

  const locals = {
    mode,
    isPdf: mode === "pdf",
    isWeb: mode === "web",
    css: reportCss(),
    logoDataUrl: logoDataUrl(),
    disclaimer: DISCLAIMER,
    automatedCoverage: AUTOMATED_COVERAGE,
    brand: { whiteLabel, agencyName, agencyLogo },
    cover: {
      siteUrl: audit.url,
      hostname: hostnameOf(audit.url),
      date: formatDate(audit.finished_at ?? summary.scanFinishedAt ?? now),
      preparedFor: whiteLabel ? null : audit.email,
      scope: `${formatNumber(pagesScanned)} ${pagesScanned === 1 ? "page" : "pages"}, desktop and mobile, WCAG 2.2 A/AA automated checks`,
    },
    stats,
    narrative,
    topPriorities,
    nextSteps: narrative.nextSteps.filter((line) => line.trim() !== ""),
    issues,
    details,
    manualChecks: narrative.manualChecks.filter((check) => check.title.trim() !== ""),
    pages,
    delta,
    deltaView: delta
      ? { originalDate: formatDate(delta.originalDate), rescanDate: formatDate(delta.rescanDate), groups: deltaGroups(delta) }
      : null,
    sections,
    method: {
      axeVersion: versions.axeCore,
      playwrightVersion: versions.playwright,
      viewports: viewports.map((viewport) => VIEWPORT_LABELS[viewport] ?? viewport),
      pageCap: audit.page_limit,
      scanStarted: formatDateTime(summary.scanStartedAt) || "unknown",
      scanFinished: formatDateTime(summary.scanFinishedAt) || "unknown",
      generatedAt: formatDateTime(now),
      reportId: audit.id,
      brandLink: whiteLabel ? null : safeHttpUrl(baseUrl),
    },
    escapeHtml,
    textToHtml,
    formatNumber,
  };

  return template()(locals);
}
