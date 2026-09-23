import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useFreshDataDir } from "./helpers/data-dir.js";

useFreshDataDir("runner");

// The runner is exercised with a stand-in pipeline so no browser is launched:
// it flips the audit to a status chosen per test, or waits for the abort signal.
const pipeline = vi.hoisted(() => ({
  mode: "ready" as "ready" | "failed" | "hang",
  calls: [] as string[],
}));

vi.mock("../../src/jobs/audit.js", async () => {
  const { updateAudit } = await import("../../src/audits.js");
  return {
    runAudit: async (auditId: string, options: { signal?: AbortSignal } = {}): Promise<void> => {
      pipeline.calls.push(auditId);
      if (pipeline.mode === "hang") {
        await new Promise<void>((resolve) => {
          options.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return;
      }
      updateAudit(auditId, pipeline.mode === "ready" ? { status: "ready" } : { status: "failed", error: "boom" });
    },
  };
});

const { db, nowIso } = await import("../../src/db.js");
const { config } = await import("../../src/config.js");
const { createAudit, getAudit } = await import("../../src/audits.js");
const { listOutbox } = await import("../../src/email/send.js");
const runner = await import("../../src/jobs/runner.js");
const { newId } = await import("../../src/util/ids.js");

type Job = { id: string; status: string; attempts: number; error: string | null; started_at: string | null };

function makeAudit(overrides: Partial<{ status: string; created_at: string; rescan_used: number; rescan_of: string | null; reminder_sent: number }> = {}) {
  const audit = createAudit({
    email: "buyer@example.com",
    url: "http://127.0.0.1:4100/",
    origin: "http://127.0.0.1:4100",
    page_limit: 15,
    white_label: 0,
    tier: "single",
  });
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(overrides)) {
    sets.push(`${key} = ?`);
    values.push(value);
  }
  if (sets.length > 0) db.prepare(`UPDATE audits SET ${sets.join(", ")} WHERE id = ?`).run(...values, audit.id);
  return getAudit(audit.id) ?? audit;
}

function insertJob(auditId: string, status: string, attempts: number): string {
  const id = newId();
  db.prepare("INSERT INTO jobs (id, type, ref_id, status, attempts, created_at, started_at) VALUES (?, 'audit', ?, ?, ?, ?, ?)").run(
    id,
    auditId,
    status,
    attempts,
    nowIso(),
    status === "running" ? nowIso() : null,
  );
  return id;
}

function job(id: string): Job {
  return db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Job;
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

beforeEach(() => {
  pipeline.mode = "ready";
  pipeline.calls.length = 0;
  db.prepare("DELETE FROM jobs").run();
});

afterAll(() => {
  runner.stopRunner();
});

describe("crash recovery", () => {
  it("queues a job that was running when the process died and bumps attempts", () => {
    const audit = makeAudit({ status: "scanning" });
    const id = insertJob(audit.id, "running", 0);
    const result = runner.recoverCrashedJobs();
    expect(result).toEqual({ requeued: 1, failed: 0 });
    expect(job(id)).toMatchObject({ status: "queued", attempts: 1, started_at: null });
    expect(getAudit(audit.id)?.status).toBe("queued");
    expect(getAudit(audit.id)?.log).toContain("queued again");
  });

  it("fails a job that crashed twice and marks its audit failed with 'crashed twice'", () => {
    const audit = makeAudit({ status: "crawling" });
    const id = insertJob(audit.id, "running", 1);
    const result = runner.recoverCrashedJobs();
    expect(result).toEqual({ requeued: 0, failed: 1 });
    expect(job(id)).toMatchObject({ status: "failed", attempts: 2, error: "crashed twice" });
    const row = getAudit(audit.id);
    expect(row?.status).toBe("failed");
    expect(row?.error).toBe("crashed twice");
    expect(row?.finished_at).toBeTruthy();
  });

  it("leaves queued and done jobs alone", () => {
    const audit = makeAudit();
    const queued = insertJob(audit.id, "queued", 0);
    const done = insertJob(audit.id, "done", 0);
    runner.recoverCrashedJobs();
    expect(job(queued).status).toBe("queued");
    expect(job(done).status).toBe("done");
  });
});

describe("tick", () => {
  it("runs the oldest queued job, sets started_at and marks the job done when the audit ends ready", async () => {
    const first = makeAudit();
    const second = makeAudit();
    runner.enqueueAudit(first.id);
    runner.enqueueAudit(second.id);
    expect(runner.runnerStats()).toEqual({ queued: 2, running: 0 });

    runner.tick();
    expect(runner.currentAuditId()).toBe(first.id);
    expect(runner.runnerStats()).toEqual({ queued: 1, running: 1 });
    runner.tick(); // one job at a time: nothing else starts
    expect(runner.runnerStats()).toEqual({ queued: 1, running: 1 });

    await runner.waitForIdle();
    expect(pipeline.calls).toEqual([first.id]);
    expect(getAudit(first.id)?.started_at).toBeTruthy();
    const rows = db.prepare("SELECT status FROM jobs WHERE ref_id = ?").all(first.id) as { status: string }[];
    expect(rows.map((r) => r.status)).toEqual(["done"]);

    runner.tick();
    await runner.waitForIdle();
    expect(pipeline.calls).toEqual([first.id, second.id]);
    expect(runner.runnerStats()).toEqual({ queued: 0, running: 0 });
  });

  it("records a failed job when the pipeline ends with a failed audit", async () => {
    pipeline.mode = "failed";
    const audit = makeAudit();
    runner.enqueueAudit(audit.id);
    runner.tick();
    await runner.waitForIdle();
    const row = db.prepare("SELECT status, error FROM jobs WHERE ref_id = ?").get(audit.id) as { status: string; error: string };
    expect(row).toEqual({ status: "failed", error: "boom" });
  });

  it("stops an audit that exceeds the timeout, marks it failed with 'timeout' and frees the runner", async () => {
    pipeline.mode = "hang";
    const original = config.auditTimeoutMs;
    config.auditTimeoutMs = 60;
    try {
      const audit = makeAudit();
      runner.enqueueAudit(audit.id);
      runner.tick();
      await runner.waitForIdle();
      await waitFor(() => getAudit(audit.id)?.status === "failed");
      const row = getAudit(audit.id);
      expect(row?.error).toBe("timeout");
      expect(row?.log).toContain("stopped and marked failed");
      const jobRow = db.prepare("SELECT status, error FROM jobs WHERE ref_id = ?").get(audit.id) as { status: string; error: string };
      expect(jobRow).toEqual({ status: "failed", error: "timeout" });
      expect(runner.currentAuditId()).toBeNull();
    } finally {
      config.auditTimeoutMs = original;
    }
  });
});

describe("sweepReminders", () => {
  const DAY = 24 * 60 * 60 * 1000;

  it("emails audits created 25-26 days ago once, and skips used, re-scan and fresh ones", async () => {
    const now = new Date();
    const due = makeAudit({ status: "ready", created_at: new Date(now.getTime() - 25.5 * DAY).toISOString() });
    makeAudit({ status: "ready", created_at: new Date(now.getTime() - 25.5 * DAY).toISOString(), rescan_used: 1 });
    makeAudit({ status: "ready", created_at: new Date(now.getTime() - 25.5 * DAY).toISOString(), rescan_of: due.id });
    makeAudit({ status: "ready", created_at: new Date(now.getTime() - 3 * DAY).toISOString() });
    makeAudit({ status: "failed", created_at: new Date(now.getTime() - 25.5 * DAY).toISOString() });

    const before = listOutbox(100).length;
    expect(await runner.sweepReminders(now)).toBe(1);
    expect(getAudit(due.id)?.reminder_sent).toBe(1);
    const mails = listOutbox(100);
    expect(mails.length).toBe(before + 1);
    expect(mails[0]?.subject).toBe("Your free re-scan expires in 5 days");
    expect(mails[0]?.to_email).toBe("buyer@example.com");

    expect(await runner.sweepReminders(now)).toBe(0);
  });
});

describe("startRunner", () => {
  it("is idempotent and can be stopped", () => {
    runner.startRunner();
    runner.startRunner();
    expect(runner.isRunnerStarted()).toBe(true);
    runner.stopRunner();
    expect(runner.isRunnerStarted()).toBe(false);
  });
});
