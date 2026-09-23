// In-process job queue (spec section 13). One audit runs at a time:
//
//   startRunner()   boot: recover jobs left "running" by a crash, then tick every 2s
//                   and sweep re-scan reminders every hour (and once at boot)
//   tick()          picks the oldest queued job and runs runAudit() under the
//                   audit timeout; a timeout fails the audit and closes the browser
//   enqueueAudit()  adds a queued job (called by orders, credits, re-scan, admin)
//   runnerStats()   queue depth for /healthz and the admin page
//
// `attempts` counts crash recoveries: a job found "running" at boot is put
// back in the queue with attempts + 1, and one that has been recovered twice
// is failed with the audit error "crashed twice".

import { appendAuditLog, getAudit, updateAudit } from "../audits.js";
import { config } from "../config.js";
import { db, nowIso } from "../db.js";
import { sendEmail } from "../email/send.js";
import { rescanReminder } from "../email/templates.js";
import { closeBrowser } from "../scan/browser.js";
import type { AuditRow, JobRow } from "../types.js";
import { newId } from "../util/ids.js";
import { runAudit } from "./audit.js";

export const TICK_MS = 2000;
export const REMINDER_SWEEP_MS = 60 * 60 * 1000;
/** A job recovered this many times after a crash is failed instead of retried. */
export const MAX_CRASH_RECOVERIES = 2;
export const CRASHED_ERROR = "crashed twice";
export const TIMEOUT_ERROR = "timeout";
/** Reminder window: audits created between 26 and 25 days ago (spec 13). */
export const REMINDER_FROM_DAYS = 26;
export const REMINDER_TO_DAYS = 25;

const DAY_MS = 24 * 60 * 60 * 1000;

const insertJobStmt = db.prepare(
  "INSERT INTO jobs (id, type, ref_id, status, attempts, created_at) VALUES (?, 'audit', ?, 'queued', 0, ?)",
);
const statsStmt = db.prepare(
  "SELECT SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued, SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running FROM jobs",
);
const nextJobStmt = db.prepare("SELECT * FROM jobs WHERE status = 'queued' AND type = 'audit' ORDER BY created_at ASC, rowid ASC LIMIT 1");
const startJobStmt = db.prepare("UPDATE jobs SET status = 'running', started_at = ?, finished_at = NULL, error = NULL WHERE id = ? AND status = 'queued'");
const finishJobStmt = db.prepare("UPDATE jobs SET status = ?, finished_at = ?, error = ? WHERE id = ?");
const runningJobsStmt = db.prepare("SELECT * FROM jobs WHERE status = 'running'");
const requeueJobStmt = db.prepare("UPDATE jobs SET status = 'queued', attempts = attempts + 1, started_at = NULL WHERE id = ?");
const failCrashedJobStmt = db.prepare("UPDATE jobs SET status = 'failed', attempts = attempts + 1, finished_at = ?, error = ? WHERE id = ?");
const reminderCandidatesStmt = db.prepare(
  "SELECT * FROM audits WHERE status = 'ready' AND rescan_used = 0 AND rescan_of IS NULL AND reminder_sent = 0 AND created_at BETWEEN ? AND ? ORDER BY created_at ASC",
);
const markReminderSentStmt = db.prepare("UPDATE audits SET reminder_sent = 1 WHERE id = ?");

let tickTimer: NodeJS.Timeout | null = null;
let sweepTimer: NodeJS.Timeout | null = null;
let current: { job: JobRow; promise: Promise<void> } | null = null;

/** Adds a queued job for the audit; the runner picks it up on its next tick. */
export function enqueueAudit(auditId: string): void {
  insertJobStmt.run(newId(), auditId, nowIso());
}

/** Queue depth for /healthz and the admin page. */
export function runnerStats(): { queued: number; running: number } {
  const row = statsStmt.get() as { queued: number | null; running: number | null };
  return { queued: row.queued ?? 0, running: row.running ?? 0 };
}

/** Id of the audit being processed right now, or null when the runner is idle. */
export function currentAuditId(): string | null {
  return current ? current.job.ref_id : null;
}

class AuditTimeoutError extends Error {
  constructor(ms: number) {
    super(`audit exceeded the ${Math.round(ms / 1000)}s limit`);
    this.name = "AuditTimeoutError";
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message.split("\n")[0] ?? err.message;
  return String(err);
}

function safeLog(auditId: string, line: string): void {
  try {
    appendAuditLog(auditId, line);
  } catch (err) {
    console.error("runner: could not log to audit %s: %s", auditId, errorMessage(err));
  }
}

// ---------------------------------------------------------------------------
// Crash recovery
// ---------------------------------------------------------------------------

/**
 * Jobs still marked "running" belong to a process that died. Each goes back
 * to the queue with attempts + 1; one recovered twice is failed and its audit
 * marked failed with "crashed twice". Returns what happened for the boot log.
 */
export const recoverCrashedJobs = db.transaction((): { requeued: number; failed: number } => {
  const running = runningJobsStmt.all() as JobRow[];
  let requeued = 0;
  let failed = 0;
  const now = nowIso();
  for (const job of running) {
    const attempts = job.attempts + 1;
    if (attempts >= MAX_CRASH_RECOVERIES) {
      failCrashedJobStmt.run(now, CRASHED_ERROR, job.id);
      updateAudit(job.ref_id, { status: "failed", error: CRASHED_ERROR, finished_at: now, progress_note: "Failed" });
      safeLog(job.ref_id, "runner: the process stopped twice while this audit was running; marked failed");
      failed += 1;
    } else {
      requeueJobStmt.run(job.id);
      updateAudit(job.ref_id, { status: "queued", progress_note: "Waiting in line again after a restart" });
      safeLog(job.ref_id, "runner: the process stopped while this audit was running; queued again");
      requeued += 1;
    }
  }
  return { requeued, failed };
});

// ---------------------------------------------------------------------------
// Running one job
// ---------------------------------------------------------------------------

function finishJob(jobId: string, status: "done" | "failed", error: string | null): void {
  finishJobStmt.run(status, nowIso(), error, jobId);
}

async function runJob(job: JobRow): Promise<void> {
  const audit = getAudit(job.ref_id);
  if (!audit) {
    finishJob(job.id, "failed", "audit not found");
    console.error("runner: job %s refers to a missing audit %s", job.id, job.ref_id);
    return;
  }
  // The runner owns started_at (the pipeline keeps it when set).
  updateAudit(audit.id, { started_at: nowIso() });

  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new AuditTimeoutError(config.auditTimeoutMs);
      controller.abort(err);
      reject(err);
    }, config.auditTimeoutMs);
  });

  try {
    await Promise.race([runAudit(audit.id, { signal: controller.signal }), timeout]);
    const after = getAudit(audit.id);
    if (after && after.status === "failed") {
      finishJob(job.id, "failed", after.error ?? "failed");
    } else {
      finishJob(job.id, "done", null);
    }
  } catch (err) {
    if (err instanceof AuditTimeoutError) {
      console.error("runner: audit %s timed out after %dms", audit.id, config.auditTimeoutMs);
      updateAudit(audit.id, { status: "failed", error: TIMEOUT_ERROR, finished_at: nowIso(), progress_note: "Failed" });
      safeLog(audit.id, `runner: ${err.message}; the audit was stopped and marked failed`);
      finishJob(job.id, "failed", TIMEOUT_ERROR);
    } else {
      // runAudit() catches its own errors, so this is unexpected: record it anyway.
      const message = errorMessage(err);
      console.error("runner: job %s crashed: %s", job.id, err);
      updateAudit(audit.id, { status: "failed", error: message.slice(0, 500), finished_at: nowIso(), progress_note: "Failed" });
      safeLog(audit.id, `runner: unexpected error (${message})`);
      finishJob(job.id, "failed", message.slice(0, 500));
    }
    await closeBrowser();
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** One scheduler pass: does nothing while a job runs, otherwise starts the oldest queued job. */
export function tick(): void {
  if (current !== null) return;
  const job = nextJobStmt.get() as JobRow | undefined;
  if (!job) return;
  const claimed = startJobStmt.run(nowIso(), job.id).changes === 1;
  if (!claimed) return;
  const started: JobRow = { ...job, status: "running", started_at: nowIso() };
  const promise = runJob(started)
    .catch((err: unknown) => {
      console.error("runner: job %s failed outside the pipeline: %s", job.id, errorMessage(err));
      try {
        finishJob(job.id, "failed", errorMessage(err).slice(0, 500));
      } catch {
        // Nothing more to do: the database itself is unavailable.
      }
    })
    .finally(() => {
      if (current !== null && current.job.id === job.id) current = null;
    });
  current = { job: started, promise };
}

/** Resolves once the job running right now (if any) has finished. */
export async function waitForIdle(): Promise<void> {
  if (current !== null) await current.promise;
}

// ---------------------------------------------------------------------------
// Re-scan reminders
// ---------------------------------------------------------------------------

/**
 * Emails "Your free re-scan expires in 5 days" to ready, non-re-scan audits
 * created 25-26 days ago whose re-scan is unused, then marks them reminded.
 * Returns how many reminders went out.
 */
export async function sweepReminders(now: Date = new Date()): Promise<number> {
  const from = new Date(now.getTime() - REMINDER_FROM_DAYS * DAY_MS).toISOString();
  const to = new Date(now.getTime() - REMINDER_TO_DAYS * DAY_MS).toISOString();
  const audits = reminderCandidatesStmt.all(from, to) as AuditRow[];
  let sent = 0;
  for (const audit of audits) {
    try {
      const mail = rescanReminder(audit);
      const result = await sendEmail({ to: audit.email, subject: mail.subject, html: mail.html });
      markReminderSentStmt.run(audit.id);
      safeLog(audit.id, `reminder: re-scan reminder ${result.error ? `kept in the outbox (${result.error})` : `sent via ${result.sentVia}`}`);
      sent += 1;
    } catch (err) {
      console.error("runner: reminder for audit %s failed: %s", audit.id, errorMessage(err));
    }
  }
  return sent;
}

function scheduleSweep(): void {
  const run = (): void => {
    sweepReminders().catch((err: unknown) => {
      console.error("runner: reminder sweep failed: %s", errorMessage(err));
    });
  };
  run();
  sweepTimer = setInterval(run, REMINDER_SWEEP_MS);
  sweepTimer.unref();
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/** Starts the queue: crash recovery, the 2s tick and the hourly reminder sweep. Safe to call twice. */
export function startRunner(): void {
  if (tickTimer !== null) return;
  const recovered = recoverCrashedJobs();
  if (recovered.requeued > 0 || recovered.failed > 0) {
    console.log(`runner: recovered ${recovered.requeued} interrupted job(s), failed ${recovered.failed} that had crashed twice`);
  }
  tickTimer = setInterval(() => {
    try {
      tick();
    } catch (err) {
      console.error("runner: tick failed: %s", errorMessage(err));
    }
  }, TICK_MS);
  scheduleSweep();
  tick();
}

/** Stops the timers (a running job finishes on its own). Used by tests and graceful shutdown. */
export function stopRunner(): void {
  if (tickTimer !== null) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
  if (sweepTimer !== null) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

export function isRunnerStarted(): boolean {
  return tickTimer !== null;
}
