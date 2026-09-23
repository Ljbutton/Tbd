// Shared types: the contract between the scan, ranking, narrative, report,
// payments and route modules. Row interfaces mirror the SQLite schema in
// src/db.ts column for column (snake_case); domain types are camelCase.

export type Viewport = "desktop" | "mobile";
export type Impact = "critical" | "serious" | "moderate" | "minor";
export type Confidence = "automated" | "needs_manual";

export type Product = "single" | "reviewed" | "pack5";
export type Tier = Product;
export type OrderStatus = "pending" | "paid" | "refunded";
export type PaidVia = "mock" | "stripe" | "admin";
export type AuditStatus =
  | "queued"
  | "crawling"
  | "scanning"
  | "writing"
  | "rendering"
  | "held"
  | "ready"
  | "failed";
export type JobStatus = "queued" | "running" | "done" | "failed";
export type Effort = "minutes" | "hours" | "days";

export interface RawNode {
  target: string[];
  html: string;
  failureSummary?: string;
}

export interface RawViolation {
  id: string;
  impact: Impact | null;
  tags: string[];
  help: string;
  helpUrl: string;
  description: string;
  nodes: RawNode[];
}

export interface PageScan {
  url: string;
  viewport: Viewport;
  statusCode: number | null;
  title: string;
  violations: RawViolation[];
  incomplete: RawViolation[];
  error?: string;
}

export interface Finding {
  rank: number;
  ruleId: string;
  impact: Impact;
  category: string;
  wcagTags: string[];
  pagesAffected: number;
  nodesTotal: number;
  litigationWeight: number;
  score: number;
  confidence: Confidence;
  examplePageUrl: string | null;
  exampleSelector: string | null;
  exampleHtml: string | null;
  screenshotPath: string | null;
  help: string;
  helpUrl: string;
  affectedUrls: string[];
}

export interface FindingNarrative {
  ruleId: string;
  title: string;
  plainEnglish: string;
  whyItMatters: string;
  fixSteps: string[];
  beforeHtml: string | null;
  afterHtml: string | null;
  effort: Effort;
}

export interface Narrative {
  executiveSummary: string;
  riskOverview: string;
  topPriorities: string[];
  findings: FindingNarrative[];
  manualChecks: { title: string; how: string }[];
  nextSteps: string[];
  generatedBy: "claude" | "dictionary";
  model?: string;
}

export interface AuditSummary {
  pagesRequested: number;
  pagesScanned: number;
  pagesFailed: number;
  totalViolationNodes: number;
  findingsCount: number;
  byImpact: Record<Impact, number>;
  byConfidence: Record<Confidence, number>;
  scanStartedAt: string;
  scanFinishedAt: string;
  viewports: Viewport[];
}

export interface DeltaEntry {
  ruleId: string;
  title: string;
  before: number;
  after: number;
}

export interface Delta {
  originalAuditId: string;
  originalDate: string;
  rescanDate: string;
  fixed: DeltaEntry[];
  newIssues: DeltaEntry[];
  unchanged: DeltaEntry[];
  nodesBefore: number;
  nodesAfter: number;
  percentFixed: number;
}

export interface SiteMeta {
  url: string;
  origin: string;
  siteTitle: string;
  platformGuess: "shopify" | "wordpress" | "webflow" | "squarespace" | "wix" | "unknown";
}

export interface TeaserResult {
  url: string;
  title: string;
  scannedAt: string;
  violationNodes: number;
  rulesFailed: number;
  top: {
    ruleId: string;
    title: string;
    impact: Impact;
    nodes: number;
    plainEnglish: string;
    screenshotDataUrl: string | null;
    exampleHtml: string;
  }[];
  needsManualCount: number;
  cached: boolean;
}

// ---------------------------------------------------------------------------
// Row interfaces: 1:1 with the tables in src/db.ts. Booleans are 0/1 numbers,
// timestamps are ISO-8601 UTC strings, JSON columns are strings.
// ---------------------------------------------------------------------------

export interface OrderRow {
  id: string;
  created_at: string;
  email: string;
  product: Product;
  status: OrderStatus;
  amount_cents: number;
  currency: string;
  stripe_session_id: string | null;
  stripe_payment_intent: string | null;
  paid_via: PaidVia | null;
  paid_at: string | null;
  url: string | null;
  agency_name: string | null;
  agency_logo_path: string | null;
  coupon: string | null;
  ip: string | null;
}

export interface CreditCodeRow {
  id: string;
  code: string;
  order_id: string;
  credits_total: number;
  credits_left: number;
  agency_name: string | null;
  agency_logo_path: string | null;
  created_at: string;
}

export interface AuditRow {
  id: string;
  token: string;
  order_id: string | null;
  credit_code_id: string | null;
  email: string;
  url: string;
  origin: string;
  page_limit: number;
  white_label: number;
  agency_name: string | null;
  agency_logo_path: string | null;
  tier: Tier;
  status: AuditStatus;
  progress_pages: number;
  progress_issues: number;
  progress_note: string | null;
  error: string | null;
  log: string;
  narrative_json: string | null;
  summary_json: string | null;
  pdf_path: string | null;
  json_path: string | null;
  csv_path: string | null;
  rescan_of: string | null;
  rescan_used: number;
  reminder_sent: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  released_at: string | null;
}

export interface JobRow {
  id: string;
  type: string;
  ref_id: string;
  status: JobStatus;
  attempts: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
}

export interface PageRow {
  id: string;
  audit_id: string;
  url: string;
  viewport: Viewport;
  status_code: number | null;
  title: string | null;
  violations_json: string;
  incomplete_json: string;
  violation_count: number;
  scanned_at: string;
  error: string | null;
}

export interface FindingRow {
  id: string;
  audit_id: string;
  rank: number;
  rule_id: string;
  impact: Impact;
  category: string;
  /** JSON-encoded string[] */
  wcag_tags: string;
  pages_affected: number;
  nodes_total: number;
  litigation_weight: number;
  score: number;
  confidence: Confidence;
  example_page_url: string | null;
  example_selector: string | null;
  example_html: string | null;
  screenshot_path: string | null;
  help: string;
  help_url: string;
  /** JSON-encoded string[] of affected page URLs (max 30). */
  affected_urls: string;
}

export interface TeaserRow {
  id: string;
  url_hash: string;
  url: string;
  result_json: string;
  created_at: string;
}

export interface EmailRow {
  id: string;
  to_email: string;
  subject: string;
  html: string;
  sent_via: "outbox" | "resend";
  created_at: string;
}

export interface EventRow {
  id: string;
  type: string;
  meta_json: string;
  created_at: string;
}
