// The audit pipeline (spec section 13): one call turns a queued audit row into
// a finished report. Phases, each logged to audits.log and mirrored in the
// status column so the report page can show honest progress:
//
//   crawling  -> SSRF check, robots.txt, BFS crawl for up to page_limit URLs
//   scanning  -> desktop + mobile axe run per page (one context at a time)
//   ranking   -> rankFindings, screenshots for ranks 1-10, findings rows
//   writing   -> narrative (Claude or the dictionary), summary_json/narrative_json
//   rendering -> delta (re-scans), PDF, JSON, CSV under ${dataDir}/audits/${id}/
//   finish    -> close the browser, held (Reviewed Audit) or ready, emails, funnel event
//
// runAudit() never throws: every failure ends with status "failed", the error
// stored on the row and the stack in the log. The runner may pass an
// AbortSignal; once it fires (audit timeout) the pipeline stops at the next
// checkpoint and leaves the row alone, because the runner has already
// recorded the timeout.

import fs from "node:fs";
import path from "node:path";
import type { BrowserContext } from "playwright";
import {
  appendAuditLog,
  auditNarrative,
  auditSummary,
  clearAuditResults,
  deltaForAudit,
  findingsForAudit,
  getAudit,
  insertFindings,
  insertPages,
  pagesForAudit,
  reportFilePaths,
  setProgress,
  updateAudit,
} from "../audits.js";
import { nowIso } from "../db.js";
import { sendEmail } from "../email/send.js";
import { inReview, reportReady } from "../email/templates.js";
import { buildNarrative } from "../narrative/index.js";
import { toCsv, toJson } from "../report/exports.js";
import { htmlToPdf } from "../report/pdf.js";
import { rankFindings } from "../report/rank.js";
import { renderReportHtml } from "../report/render.js";
import { track } from "../routes/funnel.js";
import { countViolationNodes, scanPage } from "../scan/axe.js";
import { closeBrowser, closeContext, newScanContext } from "../scan/browser.js";
import { crawl } from "../scan/crawler.js";
import { loadRobots } from "../scan/robots.js";
import { captureElement } from "../scan/screenshots.js";
import { assertPublicUrl } from "../scan/ssrf.js";
import type { AuditRow, AuditSummary, Confidence, Finding, Impact, PageScan, SiteMeta, Viewport } from "../types.js";

export const VIEWPORTS: readonly Viewport[] = ["desktop", "mobile"];
/** Findings that get an element screenshot (ranks 1..N). */
export const SCREENSHOT_RANKS = 10;
/** Cap for the whole screenshot phase so it can never eat the audit budget. */
export const SCREENSHOT_PHASE_MS = 120000;
export const SCREENSHOT_NAVIGATION_MS = 30000;
export const SCREENSHOT_SETTLE_MS = 500;
/** Longest error message stored in audits.error. */
export const MAX_ERROR_CHARS = 500;

export interface RunAuditOptions {
  /** Fired by the runner when the audit exceeds config.auditTimeoutMs. */
  signal?: AbortSignal;
}

export class AuditAbortedError extends Error {
  constructor(reason: string) {
    super(`audit aborted: ${reason}`);
    this.name = "AuditAbortedError";
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message.split("\n")[0] ?? err.message;
  return String(err);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    const reason = signal.reason;
    throw new AuditAbortedError(reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "timeout");
  }
}

/** Platform guess from HTML markers (spec 13.2), checked in the spec's order. */
export function guessPlatform(html: string): SiteMeta["platformGuess"] {
  const text = html.toLowerCase();
  if (text.includes("cdn.shopify.com")) return "shopify";
  if (text.includes("wp-content")) return "wordpress";
  if (text.includes("webflow")) return "webflow";
  if (text.includes("squarespace")) return "squarespace";
  if (text.includes("wixstatic")) return "wix";
  return "unknown";
}

function shortUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}` || "/";
  } catch {
    return url;
  }
}

function plural(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

/** Folds the per-page scans and the ranked findings into the AuditSummary stored as summary_json. */
export function buildSummary(
  urls: string[],
  scans: PageScan[],
  findings: Finding[],
  scanStartedAt: string,
  scanFinishedAt: string,
): AuditSummary {
  const loaded = new Set<string>();
  for (const scan of scans) {
    if (scan.error === undefined) loaded.add(scan.url);
  }
  const pagesScanned = urls.filter((url) => loaded.has(url)).length;
  const byImpact: Record<Impact, number> = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  const byConfidence: Record<Confidence, number> = { automated: 0, needs_manual: 0 };
  let totalViolationNodes = 0;
  for (const finding of findings) {
    byImpact[finding.impact] += 1;
    byConfidence[finding.confidence] += 1;
    if (finding.confidence === "automated") totalViolationNodes += finding.nodesTotal;
  }
  return {
    pagesRequested: urls.length,
    pagesScanned,
    pagesFailed: urls.length - pagesScanned,
    totalViolationNodes,
    findingsCount: findings.length,
    byImpact,
    byConfidence,
    scanStartedAt,
    scanFinishedAt,
    viewports: [...VIEWPORTS],
  };
}

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

interface Logger {
  (line: string): void;
}

interface ScanPhaseResult {
  scans: PageScan[];
  siteTitle: string;
  platformGuess: SiteMeta["platformGuess"];
}

async function crawlPhase(audit: AuditRow, log: Logger, signal: AbortSignal | undefined): Promise<string[]> {
  setProgress(audit.id, { status: "crawling", progress_pages: 0, progress_issues: 0, progress_note: "Checking the address" });
  const target = await assertPublicUrl(audit.url);
  log(`crawling ${target.href} (up to ${plural(audit.page_limit, "page")})`);
  throwIfAborted(signal);

  const robots = await loadRobots(target.origin);
  log(robots.fetched ? `robots.txt loaded (${plural(robots.rules.length, "rule")} for *)` : "robots.txt not found or unreadable; allowing every path");
  throwIfAborted(signal);

  const urls = await crawl({
    startUrl: target.href,
    pageLimit: audit.page_limit,
    robots,
    onProgress: (progress) => {
      log(`crawl: ${progress.message}`);
      if (progress.kind === "done") {
        setProgress(audit.id, { progress_note: progress.message });
      } else if (progress.kind === "visited") {
        setProgress(audit.id, { progress_note: `Found ${plural(progress.found, "page")} so far` });
      }
    },
  });
  return urls;
}

async function scanOne(url: string, viewport: Viewport, wantHtml: boolean): Promise<{ scan: PageScan; html: string | null }> {
  let context: BrowserContext | null = null;
  try {
    context = await newScanContext(viewport);
    const page = await context.newPage();
    const scan = await scanPage(page, url, viewport);
    let html: string | null = null;
    if (wantHtml && scan.error === undefined) {
      try {
        html = await page.content();
      } catch {
        html = null;
      }
    }
    return { scan, html };
  } finally {
    await closeContext(context);
  }
}

async function scanPhase(audit: AuditRow, urls: string[], log: Logger, signal: AbortSignal | undefined): Promise<ScanPhaseResult> {
  setProgress(audit.id, { status: "scanning", progress_pages: 0, progress_issues: 0, progress_note: `Scanning ${plural(urls.length, "page")}` });
  const scans: PageScan[] = [];
  let siteTitle = "";
  let platformGuess: SiteMeta["platformGuess"] = "unknown";
  let pagesDone = 0;
  let issuesSoFar = 0;

  for (const url of urls) {
    throwIfAborted(signal);
    setProgress(audit.id, { progress_note: `Scanning ${shortUrl(url)} (${pagesDone + 1} of ${urls.length})` });
    const pageScans: PageScan[] = [];
    for (const viewport of VIEWPORTS) {
      throwIfAborted(signal);
      const { scan, html } = await scanOne(url, viewport, viewport === "desktop" && platformGuess === "unknown");
      pageScans.push(scan);
      if (viewport === "desktop" && scan.error === undefined) {
        if (siteTitle === "" && scan.title !== "") siteTitle = scan.title;
        if (html !== null && platformGuess === "unknown") platformGuess = guessPlatform(html);
      }
    }
    insertPages(audit.id, pageScans);
    scans.push(...pageScans);

    const desktop = pageScans.find((scan) => scan.viewport === "desktop");
    const mobile = pageScans.find((scan) => scan.viewport === "mobile");
    const desktopOk = desktop !== undefined && desktop.error === undefined;
    const mobileOk = mobile !== undefined && mobile.error === undefined;
    // Same counting rule as rankFindings: desktop nodes, mobile only where desktop failed.
    const nodes = desktopOk ? countViolationNodes(desktop) : mobileOk ? countViolationNodes(mobile) : 0;
    pagesDone += 1;
    issuesSoFar += nodes;
    setProgress(audit.id, { progress_pages: pagesDone, progress_issues: issuesSoFar });

    const parts = pageScans.map((scan) =>
      scan.error === undefined
        ? `${scan.viewport}: ${plural(countViolationNodes(scan), "issue")}${scan.incomplete.length > 0 ? `, ${scan.incomplete.length} to check by hand` : ""}`
        : `${scan.viewport}: could not scan (${scan.error})`,
    );
    log(`scanned ${url} (${parts.join("; ")})`);
  }

  log(`scanning done: ${plural(pagesDone, "page")}, ${plural(issuesSoFar, "issue")}; site title "${siteTitle}", platform ${platformGuess}`);
  return { scans, siteTitle, platformGuess };
}

async function screenshotPhase(audit: AuditRow, findings: Finding[], log: Logger, signal: AbortSignal | undefined): Promise<void> {
  const targets = findings
    .filter((finding) => finding.rank <= SCREENSHOT_RANKS && finding.examplePageUrl !== null && finding.exampleSelector !== null)
    .sort((a, b) => (a.examplePageUrl ?? "").localeCompare(b.examplePageUrl ?? "") || a.rank - b.rank);
  if (targets.length === 0) return;

  const shotsDir = reportFilePaths(audit.id).shots;
  fs.mkdirSync(shotsDir, { recursive: true });
  setProgress(audit.id, { progress_note: "Taking screenshots of the top issues" });

  let captured = 0;
  let context: BrowserContext | null = null;
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`screenshot phase exceeded ${Math.round(SCREENSHOT_PHASE_MS / 1000)}s`)), SCREENSHOT_PHASE_MS);
  });

  const work = async (): Promise<void> => {
    context = await newScanContext("desktop");
    const page = await context.newPage();
    let currentUrl: string | null = null;
    let loaded = false;
    for (const finding of targets) {
      throwIfAborted(signal);
      const pageUrl = finding.examplePageUrl as string;
      const selector = finding.exampleSelector as string;
      if (pageUrl !== currentUrl) {
        currentUrl = pageUrl;
        try {
          await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: SCREENSHOT_NAVIGATION_MS });
          await page.waitForTimeout(SCREENSHOT_SETTLE_MS);
          loaded = true;
        } catch (err) {
          loaded = false;
          log(`screenshot: could not load ${pageUrl} (${errorMessage(err)})`);
        }
      }
      if (!loaded) continue;
      const outPath = path.join(shotsDir, `f${finding.rank}.png`);
      if (await captureElement(page, selector, outPath)) {
        finding.screenshotPath = outPath;
        captured += 1;
      } else {
        log(`screenshot: no capture for #${finding.rank} ${finding.ruleId} (${selector})`);
      }
    }
  };

  try {
    await Promise.race([work(), deadline]);
  } catch (err) {
    if (err instanceof AuditAbortedError) throw err;
    log(`screenshot phase stopped early (${errorMessage(err)})`);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    await closeContext(context);
  }
  log(`captured ${captured} of ${plural(targets.length, "screenshot")}`);
}

interface RenderedFiles {
  pdf: string;
  json: string;
  csv: string;
}

async function renderPhase(audit: AuditRow, findings: Finding[], finishedAt: string, log: Logger): Promise<RenderedFiles> {
  setProgress(audit.id, { status: "rendering", progress_note: "Building the PDF" });
  const fresh = getAudit(audit.id) ?? audit;
  const summary = auditSummary(fresh);
  const narrative = auditNarrative(fresh);
  if (!summary || !narrative) throw new Error("summary or narrative missing before rendering");

  // The row the report is rendered from carries the finish time so the cover
  // date and the delta dates match what the admin re-render will use later.
  const forReport: AuditRow = { ...fresh, finished_at: finishedAt };
  const delta = deltaForAudit(forReport, findings, finishedAt);
  if (delta) {
    log(
      `re-scan delta against ${delta.originalAuditId}: ${delta.fixed.length} fixed, ${delta.unchanged.length} still present, ${delta.newIssues.length} new, ${delta.percentFixed}% of elements fixed`,
    );
  }

  const files = reportFilePaths(audit.id);
  fs.mkdirSync(files.dir, { recursive: true });
  const html = renderReportHtml({ audit: forReport, findings, narrative, summary, delta, mode: "pdf", pages: pagesForAudit(audit.id) });
  await htmlToPdf(html, files.pdf);
  const pdfBytes = fs.statSync(files.pdf).size;
  log(`PDF written (${Math.round(pdfBytes / 1024)} KB)`);

  fs.writeFileSync(files.json, JSON.stringify(toJson(forReport, summary, findings, narrative, delta), null, 2));
  fs.writeFileSync(files.csv, toCsv(findings, narrative));
  log("JSON and CSV written");
  return { pdf: files.pdf, json: files.json, csv: files.csv };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Runs the whole pipeline for one audit. Resolves when the row is held, ready
 * or failed; never rejects. See the module comment for the phases.
 */
export async function runAudit(auditId: string, options: RunAuditOptions = {}): Promise<void> {
  const signal = options.signal;
  const log: Logger = (line) => {
    try {
      appendAuditLog(auditId, line);
    } catch (err) {
      console.error("audit %s: could not append log line: %s", auditId, errorMessage(err));
    }
  };

  const audit = getAudit(auditId);
  if (!audit) {
    console.error("runAudit: audit %s not found", auditId);
    return;
  }

  try {
    // A retry after a crash or an admin re-run starts from a clean slate.
    clearAuditResults(audit.id);
    const startedAt = audit.started_at ?? nowIso();
    updateAudit(audit.id, {
      status: "crawling",
      started_at: startedAt,
      finished_at: null,
      released_at: null,
      error: null,
      narrative_json: null,
      summary_json: null,
      pdf_path: null,
      json_path: null,
      csv_path: null,
    });
    log(`audit started: ${audit.url} (${audit.tier}${audit.rescan_of ? `, re-scan of ${audit.rescan_of}` : ""}, up to ${plural(audit.page_limit, "page")})`);
    throwIfAborted(signal);

    // 1. Crawl
    const urls = await crawlPhase(audit, log, signal);
    throwIfAborted(signal);

    // 2. Scan
    const scanStartedAt = nowIso();
    const { scans, siteTitle, platformGuess } = await scanPhase(audit, urls, log, signal);
    const scanFinishedAt = nowIso();
    throwIfAborted(signal);

    // 3. Rank, screenshots, findings rows
    const findings = rankFindings(scans);
    log(`ranked ${plural(findings.length, "finding")} (${findings.filter((f) => f.confidence === "automated").length} automated, ${findings.filter((f) => f.confidence === "needs_manual").length} to check by hand)`);
    await screenshotPhase(audit, findings, log, signal);
    throwIfAborted(signal);
    insertFindings(audit.id, findings);

    // 4. Narrative
    setProgress(audit.id, { status: "writing", progress_note: "Writing your report" });
    const summary = buildSummary(urls, scans, findings, scanStartedAt, scanFinishedAt);
    const siteMeta: SiteMeta = { url: audit.url, origin: audit.origin, siteTitle, platformGuess };
    updateAudit(audit.id, { summary_json: JSON.stringify(summary) });
    const narrative = await buildNarrative(findings, summary, siteMeta, log);
    updateAudit(audit.id, { narrative_json: JSON.stringify(narrative) });
    log(
      `narrative saved (${narrative.generatedBy}${narrative.model ? `, ${narrative.model}` : ""}, ${narrative.findings.length} finding ${narrative.findings.length === 1 ? "entry" : "entries"})`,
    );
    throwIfAborted(signal);

    // 5. Render
    const finishedAt = nowIso();
    const files = await renderPhase(audit, findings, finishedAt, log);
    updateAudit(audit.id, { pdf_path: files.pdf, json_path: files.json, csv_path: files.csv });
    throwIfAborted(signal);

    // 6. Finish
    await closeBrowser();
    const hold = audit.tier === "reviewed" && !audit.rescan_of;
    const done =
      updateAudit(audit.id, {
        status: hold ? "held" : "ready",
        finished_at: finishedAt,
        progress_note: hold ? "Waiting for a human review" : "Report ready",
      }) ?? audit;
    if (hold) {
      log("finished: held for human review (Reviewed Audit)");
      const mail = inReview(done);
      const sent = await sendEmail({ to: done.email, subject: mail.subject, html: mail.html });
      log(`email "${mail.subject}" ${sent.error ? `kept in the outbox (${sent.error})` : `sent via ${sent.sentVia}`}`);
    } else {
      log("finished: report ready");
      const mail = reportReady(done, findingsForAudit(done.id));
      const sent = await sendEmail({ to: done.email, subject: mail.subject, html: mail.html });
      log(`email "${mail.subject}" ${sent.error ? `kept in the outbox (${sent.error})` : `sent via ${sent.sentVia}`}`);
      track(audit.rescan_of ? "rescan" : "report_ready", { audit: audit.id, tier: audit.tier, pages: summary.pagesScanned, findings: findings.length });
    }
  } catch (err) {
    if (err instanceof AuditAbortedError || signal?.aborted) {
      // The runner recorded the timeout and closed the browser; only leave a trace.
      log(`stopped: ${errorMessage(err)}`);
      return;
    }
    const message = errorMessage(err).slice(0, MAX_ERROR_CHARS);
    const stack = err instanceof Error && err.stack ? err.stack : String(err);
    console.error("audit %s failed: %s", auditId, message);
    log(`failed: ${message}`);
    log(stack);
    try {
      updateAudit(auditId, { status: "failed", error: message, finished_at: nowIso(), progress_note: "Failed" });
    } catch (updateErr) {
      console.error("audit %s: could not record the failure: %s", auditId, errorMessage(updateErr));
    }
    await closeBrowser();
  }
}
