// Server-side funnel counters (no cookies, no third-party tracking): one events row per action.
import { db, nowIso } from "../db.js";
import { newId } from "../util/ids.js";

/** Event types the admin dashboard always shows, even at zero. */
export const FUNNEL_EVENT_TYPES = ["teaser_scan", "checkout_start", "paid", "report_ready", "rescan"] as const;

const insertEventStmt = db.prepare("INSERT INTO events (id, type, meta_json, created_at) VALUES (?, ?, ?, ?)");
const countStmt = db.prepare("SELECT type, COUNT(*) AS n FROM events WHERE created_at >= ? GROUP BY type");

/** Records an event. Never throws: a failed counter must not break a request. */
export function track(type: string, meta: Record<string, unknown> = {}): void {
  try {
    insertEventStmt.run(newId(), type, JSON.stringify(meta), nowIso());
  } catch (err) {
    console.error("track(%s) failed: %s", type, err instanceof Error ? err.message : String(err));
  }
}

/** Counts events per type over the last `days` days (the five funnel types are always present). */
export function funnelCounts(days: number): Record<string, number> {
  const safeDays = Number.isFinite(days) && days > 0 ? days : 30;
  const since = new Date(Date.now() - safeDays * 24 * 60 * 60 * 1000).toISOString();
  const counts: Record<string, number> = {};
  for (const type of FUNNEL_EVENT_TYPES) counts[type] = 0;
  for (const row of countStmt.all(since) as { type: string; n: number }[]) {
    counts[row.type] = row.n;
  }
  return counts;
}
