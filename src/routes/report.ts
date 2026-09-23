// Public report pages (spec 6.5). Everything hangs off the unguessable
// 128-bit report token; the only other entry point is the screenshot route,
// which requires the same token as a query parameter.
//
//   GET  /r/:token                    progress / held / failed / ready page
//   GET  /api/audits/:token/status    JSON polled by public/app.js every 3s
//   GET  /r/:token/pdf|json|csv       downloads named accessaudit-{host}-{yyyy-mm-dd}.{ext}
//   GET  /r/:token/record             remediation record, inline HTML
//   GET  /r/:token/html               issue table fragment for copy-as-HTML
//   POST /r/:token/rescan             the one free re-scan (30-day window)
//   GET  /screenshots/:auditId/:file  finding screenshots, guarded by ?t=token

import fs from "node:fs";
import path from "node:path";
import express from "express";
import { rateLimit } from "express-rate-limit";
import {
  auditNarrative,
  auditSummary,
  createAudit,
  deltaForAudit,
  findingsForAudit,
  getAudit,
  getAuditByToken,
  latestRescanOf,
  pagesForAudit,
  reportFilePaths,
  updateAudit,
} from "../audits.js";
import { PRODUCTS } from "../config.js";
import { db } from "../db.js";
import { RESCAN_WINDOW_DAYS, rescanDeadline } from "../email/templates.js";
import { enqueueAudit } from "../jobs/runner.js";
import { toIssueTableHtml, toRemediationRecord } from "../report/exports.js";
import {
  confidenceLabel,
  formatDate,
  formatIsoDate,
  hostnameOf,
  impactLabel,
  narrativeFor,
  renderReportHtml,
  sortByRank,
} from "../report/render.js";
import type { AuditRow, AuditStatus, Delta, Finding, Narrative } from "../types.js";
import { HttpError, asyncHandler, safeEqual } from "../util/http.js";
import { renderPage } from "../util/render.js";

export const router = express.Router();

/** Status labels shown on the progress card (spec 6.5). */
export const STATUS_LABELS: Record<AuditStatus, string> = {
  queued: "Waiting in line",
  crawling: "Finding pages",
  scanning: "Scanning pages",
  writing: "Writing your report",
  rendering: "Building the PDF",
  held: "Being checked by a human",
  ready: "Ready",
  failed: "Failed",
};

const IN_PROGRESS: ReadonlySet<AuditStatus> = new Set<AuditStatus>(["queued", "crawling", "scanning", "writing", "rendering"]);
const SCREENSHOT_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const ROBOTS_HEADER = "noindex, nofollow, noarchive";

export type ReportPageState = "progress" | "held" | "failed" | "ready";

export interface RescanCard {
  state: "available" | "used" | "closed" | "is_rescan";
  deadline: string;
  /** Link to the re-scan report (used) or the original (is_rescan). */
  relatedUrl: string | null;
  relatedDate: string | null;
}

export interface FindingPreviewRow {
  rank: number;
  title: string;
  ruleId: string;
  impact: string;
  impactLabel: string;
  confidence: string;
  confidenceLabel: string;
  pagesAffected: number;
  nodesTotal: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadAudit(param: unknown): AuditRow {
  const token = typeof param === "string" ? param.trim() : "";
  const audit = TOKEN_PATTERN.test(token) ? getAuditByToken(token) : null;
  if (!audit) throw new HttpError(404, "We couldn't find that report. Check the link in your email.", "report_not_found");
  return audit;
}

function requireReady(audit: AuditRow): void {
  if (audit.status !== "ready") {
    throw new HttpError(404, "This report isn't ready yet. The report page shows its progress.", "report_not_ready");
  }
}

/** True while the free re-scan can still be started: within 30 days of the audit's creation. */
export function withinRescanWindow(audit: Pick<AuditRow, "created_at">, now: Date = new Date()): boolean {
  return now.getTime() <= rescanDeadline(audit).getTime();
}

/** Why a re-scan cannot start right now, or null when it can (spec 6.5 guards). */
export function rescanBlocker(audit: AuditRow, now: Date = new Date()): string | null {
  if (audit.status !== "ready") return "This report isn't ready yet, so it can't be re-scanned.";
  if (audit.rescan_of) return "This report is itself a re-scan. Each audit includes one free re-scan.";
  if (audit.rescan_used) return "The free re-scan for this audit has already been used.";
  if (!withinRescanWindow(audit, now)) return `The free re-scan window (${RESCAN_WINDOW_DAYS} days from purchase) has closed for this audit.`;
  return null;
}

function rescanCard(audit: AuditRow): RescanCard {
  const deadline = formatDate(rescanDeadline(audit).toISOString());
  if (audit.rescan_of) {
    const original = getAudit(audit.rescan_of);
    return {
      state: "is_rescan",
      deadline,
      relatedUrl: original ? `/r/${encodeURIComponent(original.token)}` : null,
      relatedDate: original ? formatDate(original.finished_at ?? original.created_at) : null,
    };
  }
  if (audit.rescan_used) {
    const rescan = latestRescanOf(audit.id);
    return {
      state: "used",
      deadline,
      relatedUrl: rescan ? `/r/${encodeURIComponent(rescan.token)}` : null,
      relatedDate: rescan ? formatDate(rescan.finished_at ?? rescan.created_at) : null,
    };
  }
  if (!withinRescanWindow(audit)) return { state: "closed", deadline, relatedUrl: null, relatedDate: null };
  return { state: "available", deadline, relatedUrl: null, relatedDate: null };
}

function previewRows(findings: Finding[], narrative: Narrative | null): FindingPreviewRow[] {
  return sortByRank(findings).map((finding) => {
    const title = narrative ? narrativeFor(finding, narrative).title : "";
    return {
      rank: finding.rank,
      title: title.trim() || finding.help || finding.ruleId,
      ruleId: finding.ruleId,
      impact: finding.impact,
      impactLabel: impactLabel(finding.impact),
      confidence: finding.confidence,
      confidenceLabel: confidenceLabel(finding.confidence),
      pagesAffected: finding.pagesAffected,
      nodesTotal: finding.nodesTotal,
    };
  });
}

/** Human wording for audits.error (the raw message stays in the admin log). */
export function describeFailure(audit: Pick<AuditRow, "error" | "url">): string {
  const error = (audit.error ?? "").trim();
  if (error.startsWith("start_url_unreachable:")) {
    // Playwright prefixes navigation errors with the call name; the buyer only needs the network reason.
    const reason = error.slice("start_url_unreachable:".length).trim().replace(/^page\.goto:\s*/, "");
    return `We couldn't load ${audit.url}${reason ? ` (${reason})` : ""}. Check that the address is right and the site is online.`;
  }
  if (error === "timeout") return "The scan ran out of time before the report could be built.";
  if (error === "crashed twice") return "The scan stopped unexpectedly twice.";
  if (error === "") return "The scan stopped before the report could be built.";
  return `The scan stopped with an error: ${error}`;
}

/** "accessaudit-{hostname}-{yyyy-mm-dd}.{ext}" (spec 6.5). */
export function downloadName(audit: AuditRow, ext: string): string {
  const host = hostnameOf(audit.url).replace(/[^A-Za-z0-9.-]+/g, "-").replace(/^-+|-+$/g, "") || "site";
  const date = formatIsoDate(audit.finished_at ?? audit.created_at) || formatIsoDate(new Date().toISOString());
  return `accessaudit-${host}-${date}.${ext}`;
}

function summaryAndNarrative(audit: AuditRow): { summary: ReturnType<typeof auditSummary>; narrative: Narrative | null } {
  return { summary: auditSummary(audit), narrative: auditNarrative(audit) };
}

function reportFile(audit: AuditRow, kind: "pdf" | "json" | "csv"): string {
  const stored = kind === "pdf" ? audit.pdf_path : kind === "json" ? audit.json_path : audit.csv_path;
  const files = reportFilePaths(audit.id);
  const candidates = [stored, files[kind]].filter((candidate): candidate is string => typeof candidate === "string" && candidate !== "");
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // try the next one
    }
  }
  throw new HttpError(404, "That file isn't available for this report. Reply to your receipt email and we'll rebuild it.", "file_missing");
}

/**
 * Streams a report file as an attachment. The file is addressed relative to
 * its own directory (`root`) so the dotfile check applies to the file name
 * only: a data directory such as `.e2e-data` must not turn into a 403.
 */
function sendDownload(res: express.Response, file: string, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    res.download(path.basename(file), name, { root: path.dirname(file), dotfiles: "deny", cacheControl: false }, (err) =>
      err ? reject(err) : resolve(),
    );
  });
}

const rescanLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  handler: (_req, _res, next) => {
    next(new HttpError(429, "Too many re-scan requests from this address in the last hour. Please try again later.", "rate_limited"));
  },
});

/** Creates the re-scan audit, marks the original's re-scan used and queues the job, atomically. */
const startRescan = db.transaction((original: AuditRow): AuditRow => {
  const rescan = createAudit({
    email: original.email,
    url: original.url,
    origin: original.origin,
    page_limit: original.page_limit,
    white_label: original.white_label,
    agency_name: original.agency_name,
    agency_logo_path: original.agency_logo_path,
    tier: original.tier,
    order_id: original.order_id,
    credit_code_id: original.credit_code_id,
    rescan_of: original.id,
  });
  updateAudit(original.id, { rescan_used: 1 });
  enqueueAudit(rescan.id);
  return rescan;
});

// ---------------------------------------------------------------------------
// GET /r/:token
// ---------------------------------------------------------------------------

router.get(
  "/r/:token",
  asyncHandler(async (req, res) => {
    const audit = loadAudit(req.params.token);
    const state: ReportPageState = IN_PROGRESS.has(audit.status) ? "progress" : audit.status === "held" ? "held" : audit.status === "failed" ? "failed" : "ready";
    const hostname = hostnameOf(audit.url);
    const tierName = PRODUCTS[audit.tier]?.name ?? audit.tier;
    const base = `/r/${encodeURIComponent(audit.token)}`;
    res.setHeader("X-Robots-Tag", ROBOTS_HEADER);
    res.setHeader("Cache-Control", "no-store");

    const locals: Record<string, unknown> = {
      title: state === "ready" ? `Accessibility audit of ${hostname}` : `${STATUS_LABELS[audit.status]}: ${hostname}`,
      head:
        `<meta name="robots" content="${ROBOTS_HEADER}">` +
        (state === "progress" ? `<noscript><meta http-equiv="refresh" content="10"></noscript>` : ""),
      audit,
      state,
      hostname,
      tierName,
      base,
      statusLabel: STATUS_LABELS[audit.status],
      orderedOn: formatDate(audit.created_at),
      progressPercent: audit.page_limit > 0 ? Math.min(100, Math.round((100 * audit.progress_pages) / audit.page_limit)) : 0,
      statusUrl: `/api/audits/${encodeURIComponent(audit.token)}/status`,
      failure: state === "failed" ? describeFailure(audit) : null,
      rescan: null,
      reportHtml: null,
      preview: [],
      isRescan: Boolean(audit.rescan_of),
      isWhiteLabel: Boolean(audit.white_label),
    };

    if (state === "held") {
      const findings = findingsForAudit(audit.id);
      locals.preview = previewRows(findings, auditNarrative(audit));
    }

    if (state === "ready") {
      const findings = findingsForAudit(audit.id);
      const { summary, narrative } = summaryAndNarrative(audit);
      if (summary && narrative) {
        const delta: Delta | null = deltaForAudit(audit, findings);
        locals.reportHtml = renderReportHtml({ audit, findings, narrative, summary, delta, mode: "web", pages: pagesForAudit(audit.id) });
      } else {
        locals.reportHtml = null;
        locals.preview = previewRows(findings, narrative);
      }
      locals.rescan = rescanCard(audit);
      locals.downloads = {
        pdf: `${base}/pdf`,
        json: `${base}/json`,
        csv: `${base}/csv`,
        record: `${base}/record`,
        html: `${base}/html`,
      };
      locals.hasPdf = Boolean(audit.pdf_path);
    }

    await renderPage(res, "report-page", locals);
  }),
);

// ---------------------------------------------------------------------------
// GET /api/audits/:token/status
// ---------------------------------------------------------------------------

router.get(
  "/api/audits/:token/status",
  asyncHandler(async (req, res) => {
    const audit = loadAudit(req.params.token);
    res.setHeader("Cache-Control", "no-store");
    res.json({
      status: audit.status,
      label: STATUS_LABELS[audit.status],
      progressPages: audit.progress_pages,
      pageLimit: audit.page_limit,
      progressIssues: audit.progress_issues,
      note: audit.progress_note,
      ready: audit.status === "ready",
      error: audit.status === "failed" ? describeFailure(audit) : null,
    });
  }),
);

// ---------------------------------------------------------------------------
// Downloads and fragments
// ---------------------------------------------------------------------------

for (const kind of ["pdf", "json", "csv"] as const) {
  router.get(
    `/r/:token/${kind}`,
    asyncHandler(async (req, res) => {
      const audit = loadAudit(req.params.token);
      requireReady(audit);
      const file = reportFile(audit, kind);
      res.setHeader("X-Robots-Tag", ROBOTS_HEADER);
      await sendDownload(res, file, downloadName(audit, kind));
    }),
  );
}

router.get(
  "/r/:token/record",
  asyncHandler(async (req, res) => {
    const audit = loadAudit(req.params.token);
    requireReady(audit);
    const summary = auditSummary(audit);
    if (!summary) throw new HttpError(404, "This report has no scan summary to build a record from.", "summary_missing");
    const findings = findingsForAudit(audit.id);
    const delta = deltaForAudit(audit, findings);
    res.setHeader("X-Robots-Tag", ROBOTS_HEADER);
    res.setHeader("Content-Disposition", `inline; filename="${downloadName(audit, "html").replace(/^accessaudit-/, "remediation-record-")}"`);
    res.type("html").send(toRemediationRecord(audit, summary, findings, delta));
  }),
);

router.get(
  "/r/:token/html",
  asyncHandler(async (req, res) => {
    const audit = loadAudit(req.params.token);
    requireReady(audit);
    const findings = findingsForAudit(audit.id);
    const narrative = auditNarrative(audit);
    if (!narrative) throw new HttpError(404, "This report has no narrative yet.", "narrative_missing");
    res.setHeader("X-Robots-Tag", ROBOTS_HEADER);
    res.setHeader("Cache-Control", "no-store");
    res.type("html").send(toIssueTableHtml(findings, narrative));
  }),
);

// ---------------------------------------------------------------------------
// POST /r/:token/rescan
// ---------------------------------------------------------------------------

router.post(
  "/r/:token/rescan",
  rescanLimiter,
  asyncHandler(async (req, res) => {
    const audit = loadAudit(req.params.token);
    const blocker = rescanBlocker(audit);
    if (blocker) throw new HttpError(400, blocker, "rescan_not_allowed");
    const rescan = startRescan(audit);
    res.redirect(303, `/r/${encodeURIComponent(rescan.token)}`);
  }),
);

// ---------------------------------------------------------------------------
// GET /screenshots/:auditId/:file?t=token
// ---------------------------------------------------------------------------

/** True when `token` is the audit's own token or the token of the audit it re-scans. */
export function screenshotTokenAllowed(audit: AuditRow, token: string): boolean {
  if (token === "" || !TOKEN_PATTERN.test(token)) return false;
  if (safeEqual(token, audit.token)) return true;
  if (audit.rescan_of) {
    const original = getAudit(audit.rescan_of);
    if (original && safeEqual(token, original.token)) return true;
  }
  return false;
}

router.get(
  "/screenshots/:auditId/:file",
  asyncHandler(async (req, res) => {
    const auditId = String(req.params.auditId);
    const file = String(req.params.file);
    const token = typeof req.query.t === "string" ? req.query.t : "";
    const notFound = new HttpError(404, "We couldn't find that image.", "not_found");
    if (!SCREENSHOT_FILE.test(file) || file.includes("..")) throw notFound;
    const audit = getAudit(auditId);
    if (!audit || !screenshotTokenAllowed(audit, token)) throw notFound;
    const shotsDir = reportFilePaths(audit.id).shots;
    const target = path.join(shotsDir, file);
    if (!target.startsWith(shotsDir + path.sep)) throw notFound;
    let isFile = false;
    try {
      isFile = fs.statSync(target).isFile();
    } catch {
      isFile = false;
    }
    if (!isFile) throw notFound;
    res.setHeader("X-Robots-Tag", ROBOTS_HEADER);
    res.setHeader("Cache-Control", "private, max-age=3600");
    // `root` keeps the dotfile check on the file name only (see sendDownload).
    await new Promise<void>((resolve, reject) => {
      res.sendFile(file, { root: shotsDir, dotfiles: "deny" }, (err) => (err ? reject(err) : resolve()));
    });
  }),
);
