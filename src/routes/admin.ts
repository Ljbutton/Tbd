// Admin dashboard and the development outbox (spec 6.7).
//
//   GET  /admin                          mode banner, funnel counters, orders, audits
//   GET  /admin/audits/:id               status, timing, log, pages, findings, narrative editor
//   POST /admin/audits/:id/rerun         reset to queued, clear results, new job
//   POST /admin/audits/:id/narrative     validate against NarrativeSchema, save, re-render PDF/JSON/CSV
//   POST /admin/audits/:id/release       held -> ready, released_at, report-ready email
//   POST /admin/orders/:id/mark-paid     markPaid(via: "admin") for bank transfers / marketplace orders
//   GET  /outbox, /outbox/:id, /outbox/:id/raw   stored emails (only without RESEND_API_KEY)
//
// Everything under /admin sits behind basic auth (admin:${ADMIN_PASSWORD},
// timing-safe compare, 503 in production when the password is unset). The
// outbox needs no auth in development and basic auth in production.

import fs from "node:fs";
import express, { type RequestHandler } from "express";
import {
  appendAuditLog,
  auditNarrative,
  auditSummary,
  clearAuditResults,
  deltaForAudit,
  findingsForAudit,
  getAudit,
  listAudits,
  pagesForAudit,
  reportFilePaths,
  updateAudit,
} from "../audits.js";
import { config, missingEnv, modeLines } from "../config.js";
import { db, nowIso } from "../db.js";
import { extractHttpLinks, getOutboxEmail, listEmailsTo, listOutbox, sendEmail } from "../email/send.js";
import { reportReady } from "../email/templates.js";
import { enqueueAudit, runnerStats } from "../jobs/runner.js";
import { NarrativeSchema } from "../narrative/claude.js";
import { formatUsd, getOrder, listOrders, markPaid } from "../payments/orders.js";
import { toCsv, toJson } from "../report/exports.js";
import { htmlToPdf } from "../report/pdf.js";
import { renderReportHtml } from "../report/render.js";
import { closeBrowser } from "../scan/browser.js";
import type { AuditRow, AuditSummary, JobRow, Narrative } from "../types.js";
import { HttpError, asyncHandler, basicAuth } from "../util/http.js";
import { renderPage } from "../util/render.js";
import { FUNNEL_EVENT_TYPES, funnelCounts, track } from "./funnel.js";

export const router = express.Router();

export const FUNNEL_WINDOW_DAYS = 30;
export const LIST_LIMIT = 100;
export const OUTBOX_LIMIT = 50;

/** Extra styles for the admin pages, inserted into <head> through the layout's `head` local. */
const ADMIN_HEAD = `<style>
  .admin-actions { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; }
  .admin-actions form { margin: 0; }
  .admin-log { max-height: 24rem; overflow: auto; font-size: 0.85rem; }
  .admin-narrative { font-family: var(--font-mono); font-size: 0.85rem; min-height: 26rem; }
  .admin-kv { display: grid; grid-template-columns: max-content 1fr; gap: 0.25rem 1rem; margin: 0 0 1rem; }
  .admin-kv dt { font-weight: 600; color: var(--color-muted); }
  .admin-kv dd { margin: 0; overflow-wrap: anywhere; }
  .admin-inline-form { display: inline; }
  .admin-funnel { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); }
  .admin-cell-wide { min-width: 16rem; }
  .outbox-frame { width: 100%; min-height: 32rem; border: 1px solid var(--color-border); border-radius: var(--radius-sm); background: #ffffff; }
</style>`;

const adminAuth = basicAuth({ password: () => config.adminPassword, realm: "admin" });

const jobsForAuditStmt = db.prepare("SELECT * FROM jobs WHERE ref_id = ? ORDER BY created_at DESC, rowid DESC");
const openJobsForAuditStmt = db.prepare(
  "SELECT status FROM jobs WHERE ref_id = ? AND status IN ('queued', 'running') ORDER BY created_at DESC",
);

// ---------------------------------------------------------------------------
// Small helpers shared by the routes
// ---------------------------------------------------------------------------

interface Notice {
  kind: "success" | "info" | "warning" | "error";
  text: string;
}

/** Messages shown after a redirect; only these keys are ever echoed, never raw query input. */
const NOTICES: Record<string, Notice> = {
  marked_paid: {
    kind: "success",
    text: "Order marked paid. A Site or Reviewed order now has a queued audit; a 5-Pack order has its credit code issued and emailed.",
  },
  already_paid: { kind: "info", text: "That order was already paid; nothing changed." },
  rerun: { kind: "success", text: "Audit reset to queued with a new job. The runner picks it up within a few seconds." },
  already_running: { kind: "warning", text: "That audit is running right now. Wait for it to finish or fail before re-running it." },
  already_queued: { kind: "info", text: "That audit already has a queued job, so nothing was added." },
  saved: { kind: "success", text: "Saved and re-rendered. The PDF, JSON and CSV were rebuilt from the edited narrative." },
  saved_not_rendered: {
    kind: "warning",
    text: "Narrative saved, but the report could not be re-rendered because this audit has no scan summary yet. Re-run the audit to produce one.",
  },
  released: { kind: "success", text: "Released. The audit is ready and the report-ready email was sent." },
  not_held: { kind: "warning", text: "Only held audits can be released." },
};

function noticeFor(query: unknown): Notice | null {
  return typeof query === "string" ? (NOTICES[query] ?? null) : null;
}

/** "2026-09-23 14:05:12 UTC"; empty for null, the raw text when it is not a date. */
export function formatStamp(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 19)} UTC`;
}

/** "4m 12s" between two timestamps; empty when either is missing. */
export function formatDuration(fromIso: string | null | undefined, toIso: string | null | undefined): string {
  if (!fromIso || !toIso) return "";
  const from = new Date(fromIso).getTime();
  const to = new Date(toIso).getTime();
  if (Number.isNaN(from) || Number.isNaN(to) || to < from) return "";
  const totalSeconds = Math.round((to - from) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function statusBadge(status: string): string {
  switch (status) {
    case "ready":
    case "done":
    case "paid":
      return "badge-success";
    case "failed":
    case "refunded":
      return "badge-danger";
    case "held":
      return "badge-manual";
    case "pending":
    case "queued":
      return "";
    default:
      return "badge-info";
  }
}

function loadAudit(id: string): AuditRow {
  const audit = getAudit(id);
  if (!audit) throw new HttpError(404, "We couldn't find that audit.", "audit_not_found");
  return audit;
}

function parseSummary(audit: AuditRow): AuditSummary | null {
  return auditSummary(audit);
}

function parseNarrative(audit: AuditRow): Narrative | null {
  return auditNarrative(audit);
}

function prettyNarrative(audit: AuditRow): string {
  const parsed = parseNarrative(audit);
  if (parsed) return JSON.stringify(parsed, null, 2);
  return audit.narrative_json ?? "";
}

function jobsForAudit(auditId: string): JobRow[] {
  return jobsForAuditStmt.all(auditId) as JobRow[];
}

function openJobStatus(auditId: string): "queued" | "running" | null {
  const rows = openJobsForAuditStmt.all(auditId) as { status: "queued" | "running" }[];
  if (rows.some((row) => row.status === "running")) return "running";
  return rows.length > 0 ? "queued" : null;
}

const STATUS_LABELS: Record<string, string> = {
  queued: "Waiting in line",
  crawling: "Finding pages",
  scanning: "Scanning pages",
  writing: "Writing the report",
  rendering: "Building the PDF",
  held: "Held for human review",
  ready: "Ready",
  failed: "Failed",
};

// ---------------------------------------------------------------------------
// Narrative editing and re-rendering
// ---------------------------------------------------------------------------

export type NarrativeParseResult = { ok: true; narrative: Narrative } | { ok: false; error: string };

/**
 * Turns the textarea contents into a Narrative: must be valid JSON that
 * matches NarrativeSchema. `generatedBy`/`model` are not part of the schema,
 * so they are taken from the submitted JSON when valid, else from the
 * previously stored narrative.
 */
export function parseNarrativeSubmission(text: string, previous: Narrative | null): NarrativeParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `The narrative is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  const result = NarrativeSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 10)
      .map((issue) => `${issue.path.length > 0 ? issue.path.map(String).join(".") : "(root)"}: ${issue.message}`);
    const more = result.error.issues.length > 10 ? ` (+${result.error.issues.length - 10} more)` : "";
    return { ok: false, error: `The narrative does not match the schema. ${issues.join("; ")}${more}` };
  }
  const extras = typeof raw === "object" && raw !== null ? (raw as { generatedBy?: unknown; model?: unknown }) : {};
  const generatedBy: Narrative["generatedBy"] =
    extras.generatedBy === "claude" || extras.generatedBy === "dictionary" ? extras.generatedBy : (previous?.generatedBy ?? "dictionary");
  const model =
    typeof extras.model === "string" && extras.model.trim() !== "" ? extras.model.trim() : previous?.model;
  const narrative: Narrative = { ...result.data, generatedBy };
  if (model !== undefined) narrative.model = model;
  return { ok: true, narrative };
}

export { reportFilePaths } from "../audits.js";

/**
 * Rebuilds report.pdf, report.json and report.csv from the stored findings
 * and the given narrative, then stores the paths. Requires a scan summary
 * (the audit must have finished scanning at least once). Uses the same file
 * locations and delta dates as the pipeline (src/jobs/audit.ts).
 */
export async function rerenderReport(audit: AuditRow, narrative: Narrative, summary: AuditSummary): Promise<AuditRow> {
  const findings = findingsForAudit(audit.id);
  const delta = deltaForAudit(audit, findings);
  const files = reportFilePaths(audit.id);
  fs.mkdirSync(files.dir, { recursive: true });

  const html = renderReportHtml({ audit, findings, narrative, summary, delta, mode: "pdf" });
  try {
    await htmlToPdf(html, files.pdf);
  } finally {
    // The shared browser is normally closed at the end of each audit; when the
    // queue is idle nothing else will, so free the memory here.
    const stats = runnerStats();
    if (stats.running === 0 && stats.queued === 0) await closeBrowser();
  }
  fs.writeFileSync(files.json, JSON.stringify(toJson(audit, summary, findings, narrative, delta), null, 2));
  fs.writeFileSync(files.csv, toCsv(findings, narrative));

  return updateAudit(audit.id, { pdf_path: files.pdf, json_path: files.json, csv_path: files.csv }) ?? audit;
}

// ---------------------------------------------------------------------------
// View models
// ---------------------------------------------------------------------------

async function renderAuditDetail(
  res: express.Response,
  audit: AuditRow,
  options: { notice?: Notice | null; error?: string | null; narrativeText?: string; status?: number } = {},
): Promise<void> {
  const findings = findingsForAudit(audit.id);
  const pages = pagesForAudit(audit.id);
  const jobs = jobsForAudit(audit.id);
  const emails = listEmailsTo(audit.email, 10);
  const narrative = parseNarrative(audit);
  const summary = parseSummary(audit);
  const original = audit.rescan_of ? getAudit(audit.rescan_of) : null;
  const open = openJobStatus(audit.id);

  await renderPage(
    res,
    "admin/audit",
    {
      title: `Audit ${shortId(audit.id)}`,
      head: ADMIN_HEAD,
      audit,
      findings,
      pages,
      jobs,
      emails,
      summary,
      original,
      narrativeText: options.narrativeText ?? prettyNarrative(audit),
      narrativeMeta: narrative ? { generatedBy: narrative.generatedBy, model: narrative.model ?? null, findings: narrative.findings.length } : null,
      notice: options.notice ?? null,
      error: options.error ?? null,
      statusLabel: STATUS_LABELS[audit.status] ?? audit.status,
      statusBadge,
      openJob: open,
      canRelease: audit.status === "held",
      canRerun: open !== "running",
      reportUrl: `/r/${encodeURIComponent(audit.token)}`,
      publicUrl: `${config.baseUrl}/r/${encodeURIComponent(audit.token)}`,
      outboxEnabled: config.emailOutbox,
      duration: formatDuration(audit.started_at, audit.finished_at),
      formatStamp,
      shortId,
    },
    options.status ?? 200,
  );
}

// ---------------------------------------------------------------------------
// /admin
// ---------------------------------------------------------------------------

router.use("/admin", adminAuth);

router.get(
  "/admin",
  asyncHandler(async (req, res) => {
    const audits = listAudits(LIST_LIMIT);
    await renderPage(res, "admin/index", {
      title: "Admin",
      head: ADMIN_HEAD,
      missing: missingEnv(),
      modes: modeLines(),
      funnel: funnelCounts(FUNNEL_WINDOW_DAYS),
      funnelTypes: FUNNEL_EVENT_TYPES,
      funnelDays: FUNNEL_WINDOW_DAYS,
      queue: runnerStats(),
      orders: listOrders(LIST_LIMIT),
      audits,
      heldCount: audits.filter((audit) => audit.status === "held").length,
      notice: noticeFor(req.query.notice),
      outboxEnabled: config.emailOutbox,
      listLimit: LIST_LIMIT,
      formatUsd,
      formatStamp,
      shortId,
      statusBadge,
    });
  }),
);

router.get(
  "/admin/audits/:id",
  asyncHandler(async (req, res) => {
    const audit = loadAudit(String(req.params.id));
    await renderAuditDetail(res, audit, { notice: noticeFor(req.query.notice) });
  }),
);

router.post(
  "/admin/audits/:id/rerun",
  asyncHandler(async (req, res) => {
    const audit = loadAudit(String(req.params.id));
    const open = openJobStatus(audit.id);
    if (open === "running") {
      res.redirect(303, `/admin/audits/${encodeURIComponent(audit.id)}?notice=already_running`);
      return;
    }
    if (open === "queued") {
      res.redirect(303, `/admin/audits/${encodeURIComponent(audit.id)}?notice=already_queued`);
      return;
    }
    clearAuditResults(audit.id);
    updateAudit(audit.id, {
      status: "queued",
      error: null,
      narrative_json: null,
      summary_json: null,
      pdf_path: null,
      json_path: null,
      csv_path: null,
      started_at: null,
      finished_at: null,
      released_at: null,
    });
    appendAuditLog(audit.id, "admin: re-run requested; results cleared and a new job queued");
    enqueueAudit(audit.id);
    res.redirect(303, `/admin/audits/${encodeURIComponent(audit.id)}?notice=rerun`);
  }),
);

router.post(
  "/admin/audits/:id/narrative",
  asyncHandler(async (req, res) => {
    const audit = loadAudit(String(req.params.id));
    const body = (req.body ?? {}) as { narrative?: unknown };
    const text = typeof body.narrative === "string" ? body.narrative : "";
    if (text.trim() === "") {
      await renderAuditDetail(res, audit, { error: "Paste the narrative JSON before saving.", narrativeText: text, status: 400 });
      return;
    }
    const parsed = parseNarrativeSubmission(text, parseNarrative(audit));
    if (!parsed.ok) {
      await renderAuditDetail(res, audit, { error: parsed.error, narrativeText: text, status: 400 });
      return;
    }

    const saved = updateAudit(audit.id, { narrative_json: JSON.stringify(parsed.narrative) }) ?? audit;
    appendAuditLog(audit.id, "admin: narrative edited by hand");
    const summary = parseSummary(saved);
    if (!summary) {
      res.redirect(303, `/admin/audits/${encodeURIComponent(audit.id)}?notice=saved_not_rendered`);
      return;
    }
    try {
      await rerenderReport(saved, parsed.narrative, summary);
      appendAuditLog(audit.id, "admin: PDF, JSON and CSV re-rendered from the edited narrative");
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error("admin: re-render failed for audit %s", audit.id, err);
      appendAuditLog(audit.id, `admin: re-render failed (${reason})`);
      const fresh = getAudit(audit.id) ?? saved;
      await renderAuditDetail(res, fresh, {
        error: `The narrative was saved, but re-rendering the report failed: ${reason}`,
        status: 500,
      });
      return;
    }
    res.redirect(303, `/admin/audits/${encodeURIComponent(audit.id)}?notice=saved`);
  }),
);

router.post(
  "/admin/audits/:id/release",
  asyncHandler(async (req, res) => {
    const audit = loadAudit(String(req.params.id));
    if (audit.status !== "held") {
      res.redirect(303, `/admin/audits/${encodeURIComponent(audit.id)}?notice=not_held`);
      return;
    }
    const now = nowIso();
    const released =
      updateAudit(audit.id, { status: "ready", released_at: now, finished_at: audit.finished_at ?? now }) ?? audit;
    appendAuditLog(audit.id, "admin: released after human review");
    track("report_ready", { audit: audit.id, tier: audit.tier, released: true });
    const content = reportReady(released, findingsForAudit(released.id));
    await sendEmail({ to: released.email, subject: content.subject, html: content.html });
    res.redirect(303, `/admin/audits/${encodeURIComponent(audit.id)}?notice=released`);
  }),
);

router.post(
  "/admin/orders/:id/mark-paid",
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    // markPaid() is idempotent and does not say whether it changed anything, so
    // look at the status first to pick the right notice (404 comes from markPaid).
    const wasPending = getOrder(id)?.status === "pending";
    markPaid(id, { via: "admin" });
    res.redirect(303, `/admin?notice=${wasPending ? "marked_paid" : "already_paid"}`);
  }),
);

// ---------------------------------------------------------------------------
// /outbox (development mail viewer)
// ---------------------------------------------------------------------------

const outboxGuard: RequestHandler = (req, res, next) => {
  if (!config.emailOutbox) {
    next(
      new HttpError(
        404,
        "The outbox only exists when no RESEND_API_KEY is set. With a key configured, emails are sent through Resend.",
        "not_found",
      ),
    );
    return;
  }
  if (config.nodeEnv === "production") {
    adminAuth(req, res, next);
    return;
  }
  next();
};

router.use("/outbox", outboxGuard);

router.get(
  "/outbox",
  asyncHandler(async (_req, res) => {
    await renderPage(res, "outbox", {
      title: "Outbox",
      head: ADMIN_HEAD,
      emails: listOutbox(OUTBOX_LIMIT),
      email: null,
      links: [],
      limit: OUTBOX_LIMIT,
      formatStamp,
    });
  }),
);

router.get(
  "/outbox/:id",
  asyncHandler(async (req, res) => {
    const email = getOutboxEmail(String(req.params.id));
    if (!email) throw new HttpError(404, "We couldn't find that email in the outbox.", "not_found");
    await renderPage(res, "outbox", {
      title: `Outbox: ${email.subject}`,
      head: ADMIN_HEAD,
      emails: listOutbox(OUTBOX_LIMIT),
      email,
      links: extractHttpLinks(email.html),
      limit: OUTBOX_LIMIT,
      formatStamp,
    });
  }),
);

router.get(
  "/outbox/:id/raw",
  asyncHandler(async (req, res) => {
    const email = getOutboxEmail(String(req.params.id));
    if (!email) throw new HttpError(404, "We couldn't find that email in the outbox.", "not_found");
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src data:");
    res.setHeader("X-Robots-Tag", "noindex");
    res.type("html").send(email.html);
  }),
);
