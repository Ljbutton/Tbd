// POST /api/teaser: the free single-page scan that feeds the funnel.
// JSON in, JSON out for app.js; `?format=html` (or a `format=html` field)
// renders views/teaser-result.ejs so the form keeps working without JavaScript.

import express, { type NextFunction, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import { config } from "../config.js";
import { db, nowIso } from "../db.js";
import { assertPublicUrl } from "../scan/ssrf.js";
import { runTeaser } from "../scan/teaser.js";
import { hashUrl, normalizeUrl } from "../scan/url.js";
import type { TeaserResult, TeaserRow } from "../types.js";
import { HttpError, asyncHandler } from "../util/http.js";
import { newId } from "../util/ids.js";
import { renderPage } from "../util/render.js";
import { track } from "./funnel.js";
import { MARKETING_STYLE, teaserLocals } from "./marketing.js";

export const router = express.Router();

export const TEASER_CACHE_MS = 24 * 60 * 60 * 1000;
export const TEASER_WINDOW_MS = 60 * 60 * 1000;
/** Hard ceiling on top of runTeaser()'s own 60s cap, so a stuck browser launch still yields a 504. */
export const TEASER_HARD_TIMEOUT_MS = 75 * 1000;
/** Simultaneous free scans allowed before we answer 503 (each one opens a Chromium context). */
export const TEASER_MAX_CONCURRENT = 3;

export const TIMEOUT_MESSAGE = "That page took too long to load. Try again or scan a different page.";
export const BUSY_MESSAGE = "We're scanning a lot of pages right now. Try again in a minute.";
export const SCAN_FAILED_MESSAGE = "We couldn't scan that page right now. Check the address or try again in a minute.";
export const ORDER_PATH = "/order?product=single";

export function rateLimitMessage(): string {
  return `${config.teaserRateLimit} free scans per hour. Buy a full audit for the whole site.`;
}

const selectTeaserStmt = db.prepare("SELECT * FROM teasers WHERE url_hash = ?");
const upsertTeaserStmt = db.prepare(
  `INSERT INTO teasers (id, url_hash, url, result_json, created_at) VALUES (?, ?, ?, ?, ?)
   ON CONFLICT(url_hash) DO UPDATE SET url = excluded.url, result_json = excluded.result_json, created_at = excluded.created_at`,
);

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstString(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return "";
}

/** The submitted URL from a JSON or form body (empty string when absent). */
export function readUrl(req: Request): string {
  const body: unknown = req.body;
  return (isRecord(body) ? firstString(body.url) : "").trim().slice(0, 4096);
}

/** True when the caller wants a rendered page instead of JSON (plain form post without JS). */
export function wantsHtml(req: Request): boolean {
  if (firstString(req.query.format) === "html") return true;
  const body: unknown = req.body;
  return isRecord(body) && firstString(body.format) === "html";
}

function orderUrl(url: string): string {
  return `${ORDER_PATH}&url=${encodeURIComponent(url)}`;
}

interface TeaserPageState {
  result?: TeaserResult;
  error?: string;
  prefillUrl?: string;
}

/** Renders views/teaser-result.ejs for the no-JavaScript path (result or error state). */
export async function renderTeaserPage(res: Response, state: TeaserPageState, status = 200): Promise<void> {
  await renderPage(
    res,
    "teaser-result",
    {
      title: state.error !== undefined ? "We couldn't scan that page" : "Free scan results",
      head: [MARKETING_STYLE, '<meta name="robots" content="noindex">'].join("\n"),
      result: state.result ?? null,
      error: state.error ?? null,
      status,
      orderUrl: state.result ? orderUrl(state.result.url) : ORDER_PATH,
      ...teaserLocals(state.prefillUrl ?? state.result?.url ?? ""),
    },
    status,
  );
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

function readCache(hash: string): TeaserResult | null {
  const row = selectTeaserStmt.get(hash) as TeaserRow | undefined;
  if (row === undefined) return null;
  const age = Date.now() - Date.parse(row.created_at);
  if (!Number.isFinite(age) || age < 0 || age > TEASER_CACHE_MS) return null;
  try {
    const parsed: unknown = JSON.parse(row.result_json);
    if (!isRecord(parsed) || !Array.isArray(parsed.top)) return null;
    return { ...(parsed as unknown as TeaserResult), cached: true };
  } catch {
    return null;
  }
}

function writeCache(hash: string, url: string, result: TeaserResult): void {
  try {
    upsertTeaserStmt.run(newId(), hash, url, JSON.stringify({ ...result, cached: false }), nowIso());
  } catch (err) {
    // A cache write must never fail the scan that produced it.
    console.error("teaser cache write failed: %s", err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

let activeScans = 0;

function isTimeoutLike(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /timed out|timeout/i.test(message);
}

/** Maps anything thrown during a scan to the HttpError the API documents. */
export function toTeaserError(err: unknown, url: string): HttpError {
  if (err instanceof HttpError) return err;
  if (isTimeoutLike(err)) return new HttpError(504, TIMEOUT_MESSAGE, "timeout");
  console.error("teaser scan failed for %s:", url, err instanceof Error ? (err.stack ?? err.message) : err);
  return new HttpError(502, SCAN_FAILED_MESSAGE, "scan_failed");
}

async function withHardTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new HttpError(504, TIMEOUT_MESSAGE, "timeout")), ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Validates the address, serves a cached result younger than 24h, otherwise
 * runs the scan and caches it. Throws HttpError with the documented codes:
 * invalid_url / blocked_target / dns_failed (400), timeout (504), busy (503),
 * page_unreachable / scan_failed (502).
 */
export async function teaserScan(rawUrl: string): Promise<TeaserResult> {
  const url = await assertPublicUrl(rawUrl);
  let normalized: string;
  try {
    normalized = normalizeUrl(url.href);
  } catch {
    throw new HttpError(400, "Enter a full website address like https://example.com", "invalid_url");
  }
  const hash = hashUrl(normalized);

  const cached = readCache(hash);
  if (cached !== null) {
    track("teaser_scan", { host: url.hostname, cached: true, violationNodes: cached.violationNodes, rulesFailed: cached.rulesFailed });
    return cached;
  }

  if (activeScans >= TEASER_MAX_CONCURRENT) throw new HttpError(503, BUSY_MESSAGE, "busy");
  activeScans += 1;
  let result: TeaserResult;
  try {
    result = await withHardTimeout(runTeaser(normalized), TEASER_HARD_TIMEOUT_MS);
  } catch (err) {
    throw toTeaserError(err, normalized);
  } finally {
    activeScans -= 1;
  }

  writeCache(hash, normalized, result);
  track("teaser_scan", { host: url.hostname, cached: false, violationNodes: result.violationNodes, rulesFailed: result.rulesFailed });
  return { ...result, cached: false };
}

// ---------------------------------------------------------------------------
// Rate limit and route
// ---------------------------------------------------------------------------

export const teaserLimiter = rateLimit({
  windowMs: TEASER_WINDOW_MS,
  limit: config.teaserRateLimit,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler: (req: Request, res: Response, next: NextFunction) => {
    const message = rateLimitMessage();
    if (wantsHtml(req)) {
      renderTeaserPage(res, { error: message, prefillUrl: readUrl(req) }, 429).catch(next);
      return;
    }
    res.status(429).json({ error: "rate_limited", message });
  },
});

router.post(
  "/api/teaser",
  teaserLimiter,
  asyncHandler(async (req, res) => {
    const html = wantsHtml(req);
    const rawUrl = readUrl(req);
    res.setHeader("Cache-Control", "no-store");
    try {
      const result = await teaserScan(rawUrl);
      if (html) {
        await renderTeaserPage(res, { result });
        return;
      }
      res.json(result);
    } catch (err) {
      const httpErr = toTeaserError(err, rawUrl);
      if (!html) throw httpErr;
      await renderTeaserPage(res, { error: httpErr.message, prefillUrl: rawUrl }, httpErr.status);
    }
  }),
);
