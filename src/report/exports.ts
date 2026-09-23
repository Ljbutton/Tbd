// Machine-readable and copy-friendly exports of a finished audit (spec 10.1):
// JSON for integrations, CSV for ticket trackers, an issue table fragment for
// copy-as-HTML, and the printable remediation record.

import { getRule } from "../narrative/rules.js";
import type { AuditRow, AuditSummary, Delta, Finding, FindingNarrative, Impact, Narrative, Viewport } from "../types.js";
import { escapeHtml } from "../util/http.js";
import {
  IMPACT_LABELS,
  VIEWPORT_LABELS,
  confidenceLabel,
  effortLabel,
  formatDateTime,
  formatNumber,
  hostnameOf,
  impactLabel,
  narrativeFor,
  safeHttpUrl,
  sortByRank,
  toolVersions,
} from "./render.js";

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

export interface ReportJsonFinding extends Finding {
  narrative: FindingNarrative;
}

export interface ReportJson {
  version: 1;
  reportId: string;
  url: string;
  generatedAt: string;
  summary: AuditSummary;
  findings: ReportJsonFinding[];
  manualChecks: { title: string; how: string }[];
  delta: Delta | null;
}

export function toJson(
  audit: AuditRow,
  summary: AuditSummary,
  findings: Finding[],
  narrative: Narrative,
  delta?: Delta | null,
): ReportJson {
  return {
    version: 1,
    reportId: audit.id,
    url: audit.url,
    generatedAt: new Date().toISOString(),
    summary,
    findings: sortByRank(findings).map((finding) => ({ ...finding, narrative: narrativeFor(finding, narrative) })),
    manualChecks: narrative.manualChecks.map((check) => ({ title: check.title, how: check.how })),
    delta: delta ?? null,
  };
}

// ---------------------------------------------------------------------------
// CSV (RFC 4180)
// ---------------------------------------------------------------------------

export const CSV_HEADER = [
  "rank",
  "rule_id",
  "title",
  "impact",
  "confidence",
  "category",
  "wcag_tags",
  "pages_affected",
  "elements",
  "effort",
  "example_page",
  "example_selector",
  "help_url",
] as const;

/** Separator used inside the wcag_tags field (a list within one CSV field). */
export const CSV_LIST_SEPARATOR = "|";

/**
 * Quotes one field per RFC 4180: fields containing a comma, a double quote,
 * CR or LF are wrapped in double quotes with embedded quotes doubled. Values
 * that a spreadsheet would treat as a formula (=, +, @, tab) get a leading
 * apostrophe so pasted markup can never execute.
 */
export function csvField(value: unknown): string {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[=+@\t]/.test(text)) text = `'${text}`;
  if (/[",\r\n]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function toCsv(findings: Finding[], narrative: Narrative): string {
  const lines: string[] = [CSV_HEADER.join(",")];
  for (const finding of sortByRank(findings)) {
    const text = narrativeFor(finding, narrative);
    lines.push(
      [
        finding.rank,
        finding.ruleId,
        text.title,
        finding.impact,
        finding.confidence,
        finding.category,
        finding.wcagTags.join(CSV_LIST_SEPARATOR),
        finding.pagesAffected,
        finding.nodesTotal,
        text.effort,
        finding.examplePageUrl ?? "",
        finding.exampleSelector ?? "",
        finding.helpUrl,
      ]
        .map(csvField)
        .join(","),
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}

// ---------------------------------------------------------------------------
// Issue table fragment (copy as HTML, GET /r/:token/html)
// ---------------------------------------------------------------------------

const TABLE_STYLE = "border-collapse:collapse;width:100%;font-family:system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;font-size:14px;color:#1f2937";
const TH_STYLE = "text-align:left;padding:6px 8px;border:1px solid #d1d5db;background:#f3f4f6;font-weight:700";
const TD_STYLE = "text-align:left;padding:6px 8px;border:1px solid #d1d5db;vertical-align:top";
const TD_NUM_STYLE = `${TD_STYLE};text-align:right`;

/**
 * A standalone, fully escaped <table> of the ranked issues, with inline
 * styles so it survives pasting into email clients, wikis and ticket trackers.
 */
export function toIssueTableHtml(findings: Finding[], narrative: Narrative): string {
  const rows = sortByRank(findings).map((finding) => {
    const text = narrativeFor(finding, narrative);
    const title = escapeHtml(text.title.trim() || finding.help || finding.ruleId);
    const helpUrl = safeHttpUrl(finding.helpUrl);
    const reference = helpUrl ? `<a href="${escapeHtml(helpUrl)}">Rule reference</a>` : "";
    return (
      `<tr>` +
      `<td style="${TD_NUM_STYLE}">${finding.rank}</td>` +
      `<td style="${TD_STYLE}">${title}<br><code>${escapeHtml(finding.ruleId)}</code></td>` +
      `<td style="${TD_STYLE}">${escapeHtml(impactLabel(finding.impact))}</td>` +
      `<td style="${TD_STYLE}">${escapeHtml(confidenceLabel(finding.confidence))}</td>` +
      `<td style="${TD_NUM_STYLE}">${formatNumber(finding.pagesAffected)}</td>` +
      `<td style="${TD_NUM_STYLE}">${formatNumber(finding.nodesTotal)}</td>` +
      `<td style="${TD_STYLE}">${escapeHtml(effortLabel(text.effort))}</td>` +
      `<td style="${TD_STYLE}">${reference}</td>` +
      `</tr>`
    );
  });
  const header = ["#", "Issue", "Impact", "Confidence", "Pages", "Elements", "Effort", "Reference"]
    .map((label) => `<th scope="col" style="${TH_STYLE}">${escapeHtml(label)}</th>`)
    .join("");
  const body =
    rows.length > 0
      ? rows.join("\n")
      : `<tr><td colspan="8" style="${TD_STYLE}">The automated checks found no issues.</td></tr>`;
  return (
    `<table class="issue-table" style="${TABLE_STYLE}">\n` +
    `<caption style="text-align:left;font-weight:700;padding:6px 0">Accessibility issues ranked by priority</caption>\n` +
    `<thead><tr>${header}</tr></thead>\n` +
    `<tbody>\n${body}\n</tbody>\n` +
    `</table>`
  );
}

// ---------------------------------------------------------------------------
// Remediation record (GET /r/:token/record)
// ---------------------------------------------------------------------------

export const REMEDIATION_RECORD_TITLE = "Accessibility Remediation Record";

/** The record's closing statement from spec 10.1, reproduced verbatim. */
export const REMEDIATION_RECORD_STATEMENT =
  "This record documents automated testing performed on the dates above. It is not a legal opinion or a statement of compliance.";

const IMPACTS: readonly Impact[] = ["critical", "serious", "moderate", "minor"];

const RECORD_CSS = `
  body { margin: 0; padding: 32px 24px; font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; font-size: 11pt; line-height: 1.5; color: #1f2937; background: #fff; }
  main { max-width: 800px; margin: 0 auto; }
  h1 { font-size: 24pt; line-height: 1.2; margin: 0 0 0.25em; letter-spacing: -0.01em; }
  h2 { font-size: 14pt; margin: 1.6em 0 0.5em; padding-bottom: 0.25em; border-bottom: 2px solid #e5e7eb; break-after: avoid; }
  p { margin: 0 0 0.8em; }
  .subtitle { color: #4b5563; font-size: 13pt; margin-bottom: 1.5em; overflow-wrap: anywhere; }
  .eyebrow { text-transform: uppercase; letter-spacing: 0.12em; font-weight: 700; color: #1d4ed8; font-size: 9.5pt; margin-bottom: 0.4em; }
  table { width: 100%; border-collapse: collapse; margin: 0 0 1.2em; font-size: 10pt; }
  th, td { text-align: left; vertical-align: top; padding: 0.45em 0.6em; border-bottom: 1px solid #e5e7eb; }
  thead th { background: #f3f4f6; border-bottom: 2px solid #d1d5db; }
  tbody th { width: 34%; font-weight: 700; color: #4b5563; }
  tr { break-inside: avoid; }
  .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .url { overflow-wrap: anywhere; word-break: break-all; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.9em; overflow-wrap: anywhere; }
  .statement { border: 1px solid #f59e0b; border-left-width: 5px; border-radius: 6px; background: #fffbeb; color: #78350f; padding: 0.8em 1em; margin: 1.5em 0; font-weight: 500; break-inside: avoid; }
  .footer { color: #4b5563; font-size: 9.5pt; margin-top: 2em; padding-top: 0.8em; border-top: 1px solid #e5e7eb; }
  @page { size: Letter; margin: 18mm 16mm; }
  @media print { body { padding: 0; } }
`;

function recordRow(label: string, valueHtml: string): string {
  return `<tr><th scope="row">${escapeHtml(label)}</th><td>${valueHtml}</td></tr>`;
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${formatNumber(count)} ${count === 1 ? singular : pluralForm}`;
}

/**
 * Printable HTML record of what was tested and when, for the buyer's own
 * files: site, report id, scan window (UTC), tool versions, pages scanned,
 * issues by impact and, after a re-scan, what changed.
 */
export function toRemediationRecord(audit: AuditRow, summary: AuditSummary, findings: Finding[], delta?: Delta | null): string {
  const ranked = sortByRank(findings);
  const versions = toolVersions();
  const whiteLabel = Boolean(audit.white_label);
  const agencyName = (audit.agency_name ?? "").trim();
  const viewportList: Viewport[] =
    summary.viewports && summary.viewports.length > 0 ? summary.viewports : ["desktop", "mobile"];
  const viewports = viewportList.map((viewport) => VIEWPORT_LABELS[viewport] ?? viewport);
  const tools = [
    ...(whiteLabel ? [] : [`AccessAudit ${versions.accessAudit}`]),
    `axe-core ${versions.axeCore}`,
    `Playwright ${versions.playwright} (headless Chromium)`,
  ];
  const preparedBy = whiteLabel && agencyName ? agencyName : whiteLabel ? "Automated audit" : "AccessAudit (automated audit)";

  const byImpactRows = IMPACTS.map(
    (impact) =>
      `<tr><td>${escapeHtml(IMPACT_LABELS[impact])}</td><td class="num">${formatNumber(summary.byImpact?.[impact] ?? 0)}</td></tr>`,
  ).join("\n");
  const automated = summary.byConfidence?.automated ?? 0;
  const needsManual = summary.byConfidence?.needs_manual ?? 0;

  const findingRows =
    ranked.length > 0
      ? ranked
          .map((finding) => {
            const title = getRule(finding.ruleId, { help: finding.help, helpUrl: finding.helpUrl }).title;
            return (
              `<tr><td class="num">${finding.rank}</td>` +
              `<td>${escapeHtml(title)}<br><code>${escapeHtml(finding.ruleId)}</code></td>` +
              `<td>${escapeHtml(impactLabel(finding.impact))}</td>` +
              `<td>${escapeHtml(confidenceLabel(finding.confidence))}</td>` +
              `<td class="num">${formatNumber(finding.pagesAffected)}</td>` +
              `<td class="num">${formatNumber(finding.nodesTotal)}</td></tr>`
            );
          })
          .join("\n")
      : `<tr><td colspan="6">The automated checks found no issues on the pages scanned.</td></tr>`;

  let deltaSection = "";
  if (delta) {
    const fixedList =
      delta.fixed.length > 0
        ? `<ul>${delta.fixed.map((entry) => `<li>${escapeHtml(entry.title || entry.ruleId)} <code>${escapeHtml(entry.ruleId)}</code> (${plural(entry.before, "element")})</li>`).join("")}</ul>`
        : "<p>No issue types were fully fixed between the two scans.</p>";
    deltaSection =
      `<h2>Re-scan</h2>\n<table>\n<tbody>\n` +
      recordRow("Original audit", `<code>${escapeHtml(delta.originalAuditId)}</code>`) +
      recordRow("Original scan date", escapeHtml(formatDateTime(delta.originalDate))) +
      recordRow("Re-scan date", escapeHtml(formatDateTime(delta.rescanDate))) +
      recordRow("Issues fixed", escapeHtml(plural(delta.fixed.length, "issue type")) + ` (no longer detected)`) +
      recordRow("Issues remaining", escapeHtml(plural(delta.unchanged.length, "issue type")) + ` (still detected)`) +
      recordRow("New issues", escapeHtml(plural(delta.newIssues.length, "issue type"))) +
      recordRow("Elements affected", `${formatNumber(delta.nodesBefore)} before, ${formatNumber(delta.nodesAfter)} after`) +
      recordRow("Percent fixed", `${formatNumber(delta.percentFixed)}% of affected elements`) +
      `</tbody>\n</table>\n<h2>Issue types no longer detected</h2>\n${fixedList}\n`;
  }

  return (
    `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n` +
    `<title>${escapeHtml(REMEDIATION_RECORD_TITLE)} - ${escapeHtml(hostnameOf(audit.url))}</title>\n<style>${RECORD_CSS}</style>\n</head>\n<body>\n<main>\n` +
    `<p class="eyebrow">Automated testing record</p>\n` +
    `<h1>${escapeHtml(REMEDIATION_RECORD_TITLE)}</h1>\n` +
    `<p class="subtitle url">${escapeHtml(audit.url)}</p>\n` +
    `<h2>Record details</h2>\n<table>\n<tbody>\n` +
    recordRow("Website", `<span class="url">${escapeHtml(audit.url)}</span>`) +
    recordRow("Report ID", `<code>${escapeHtml(audit.id)}</code>`) +
    recordRow("Scan started (UTC)", escapeHtml(formatDateTime(summary.scanStartedAt) || "unknown")) +
    recordRow("Scan finished (UTC)", escapeHtml(formatDateTime(summary.scanFinishedAt) || "unknown")) +
    recordRow("Tool versions", escapeHtml(tools.join("; "))) +
    recordRow("Rule sets", "WCAG 2.0, 2.1 and 2.2 levels A and AA (automated checks)") +
    recordRow("Viewports", escapeHtml(viewports.join("; "))) +
    recordRow(
      "Pages scanned",
      escapeHtml(
        `${formatNumber(summary.pagesScanned)} of ${formatNumber(summary.pagesRequested)} requested` +
          (summary.pagesFailed > 0 ? ` (${plural(summary.pagesFailed, "page")} could not be loaded)` : ""),
      ),
    ) +
    recordRow("Prepared by", escapeHtml(preparedBy)) +
    `</tbody>\n</table>\n` +
    `<h2>Issues found</h2>\n<table>\n<thead><tr><th scope="col">Impact</th><th scope="col" class="num">Issue types</th></tr></thead>\n<tbody>\n${byImpactRows}\n` +
    `<tr><td><strong>Total</strong></td><td class="num"><strong>${formatNumber(summary.findingsCount)}</strong></td></tr>\n</tbody>\n</table>\n` +
    `<p>${escapeHtml(plural(summary.totalViolationNodes, "element"))} affected across the pages scanned; ` +
    `${escapeHtml(plural(automated, "issue type"))} confirmed automatically and ${escapeHtml(plural(needsManual, "issue type"))} flagged for manual checking.</p>\n` +
    deltaSection +
    `<h2>Findings</h2>\n<table>\n<thead><tr><th scope="col" class="num">#</th><th scope="col">Issue</th><th scope="col">Impact</th><th scope="col">Confidence</th><th scope="col" class="num">Pages</th><th scope="col" class="num">Elements</th></tr></thead>\n` +
    `<tbody>\n${findingRows}\n</tbody>\n</table>\n` +
    `<div class="statement" role="note"><p>${escapeHtml(REMEDIATION_RECORD_STATEMENT)}</p></div>\n` +
    `<p class="footer">Record generated ${escapeHtml(formatDateTime(new Date().toISOString()))}.</p>\n` +
    `</main>\n</body>\n</html>\n`
  );
}
