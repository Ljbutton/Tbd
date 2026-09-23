// Email templates (spec section 12): plain HTML, one accent color, no images.
// Every template returns {subject, html}; all dynamic values are escaped here
// because these strings never pass through EJS. The wording follows the
// honesty rules from spec section 1: the emails describe what was tested and
// never promise a legal outcome. The DISCLAIMER constant below is the only
// sentence allowed to name the thing this product is not.

import { findingsForAudit } from "../audits.js";
import { config } from "../config.js";
import { getRule } from "../narrative/rules.js";
import type { AuditRow, CreditCodeRow, Finding, Narrative, OrderRow } from "../types.js";
import { escapeHtml } from "../util/http.js";

export interface EmailContent {
  subject: string;
  html: string;
}

export const SUBJECTS = {
  reportReady: "Your accessibility audit is ready",
  inReview: "We're reviewing your audit by hand",
  creditCode: "Your Agency 5-Pack code",
  rescanReminder: "Your free re-scan expires in 5 days",
} as const;

/** Days after purchase during which the free re-scan can be used (spec 6.5). */
export const RESCAN_WINDOW_DAYS = 30;

export const DISCLAIMER =
  "Automated checks find roughly 30-40% of WCAG issues. This is an automated audit plus a manual checklist, not a legal opinion or a compliance certification.";

export const TESTIMONIAL_ASK = "Reply with one sentence about what you thought and we'll feature it.";

const ACCENT = "#1d4ed8";
const TEXT = "#1f2937";
const MUTED = "#4b5563";
const BORDER = "#e5e7eb";
const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function baseUrl(): string {
  return config.baseUrl.replace(/\/$/, "");
}

/** Public report page for an audit. */
export function reportUrl(audit: Pick<AuditRow, "token">): string {
  return `${baseUrl()}/r/${encodeURIComponent(audit.token)}`;
}

/** Credits page for an Agency 5-Pack code. */
export function creditsUrl(code: Pick<CreditCodeRow, "code">): string {
  return `${baseUrl()}/credits/${encodeURIComponent(code.code)}`;
}

function parseDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** The last day the free re-scan can be started: created_at plus 30 days. */
export function rescanDeadline(audit: Pick<AuditRow, "created_at">): Date {
  const created = parseDate(audit.created_at) ?? new Date();
  return new Date(created.getTime() + RESCAN_WINDOW_DAYS * 24 * 60 * 60 * 1000);
}

/** "October 23, 2026" (UTC). */
export function formatLongDate(date: Date): string {
  return date.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function parseNarrative(json: string | null): Narrative | null {
  if (!json) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as { findings?: unknown }).findings)) {
      return null;
    }
    return parsed as Narrative;
  } catch {
    return null;
  }
}

function safeFindings(audit: Pick<AuditRow, "id">): Finding[] {
  try {
    return findingsForAudit(audit.id);
  } catch {
    return [];
  }
}

/**
 * Titles of the top three findings: from the saved narrative when there is
 * one (its entries are in rank order and may have been edited by hand),
 * otherwise from the findings via the rule dictionary.
 */
export function topFindingTitles(audit: Pick<AuditRow, "id" | "narrative_json">, findings?: Finding[], limit = 3): string[] {
  const ranked = [...(findings ?? safeFindings(audit))].sort((a, b) => a.rank - b.rank);
  const narrative = parseNarrative(audit.narrative_json);
  const titles: string[] = [];
  if (narrative) {
    const byRule = new Map<string, string>();
    for (const entry of narrative.findings) {
      if (entry && typeof entry.ruleId === "string" && typeof entry.title === "string" && entry.title.trim() !== "") {
        if (!byRule.has(entry.ruleId)) byRule.set(entry.ruleId, entry.title.trim());
      }
    }
    const source = ranked.length > 0 ? ranked.map((f) => f.ruleId) : [...byRule.keys()];
    for (const ruleId of source) {
      const title = byRule.get(ruleId);
      if (title && !titles.includes(title)) titles.push(title);
      if (titles.length >= limit) return titles;
    }
  }
  for (const finding of ranked) {
    const title = getRule(finding.ruleId, { help: finding.help, helpUrl: finding.helpUrl }).title;
    if (!titles.includes(title)) titles.push(title);
    if (titles.length >= limit) break;
  }
  return titles.slice(0, limit);
}

function button(href: string, label: string): string {
  return (
    `<p style="margin:24px 0;">` +
    `<a href="${escapeHtml(href)}" style="display:inline-block;background:${ACCENT};color:#ffffff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:6px;">${escapeHtml(label)}</a>` +
    `</p>`
  );
}

function linkLine(href: string): string {
  return `<p style="margin:0 0 16px;font-size:14px;color:${MUTED};word-break:break-all;">Or copy this link: <a href="${escapeHtml(href)}" style="color:${ACCENT};">${escapeHtml(href)}</a></p>`;
}

function paragraph(text: string): string {
  return `<p style="margin:0 0 16px;">${escapeHtml(text)}</p>`;
}

function list(items: string[]): string {
  if (items.length === 0) return "";
  return `<ol style="margin:0 0 16px;padding-left:22px;">${items.map((item) => `<li style="margin:0 0 6px;">${escapeHtml(item)}</li>`).join("")}</ol>`;
}

/** Wraps body HTML in the shared shell: brand line, heading, body, footer with the disclaimer. */
export function emailLayout(title: string, bodyHtml: string, options: { preheader?: string } = {}): string {
  const preheader = options.preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(options.preheader)}</div>`
    : "";
  return (
    `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n` +
    `<title>${escapeHtml(title)}</title>\n</head>\n` +
    `<body style="margin:0;padding:0;background:#f3f4f6;font-family:${FONT};font-size:16px;line-height:1.6;color:${TEXT};">\n` +
    preheader +
    `<div style="max-width:600px;margin:0 auto;padding:24px 16px;">\n` +
    `<div style="background:#ffffff;border:1px solid ${BORDER};border-radius:10px;padding:28px 28px 20px;">\n` +
    `<p style="margin:0 0 20px;font-weight:800;font-size:18px;color:${ACCENT};">AccessAudit</p>\n` +
    `<h1 style="margin:0 0 16px;font-size:24px;line-height:1.25;color:${TEXT};">${escapeHtml(title)}</h1>\n` +
    bodyHtml +
    `\n</div>\n` +
    `<div style="padding:20px 8px 0;font-size:13px;line-height:1.5;color:${MUTED};">\n` +
    `<p style="margin:0 0 8px;">${escapeHtml(DISCLAIMER)}</p>\n` +
    `<p style="margin:0;">AccessAudit is an automated testing tool. It is not a law firm and does not provide legal advice. ` +
    `Questions? Reply to this email.</p>\n` +
    `</div>\n</div>\n</body>\n</html>\n`
  );
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

/**
 * Sent when an audit becomes ready (or is released after a human review).
 * `findings` is optional: when omitted the audit's stored findings are used.
 */
export function reportReady(audit: AuditRow, findings?: Finding[]): EmailContent {
  const url = reportUrl(audit);
  const host = hostnameOf(audit.url);
  const titles = topFindingTitles(audit, findings);
  const isRescan = audit.rescan_of !== null && audit.rescan_of !== "";
  const whiteLabel = Boolean(audit.white_label);
  const agency = (audit.agency_name ?? "").trim();
  const deadline = formatLongDate(rescanDeadline(audit));

  const intro = isRescan
    ? `Your free re-scan of ${host} has finished. The report now includes a before/after comparison with your original audit and a dated remediation record.`
    : whiteLabel
      ? `The white-label accessibility audit of ${host}${agency ? ` for ${agency}` : ""} has finished. The report page has the PDF with your branding, plus JSON and CSV exports.`
      : `We scanned ${host} at desktop and mobile sizes. Your report page has the PDF, JSON and CSV exports, and a dated remediation record.`;

  const priorities =
    titles.length > 0
      ? `<p style="margin:0 0 8px;font-weight:700;">Top ${titles.length === 1 ? "priority" : "priorities"}:</p>${list(titles)}`
      : paragraph("The automated checks found no issues on the pages we scanned. The manual checks in the report cover what automation cannot see.");

  const rescanLine = isRescan
    ? paragraph("This was the free re-scan included with your audit, so no further re-scan is attached to this report.")
    : paragraph(`One free re-scan is included. Run it from the report page once your fixes are live, any time until ${deadline}, to get a before/after record.`);

  const body =
    paragraph(intro) +
    button(url, "Open your report") +
    linkLine(url) +
    priorities +
    rescanLine +
    (whiteLabel ? "" : paragraph(TESTIMONIAL_ASK));

  return {
    subject: SUBJECTS.reportReady,
    html: emailLayout(SUBJECTS.reportReady, body, { preheader: `${host}: your report is ready to open.` }),
  };
}

/** Sent when a Reviewed Audit finishes its automated pass and is held for a human check. */
export function inReview(audit: AuditRow): EmailContent {
  const url = reportUrl(audit);
  const host = hostnameOf(audit.url);
  const body =
    paragraph(
      `The automated scan of ${host} has finished. Because you ordered a Reviewed Audit, a person now runs keyboard, focus-order and screen-reader spot checks on your site and edits the write-up by hand.`,
    ) +
    paragraph("You'll get another email within 2 business days when the finished report is released.") +
    paragraph("In the meantime your report page shows the automated findings as a preview:") +
    button(url, "See the preview") +
    linkLine(url);
  return {
    subject: SUBJECTS.inReview,
    html: emailLayout(SUBJECTS.inReview, body, { preheader: `${host}: a person is checking your site by hand.` }),
  };
}

/** Sent when an Agency 5-Pack is paid: the code, the link and how to redeem it. */
export function creditCode(code: CreditCodeRow, order: OrderRow): EmailContent {
  const url = creditsUrl(code);
  const agency = (code.agency_name ?? order.agency_name ?? "").trim();
  const body =
    paragraph(
      `Thanks for your order${agency ? `, ${agency}` : ""}. Your Agency 5-Pack comes with ${code.credits_total} audit credits. Each credit is one white-label audit of up to ${config.pageLimitPack} pages at desktop and mobile sizes, with a free re-scan.`,
    ) +
    `<p style="margin:0 0 8px;font-weight:700;">Your code</p>` +
    `<p style="margin:0 0 20px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:26px;letter-spacing:0.08em;color:${TEXT};">${escapeHtml(code.code)}</p>` +
    button(url, "Start your first audit") +
    linkLine(url) +
    `<p style="margin:0 0 8px;font-weight:700;">How to redeem a credit</p>` +
    list([
      "Open the link above (or share it with your team; anyone with it can use a credit).",
      "Paste the client's website address and the email that should receive the report.",
      `Click "Start audit (uses 1 credit)". The report is usually ready in 5-10 minutes${agency ? ` with ${agency}'s name${code.agency_logo_path ? " and logo" : ""} on the cover` : ""}.`,
    ]) +
    paragraph(`${code.credits_left} of ${code.credits_total} credits are unused right now. The credits page always shows the current count.`);
  return {
    subject: SUBJECTS.creditCode,
    html: emailLayout(SUBJECTS.creditCode, body, { preheader: `Code ${code.code}: ${code.credits_total} white-label audits.` }),
  };
}

/** Sent 25 days after purchase to audits whose free re-scan is still unused. */
export function rescanReminder(audit: AuditRow): EmailContent {
  const url = reportUrl(audit);
  const host = hostnameOf(audit.url);
  const deadline = formatLongDate(rescanDeadline(audit));
  const body =
    paragraph(
      `Your audit of ${host} includes one free re-scan, and it can be used until ${deadline}. After that the re-scan button on your report page closes.`,
    ) +
    paragraph(
      "If your fixes are live, run the re-scan now: you get a before/after comparison and a dated remediation record showing what changed.",
    ) +
    button(url, "Run the free re-scan") +
    linkLine(url) +
    paragraph("Not ready yet? That's fine. The original report stays available on the same page.");
  return {
    subject: SUBJECTS.rescanReminder,
    html: emailLayout(SUBJECTS.rescanReminder, body, { preheader: `Use the free re-scan of ${host} before ${deadline}.` }),
  };
}
