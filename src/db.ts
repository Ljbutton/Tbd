// SQLite access. This is the only module that imports the database driver.
// `db` is opened at import (openDb() is idempotent). The schema is applied
// once at the bottom of this module so that modules which prepare statements
// at import time (per the spec, each module owns its prepared statements)
// never race the boot sequence; server.ts and tests still call migrate()
// explicitly, which is a cheap no-op on an up-to-date database.

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { config } from "./config.js";

export type Db = Database.Database;

let instance: Db | null = null;

/** Opens `${dataDir}/app.db` with the required pragmas. Returns the same instance on every call. */
export function openDb(): Db {
  if (instance) return instance;
  fs.mkdirSync(config.dataDir, { recursive: true });
  const file = path.join(config.dataDir, "app.db");
  const opened = new Database(file);
  opened.pragma("journal_mode = WAL");
  opened.pragma("foreign_keys = ON");
  opened.pragma("busy_timeout = 5000");
  instance = opened;
  return opened;
}

export const db: Db = openDb();

/** Current time as an ISO-8601 UTC string (the format every timestamp column uses). */
export function nowIso(): string {
  return new Date().toISOString();
}

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY, created_at TEXT NOT NULL, email TEXT NOT NULL,
  product TEXT NOT NULL CHECK(product IN ('single','reviewed','pack5')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','paid','refunded')),
  amount_cents INTEGER NOT NULL, currency TEXT NOT NULL DEFAULT 'usd',
  stripe_session_id TEXT, stripe_payment_intent TEXT, paid_via TEXT, paid_at TEXT,
  url TEXT, agency_name TEXT, agency_logo_path TEXT, coupon TEXT, ip TEXT);
CREATE TABLE IF NOT EXISTS credit_codes (
  id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, order_id TEXT NOT NULL REFERENCES orders(id),
  credits_total INTEGER NOT NULL, credits_left INTEGER NOT NULL,
  agency_name TEXT, agency_logo_path TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audits (
  id TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE, order_id TEXT REFERENCES orders(id),
  credit_code_id TEXT REFERENCES credit_codes(id), email TEXT NOT NULL,
  url TEXT NOT NULL, origin TEXT NOT NULL, page_limit INTEGER NOT NULL,
  white_label INTEGER NOT NULL DEFAULT 0, agency_name TEXT, agency_logo_path TEXT,
  tier TEXT NOT NULL CHECK(tier IN ('single','reviewed','pack5')),
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','crawling','scanning','writing','rendering','held','ready','failed')),
  progress_pages INTEGER NOT NULL DEFAULT 0, progress_issues INTEGER NOT NULL DEFAULT 0, progress_note TEXT,
  error TEXT, log TEXT NOT NULL DEFAULT '', narrative_json TEXT, summary_json TEXT,
  pdf_path TEXT, json_path TEXT, csv_path TEXT,
  rescan_of TEXT REFERENCES audits(id), rescan_used INTEGER NOT NULL DEFAULT 0, reminder_sent INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, released_at TEXT);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, type TEXT NOT NULL DEFAULT 'audit', ref_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','done','failed')),
  attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, error TEXT);
CREATE TABLE IF NOT EXISTS pages (
  id TEXT PRIMARY KEY, audit_id TEXT NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
  url TEXT NOT NULL, viewport TEXT NOT NULL CHECK(viewport IN ('desktop','mobile')),
  status_code INTEGER, title TEXT, violations_json TEXT NOT NULL DEFAULT '[]', incomplete_json TEXT NOT NULL DEFAULT '[]',
  violation_count INTEGER NOT NULL DEFAULT 0, scanned_at TEXT NOT NULL, error TEXT);
CREATE TABLE IF NOT EXISTS findings (
  id TEXT PRIMARY KEY, audit_id TEXT NOT NULL REFERENCES audits(id) ON DELETE CASCADE, rank INTEGER NOT NULL,
  rule_id TEXT NOT NULL, impact TEXT NOT NULL, category TEXT NOT NULL, wcag_tags TEXT NOT NULL,
  pages_affected INTEGER NOT NULL, nodes_total INTEGER NOT NULL, litigation_weight INTEGER NOT NULL, score REAL NOT NULL,
  confidence TEXT NOT NULL CHECK(confidence IN ('automated','needs_manual')),
  example_page_url TEXT, example_selector TEXT, example_html TEXT, screenshot_path TEXT, help TEXT NOT NULL, help_url TEXT NOT NULL,
  affected_urls TEXT NOT NULL DEFAULT '[]');
CREATE TABLE IF NOT EXISTS teasers (id TEXT PRIMARY KEY, url_hash TEXT NOT NULL UNIQUE, url TEXT NOT NULL, result_json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS emails_outbox (id TEXT PRIMARY KEY, to_email TEXT NOT NULL, subject TEXT NOT NULL, html TEXT NOT NULL, sent_via TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, type TEXT NOT NULL, meta_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_audits_status ON audits(status);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_pages_audit ON pages(audit_id);
CREATE INDEX IF NOT EXISTS idx_findings_audit ON findings(audit_id, rank);
CREATE INDEX IF NOT EXISTS idx_orders_session ON orders(stripe_session_id);
`;

/** Every table the schema creates, in dependency order (used by tests and admin). */
export const TABLES = [
  "orders",
  "credit_codes",
  "audits",
  "jobs",
  "pages",
  "findings",
  "teasers",
  "emails_outbox",
  "events",
] as const;

/**
 * Creates all tables and indexes (idempotent). Also adds columns introduced
 * after an existing database was created, so upgrades need no manual steps.
 */
export function migrate(): void {
  const d = openDb();
  d.exec(SCHEMA_SQL);
  const findingColumns = d
    .prepare("PRAGMA table_info(findings)")
    .all()
    .map((row) => (row as { name: string }).name);
  if (!findingColumns.includes("affected_urls")) {
    d.exec("ALTER TABLE findings ADD COLUMN affected_urls TEXT NOT NULL DEFAULT '[]'");
  }
}

migrate();
