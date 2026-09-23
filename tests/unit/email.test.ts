import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditRow, CreditCodeRow, Finding, Narrative, OrderRow } from "../../src/types.js";
import { useFreshDataDir } from "./helpers/data-dir.js";

// The Resend client is replaced so "resend mode" can be exercised without a
// network: each test decides whether the fake send succeeds, returns an API
// error object (Resend's normal failure shape) or rejects outright.
const mocks = vi.hoisted(() => ({
  send: vi.fn<(payload: unknown) => Promise<{ data: { id: string } | null; error: { message: string; statusCode: number | null; name: string } | null }>>(),
  constructed: [] as (string | undefined)[],
}));
vi.mock("resend", () => ({
  Resend: class {
    emails = { send: mocks.send };
    constructor(key?: string) {
      mocks.constructed.push(key);
    }
  },
}));

delete process.env.RESEND_API_KEY;
delete process.env.BASE_URL;
useFreshDataDir("email");
const { config } = await import("../../src/config.js");
const { db } = await import("../../src/db.js");
const { sendEmail, listOutbox, getOutboxEmail, listEmailsTo, firstHttpLink, extractHttpLinks } = await import(
  "../../src/email/send.js"
);
const templates = await import("../../src/email/templates.js");
const { createAudit, insertFindings, updateAudit } = await import("../../src/audits.js");

interface OutboxRow {
  id: string;
  to_email: string;
  subject: string;
  html: string;
  sent_via: string;
  created_at: string;
}

function rowsFor(subject: string): OutboxRow[] {
  return db.prepare("SELECT * FROM emails_outbox WHERE subject = ? ORDER BY created_at ASC").all(subject) as OutboxRow[];
}

function makeAudit(overrides: Partial<Parameters<typeof createAudit>[0]> = {}): AuditRow {
  return createAudit({
    email: "buyer@example.com",
    url: "https://northwind-candles.example/",
    origin: "https://northwind-candles.example",
    page_limit: 15,
    white_label: false,
    tier: "single",
    ...overrides,
  });
}

function finding(rank: number, ruleId: string, help: string): Finding {
  return {
    rank,
    ruleId,
    impact: "serious",
    category: "images",
    wcagTags: ["wcag2a"],
    pagesAffected: 2,
    nodesTotal: 4,
    litigationWeight: 3,
    score: 20,
    confidence: "automated",
    examplePageUrl: "https://northwind-candles.example/products.html",
    exampleSelector: "img",
    exampleHtml: "<img src=\"/x.png\">",
    screenshotPath: null,
    help,
    helpUrl: `https://dequeuniversity.com/rules/axe/4.10/${ruleId}`,
    affectedUrls: ["https://northwind-candles.example/"],
  };
}

const order: OrderRow = {
  id: "0f0e0d0c-0b0a-4908-8706-050403020100",
  created_at: "2026-09-01T09:00:00.000Z",
  email: "agency@example.com",
  product: "pack5",
  status: "paid",
  amount_cents: 9900,
  currency: "usd",
  stripe_session_id: null,
  stripe_payment_intent: null,
  paid_via: "mock",
  paid_at: "2026-09-01T09:01:00.000Z",
  url: null,
  agency_name: "Bright & <Pixel> Studio",
  agency_logo_path: null,
  coupon: "FOUNDING50",
  ip: null,
};

const creditCodeRow: CreditCodeRow = {
  id: "c0de0000-0000-4000-8000-000000000001",
  code: "AA-7H3K-9PQR",
  order_id: order.id,
  credits_total: 5,
  credits_left: 5,
  agency_name: order.agency_name,
  agency_logo_path: null,
  created_at: "2026-09-01T09:01:00.000Z",
};

/** Text that may appear only inside the permitted disclaimer sentence. */
const DISCLAIMER = templates.DISCLAIMER;
function forbiddenWording(html: string): string | null {
  const stripped = html.split(DISCLAIMER).join("");
  const match = /complian|certif/i.exec(stripped);
  return match ? stripped.slice(Math.max(0, match.index - 40), match.index + 50) : null;
}

beforeEach(() => {
  mocks.send.mockReset();
  mocks.constructed.length = 0;
  config.resend.apiKey = undefined;
});

afterEach(() => {
  config.resend.apiKey = undefined;
  vi.restoreAllMocks();
});

describe("sendEmail without RESEND_API_KEY", () => {
  it("stores the message in the outbox, logs the first link and never calls Resend", async () => {
    expect(config.emailOutbox).toBe(true);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await sendEmail({
      to: "buyer@example.com",
      subject: "Outbox test",
      html: '<p>Hi</p><p><a href="http://localhost:3000/r/abc123">Open</a></p>',
    });
    expect(result.sentVia).toBe("outbox");
    expect(result.error).toBeNull();
    expect(result.id).toMatch(/^[0-9a-f-]{36}$/);

    const rows = rowsFor("Outbox test");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ to_email: "buyer@example.com", sent_via: "outbox" });
    expect(rows[0]?.html).toContain("/r/abc123");
    expect(rows[0]?.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(getOutboxEmail(result.id)?.subject).toBe("Outbox test");
    expect(listOutbox(50).some((row) => row.id === result.id)).toBe(true);
    expect(listEmailsTo("BUYER@example.com").some((row) => row.id === result.id)).toBe(true);

    expect(mocks.send).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalled();
    const line = log.mock.calls.map((call) => call.map(String).join(" ")).find((text) => text.includes("EMAIL (outbox)"));
    expect(line).toContain("buyer@example.com");
    expect(line).toContain("Outbox test");
    expect(line).toContain("http://localhost:3000/r/abc123");
  });

  it("lists newest first and caps the list", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const first = await sendEmail({ to: "a@example.com", subject: "List one", html: "<p>1</p>" });
    db.prepare("UPDATE emails_outbox SET created_at = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", first.id);
    const second = await sendEmail({ to: "b@example.com", subject: "List two", html: "<p>2</p>" });
    const listed = listOutbox(1000);
    expect(listed[0]?.id).toBe(second.id);
    expect(listed[listed.length - 1]?.id).toBe(first.id);
    expect(listOutbox(1)).toHaveLength(1);
    expect(getOutboxEmail("missing")).toBeNull();
    expect(getOutboxEmail("")).toBeNull();
  });

  it("link helpers find http links in markup", () => {
    expect(firstHttpLink('<a href="https://a.example/x?y=1&amp;z=2">a</a> <a href="http://b.example">b</a>')).toBe(
      "https://a.example/x?y=1&amp;z=2",
    );
    expect(firstHttpLink("plain text http://c.example/path here")).toBe("http://c.example/path");
    expect(firstHttpLink("<p>nothing</p>")).toBeNull();
    expect(extractHttpLinks('<a href="https://a.example/x?y=1&amp;z=2">a</a><a href="https://a.example/x?y=1&amp;z=2">dup</a><a href="mailto:x@y">m</a><a href="http://b.example">b</a>')).toEqual([
      "https://a.example/x?y=1&z=2",
      "http://b.example",
    ]);
  });
});

describe("sendEmail with RESEND_API_KEY", () => {
  it("sends through Resend with the configured from address and records sent_via resend", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    config.resend.apiKey = "re_test_key";
    expect(config.emailOutbox).toBe(false);
    mocks.send.mockResolvedValueOnce({ data: { id: "email_1" }, error: null });

    const result = await sendEmail({ to: "buyer@example.com", subject: "Resend ok", html: "<p>ok</p>" });
    expect(result.sentVia).toBe("resend");
    expect(result.error).toBeNull();
    expect(mocks.constructed).toEqual(["re_test_key"]);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send.mock.calls[0]?.[0]).toEqual({
      from: config.resend.from,
      to: "buyer@example.com",
      subject: "Resend ok",
      html: "<p>ok</p>",
    });
    expect(rowsFor("Resend ok")[0]?.sent_via).toBe("resend");
  });

  it("never throws: an API error object falls back to an outbox row", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    config.resend.apiKey = "re_test_key";
    mocks.send.mockResolvedValueOnce({ data: null, error: { message: "Domain not verified", statusCode: 403, name: "validation_error" } });

    const result = await sendEmail({ to: "buyer@example.com", subject: "Resend api error", html: "<p>x</p>" });
    expect(result.sentVia).toBe("outbox");
    expect(result.error).toContain("Domain not verified");
    expect(rowsFor("Resend api error")[0]?.sent_via).toBe("outbox");
    expect(error).toHaveBeenCalled();
  });

  it("never throws: a rejected send falls back to an outbox row", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    config.resend.apiKey = "re_test_key";
    mocks.send.mockRejectedValueOnce(new Error("socket hang up"));

    await expect(sendEmail({ to: "buyer@example.com", subject: "Resend network error", html: "<p>x</p>" })).resolves.toMatchObject({
      sentVia: "outbox",
      error: "socket hang up",
    });
    expect(rowsFor("Resend network error")[0]?.sent_via).toBe("outbox");

    mocks.send.mockImplementationOnce(() => {
      throw new Error("sync explosion");
    });
    await expect(sendEmail({ to: "buyer@example.com", subject: "Resend sync error", html: "<p>x</p>" })).resolves.toMatchObject({
      sentVia: "outbox",
      error: "sync explosion",
    });
  });
});

describe("templates", () => {
  const narrative: Narrative = {
    executiveSummary: "Summary.",
    riskOverview: "Risk.",
    topPriorities: ["Images are missing alt text (2 pages)"],
    findings: [
      { ruleId: "image-alt", title: "Images are missing alt text", plainEnglish: "p", whyItMatters: "w", fixSteps: ["s"], beforeHtml: null, afterHtml: null, effort: "minutes" },
      { ruleId: "color-contrast", title: "Text is hard to read against its background", plainEnglish: "p", whyItMatters: "w", fixSteps: ["s"], beforeHtml: null, afterHtml: null, effort: "hours" },
      { ruleId: "label", title: "Form fields have no label", plainEnglish: "p", whyItMatters: "w", fixSteps: ["s"], beforeHtml: null, afterHtml: null, effort: "minutes" },
      { ruleId: "link-name", title: "Links have no text", plainEnglish: "p", whyItMatters: "w", fixSteps: ["s"], beforeHtml: null, afterHtml: null, effort: "minutes" },
    ],
    manualChecks: [{ title: "Keyboard", how: "Tab through." }],
    nextSteps: ["Fix the top 3."],
    generatedBy: "dictionary",
  };

  it("reportReady has the spec subject, the report link, the top 3 titles from the narrative, the re-scan date and the testimonial ask", () => {
    const created = makeAudit();
    db.prepare("UPDATE audits SET created_at = ? WHERE id = ?").run("2026-09-01T12:00:00.000Z", created.id);
    const audit = updateAudit(created.id, { status: "ready", narrative_json: JSON.stringify(narrative) });
    if (!audit) throw new Error("audit missing");
    insertFindings(audit.id, [
      finding(1, "image-alt", "Images must have alternate text"),
      finding(2, "color-contrast", "Elements must meet minimum color contrast ratio thresholds"),
      finding(3, "label", "Form elements must have labels"),
      finding(4, "link-name", "Links must have discernible text"),
    ]);

    const content = templates.reportReady(audit);
    expect(content.subject).toBe("Your accessibility audit is ready");
    expect(content.html).toContain(`${config.baseUrl}/r/${audit.token}`);
    expect(content.html).toContain("Images are missing alt text");
    expect(content.html).toContain("Text is hard to read against its background");
    expect(content.html).toContain("Form fields have no label");
    expect(content.html).not.toContain("Links have no text");
    expect(content.html).toContain("October 1, 2026");
    expect(content.html).toContain(templates.TESTIMONIAL_ASK.replace(/'/g, "&#39;"));
    expect(content.html).toContain(DISCLAIMER);
    expect(content.html).not.toMatch(/<img/i);
    expect(forbiddenWording(content.html)).toBeNull();

    // Explicit findings are honoured and the dictionary fills in when there is no narrative.
    const bare = updateAudit(audit.id, { narrative_json: null });
    if (!bare) throw new Error("audit missing");
    const fromDictionary = templates.reportReady(bare, [finding(1, "custom-rule", "Custom help text")]);
    expect(fromDictionary.html).toContain("Custom help text");
    expect(templates.topFindingTitles(bare, [])).toEqual([]);
  });

  it("reportReady for a re-scan explains the before/after and offers no further re-scan", () => {
    const original = makeAudit();
    const rescan = makeAudit({ rescan_of: original.id });
    const content = templates.reportReady(rescan, []);
    expect(content.subject).toBe("Your accessibility audit is ready");
    expect(content.html).toContain("before/after");
    expect(content.html).toContain(`/r/${rescan.token}`);
    expect(content.html).not.toContain("any time until");
    expect(forbiddenWording(content.html)).toBeNull();
  });

  it("inReview, creditCode and rescanReminder use the spec subjects and carry their links", () => {
    const audit = makeAudit({ tier: "reviewed" });
    db.prepare("UPDATE audits SET created_at = ? WHERE id = ?").run("2026-09-01T12:00:00.000Z", audit.id);
    const held = { ...audit, created_at: "2026-09-01T12:00:00.000Z", status: "held" as const };

    const review = templates.inReview(held);
    expect(review.subject).toBe("We're reviewing your audit by hand");
    expect(review.html).toContain(`${config.baseUrl}/r/${audit.token}`);
    expect(review.html).toContain("2 business days");
    expect(forbiddenWording(review.html)).toBeNull();

    const code = templates.creditCode(creditCodeRow, order);
    expect(code.subject).toBe("Your Agency 5-Pack code");
    expect(code.html).toContain("AA-7H3K-9PQR");
    expect(code.html).toContain(`${config.baseUrl}/credits/AA-7H3K-9PQR`);
    expect(code.html).toContain("Bright &amp; &lt;Pixel&gt; Studio");
    expect(code.html).not.toContain("<Pixel>");
    expect(code.html).toMatch(/redeem/i);
    expect(forbiddenWording(code.html)).toBeNull();

    const reminder = templates.rescanReminder(held);
    expect(reminder.subject).toBe("Your free re-scan expires in 5 days");
    expect(reminder.html).toContain(`${config.baseUrl}/r/${audit.token}`);
    expect(reminder.html).toContain("October 1, 2026");
    expect(forbiddenWording(reminder.html)).toBeNull();

    expect(templates.rescanDeadline({ created_at: "2026-09-01T12:00:00.000Z" }).toISOString()).toBe("2026-10-01T12:00:00.000Z");
    expect(templates.rescanDeadline({ created_at: "not a date" }).getTime()).toBeGreaterThan(Date.now());
  });

  it("templates never throw on sparse rows and produce full HTML documents", () => {
    const sparse = makeAudit({ url: "not a url", agency_name: null });
    for (const content of [templates.reportReady(sparse, []), templates.inReview(sparse), templates.rescanReminder(sparse)]) {
      expect(content.html.startsWith("<!DOCTYPE html>")).toBe(true);
      expect(content.html).toContain("</html>");
      expect(content.html).toContain(DISCLAIMER);
    }
  });
});
