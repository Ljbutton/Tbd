// STUB - replaced by step S6 (job runner). enqueueAudit() and runnerStats() are real.
import { db, nowIso } from "../db.js";
import { newId } from "../util/ids.js";

const insertJobStmt = db.prepare(
  "INSERT INTO jobs (id, type, ref_id, status, attempts, created_at) VALUES (?, 'audit', ?, 'queued', 0, ?)",
);
const statsStmt = db.prepare(
  "SELECT SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued, SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running FROM jobs",
);

/** Adds a queued job for the audit; the runner picks it up on its next tick. */
export function enqueueAudit(auditId: string): void {
  insertJobStmt.run(newId(), auditId, nowIso());
}

/** Queue depth for /healthz and the admin page. */
export function runnerStats(): { queued: number; running: number } {
  const row = statsStmt.get() as { queued: number | null; running: number | null };
  return { queued: row.queued ?? 0, running: row.running ?? 0 };
}

/** Starts the in-process queue. Stub: no-op until the runner step lands (jobs stay queued). */
export function startRunner(): void {
  // Intentionally empty in the scaffold: the real runner (recover crashed jobs, tick every 2s,
  // run audits under the audit timeout, hourly reminder sweep) is delivered by step S6.
}
