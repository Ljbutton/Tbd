// Shared audit repository: every module that reads or writes the audits,
// pages or findings tables goes through these functions.

import { db, nowIso } from "./db.js";
import { findingToRow, rowToFinding } from "./report/finding-rows.js";
import type { AuditRow, AuditStatus, Finding, FindingRow, PageRow, PageScan, Tier } from "./types.js";
import { newId, newToken } from "./util/ids.js";

export interface CreateAuditInput {
  email: string;
  url: string;
  origin: string;
  page_limit: number;
  white_label: boolean | number;
  agency_name?: string | null;
  agency_logo_path?: string | null;
  tier: Tier;
  order_id?: string | null;
  credit_code_id?: string | null;
  rescan_of?: string | null;
}

const insertAuditStmt = db.prepare(`
  INSERT INTO audits (id, token, order_id, credit_code_id, email, url, origin, page_limit, white_label,
    agency_name, agency_logo_path, tier, status, created_at, rescan_of)
  VALUES (@id, @token, @order_id, @credit_code_id, @email, @url, @origin, @page_limit, @white_label,
    @agency_name, @agency_logo_path, @tier, 'queued', @created_at, @rescan_of)
`);
const getAuditStmt = db.prepare("SELECT * FROM audits WHERE id = ?");
const getAuditByTokenStmt = db.prepare("SELECT * FROM audits WHERE token = ?");
const listAuditsStmt = db.prepare("SELECT * FROM audits ORDER BY created_at DESC LIMIT ?");
const appendLogStmt = db.prepare("UPDATE audits SET log = log || ? WHERE id = ?");
const findingsStmt = db.prepare("SELECT * FROM findings WHERE audit_id = ? ORDER BY rank ASC");
const pagesStmt = db.prepare("SELECT * FROM pages WHERE audit_id = ? ORDER BY rowid ASC");
const insertPageStmt = db.prepare(`
  INSERT INTO pages (id, audit_id, url, viewport, status_code, title, violations_json, incomplete_json,
    violation_count, scanned_at, error)
  VALUES (@id, @audit_id, @url, @viewport, @status_code, @title, @violations_json, @incomplete_json,
    @violation_count, @scanned_at, @error)
`);
const insertFindingStmt = db.prepare(`
  INSERT INTO findings (id, audit_id, rank, rule_id, impact, category, wcag_tags, pages_affected, nodes_total,
    litigation_weight, score, confidence, example_page_url, example_selector, example_html, screenshot_path,
    help, help_url, affected_urls)
  VALUES (@id, @audit_id, @rank, @rule_id, @impact, @category, @wcag_tags, @pages_affected, @nodes_total,
    @litigation_weight, @score, @confidence, @example_page_url, @example_selector, @example_html, @screenshot_path,
    @help, @help_url, @affected_urls)
`);
const deletePagesStmt = db.prepare("DELETE FROM pages WHERE audit_id = ?");
const deleteFindingsStmt = db.prepare("DELETE FROM findings WHERE audit_id = ?");
const resetProgressStmt = db.prepare(
  "UPDATE audits SET progress_pages = 0, progress_issues = 0, progress_note = NULL, error = NULL WHERE id = ?",
);

/** Inserts a queued audit with a fresh id and report token; returns the stored row. */
export function createAudit(input: CreateAuditInput): AuditRow {
  const id = newId();
  insertAuditStmt.run({
    id,
    token: newToken(),
    order_id: input.order_id ?? null,
    credit_code_id: input.credit_code_id ?? null,
    email: input.email,
    url: input.url,
    origin: input.origin,
    page_limit: input.page_limit,
    white_label: input.white_label ? 1 : 0,
    agency_name: input.agency_name ?? null,
    agency_logo_path: input.agency_logo_path ?? null,
    tier: input.tier,
    created_at: nowIso(),
    rescan_of: input.rescan_of ?? null,
  });
  const row = getAudit(id);
  if (!row) throw new Error("audit insert did not persist");
  return row;
}

export function getAudit(id: string): AuditRow | null {
  return (getAuditStmt.get(id) as AuditRow | undefined) ?? null;
}

export function getAuditByToken(token: string): AuditRow | null {
  if (!token) return null;
  return (getAuditByTokenStmt.get(token) as AuditRow | undefined) ?? null;
}

export function listAudits(limit = 100): AuditRow[] {
  return listAuditsStmt.all(Math.max(1, Math.floor(limit))) as AuditRow[];
}

/** Columns updateAudit() may touch; the primary key is never updatable. */
const UPDATABLE_COLUMNS: ReadonlySet<keyof AuditRow> = new Set<keyof AuditRow>([
  "token",
  "order_id",
  "credit_code_id",
  "email",
  "url",
  "origin",
  "page_limit",
  "white_label",
  "agency_name",
  "agency_logo_path",
  "tier",
  "status",
  "progress_pages",
  "progress_issues",
  "progress_note",
  "error",
  "log",
  "narrative_json",
  "summary_json",
  "pdf_path",
  "json_path",
  "csv_path",
  "rescan_of",
  "rescan_used",
  "reminder_sent",
  "created_at",
  "started_at",
  "finished_at",
  "released_at",
]);

/** Updates the given columns (unknown keys are ignored) and returns the fresh row. */
export function updateAudit(id: string, patch: Partial<AuditRow>): AuditRow | null {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (!UPDATABLE_COLUMNS.has(key as keyof AuditRow) || value === undefined) continue;
    sets.push(`${key} = ?`);
    values.push(typeof value === "boolean" ? (value ? 1 : 0) : value);
  }
  if (sets.length > 0) {
    values.push(id);
    db.prepare(`UPDATE audits SET ${sets.join(", ")} WHERE id = ?`).run(...values);
  }
  return getAudit(id);
}

function clock(): string {
  return new Date().toISOString().slice(11, 19);
}

/** Appends "[HH:MM:SS] line\n" (UTC clock) to the audit's log column. */
export function appendAuditLog(id: string, line: string): void {
  appendLogStmt.run(`[${clock()}] ${line}\n`, id);
}

export interface ProgressPatch {
  status?: AuditStatus;
  progress_pages?: number;
  progress_issues?: number;
  progress_note?: string | null;
}

export function setProgress(id: string, patch: ProgressPatch): void {
  updateAudit(id, patch);
}

export function findingsForAudit(auditId: string): Finding[] {
  return (findingsStmt.all(auditId) as FindingRow[]).map(rowToFinding);
}

export function pagesForAudit(auditId: string): PageRow[] {
  return pagesStmt.all(auditId) as PageRow[];
}

function countNodes(scan: PageScan): number {
  return scan.violations.reduce((sum, v) => sum + v.nodes.length, 0);
}

/** Stores one pages row per PageScan (one per url+viewport). */
export const insertPages = db.transaction((auditId: string, scans: PageScan[]): void => {
  const scannedAt = nowIso();
  for (const scan of scans) {
    insertPageStmt.run({
      id: newId(),
      audit_id: auditId,
      url: scan.url,
      viewport: scan.viewport,
      status_code: scan.statusCode,
      title: scan.title || null,
      violations_json: JSON.stringify(scan.violations),
      incomplete_json: JSON.stringify(scan.incomplete),
      violation_count: countNodes(scan),
      scanned_at: scannedAt,
      error: scan.error ?? null,
    });
  }
});

/** Stores ranked findings for an audit. */
export const insertFindings = db.transaction((auditId: string, findings: Finding[]): void => {
  for (const finding of findings) {
    insertFindingStmt.run(findingToRow(auditId, finding));
  }
});

/** Deletes pages and findings for the audit and resets progress counters/note/error (status untouched). */
export const clearAuditResults = db.transaction((auditId: string): void => {
  deletePagesStmt.run(auditId);
  deleteFindingsStmt.run(auditId);
  resetProgressStmt.run(auditId);
});
