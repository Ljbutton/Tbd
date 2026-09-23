import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CreditCodeRow, OrderRow } from "../../src/types.js";
import type { HttpError } from "../../src/util/http.js";
import { useFreshDataDir } from "./helpers/data-dir.js";

// Email is another module's concern; record what markPaid would send.
const mocks = vi.hoisted(() => ({
  sendEmail: vi.fn<(msg: { to: string; subject: string; html: string }) => Promise<void>>(async () => {}),
  creditCode: vi.fn<(code: CreditCodeRow, order: OrderRow) => { subject: string; html: string }>((code) => ({
    subject: "Your Agency 5-Pack code",
    html: `<p>${code.code}</p>`,
  })),
}));
vi.mock("../../src/email/send.js", () => ({ sendEmail: mocks.sendEmail }));
vi.mock("../../src/email/templates.js", () => ({
  creditCode: mocks.creditCode,
  reportReady: vi.fn(),
  inReview: vi.fn(),
  rescanReminder: vi.fn(),
}));

useFreshDataDir("orders");
const { db } = await import("../../src/db.js");
const orders = await import("../../src/payments/orders.js");
const { getCodeByOrder } = await import("../../src/payments/credits.js");
const { funnelCounts } = await import("../../src/routes/funnel.js");
const { runnerStats } = await import("../../src/jobs/runner.js");

function singleOrder(overrides: Partial<Parameters<typeof orders.createOrder>[0]> = {}): OrderRow {
  return orders.createOrder({
    email: "buyer@example.com",
    product: "single",
    url: "https://example.com/shop",
    amount_cents: 4900,
    ip: "203.0.113.9",
    ...overrides,
  });
}

function pack5Order(overrides: Partial<Parameters<typeof orders.createOrder>[0]> = {}): OrderRow {
  return orders.createOrder({
    email: "agency@example.com",
    product: "pack5",
    agency_name: "Bright Pixel Studio",
    agency_logo_path: "/data/logos/logo.svg",
    coupon: "FOUNDING50",
    amount_cents: 9900,
    ...overrides,
  });
}

function jobsFor(auditId: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE ref_id = ?").get(auditId) as { n: number }).n;
}

beforeEach(() => {
  mocks.sendEmail.mockClear();
  mocks.creditCode.mockClear();
});

describe("createOrder / getOrder / listOrders", () => {
  it("stores a pending order with defaults and reads it back", () => {
    const order = singleOrder();
    expect(order.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(order.status).toBe("pending");
    expect(order.currency).toBe("usd");
    expect(order.amount_cents).toBe(4900);
    expect(order.url).toBe("https://example.com/shop");
    expect(order.agency_name).toBeNull();
    expect(order.coupon).toBeNull();
    expect(order.ip).toBe("203.0.113.9");
    expect(order.paid_at).toBeNull();
    expect(order.stripe_session_id).toBeNull();
    expect(orders.getOrder(order.id)).toEqual(order);
    expect(orders.getOrder("missing")).toBeNull();
    expect(orders.getOrder("")).toBeNull();
  });

  it("accepts a caller-chosen id and rejects unknown products", () => {
    const order = singleOrder({ id: "11111111-2222-4333-8444-555555555555" });
    expect(order.id).toBe("11111111-2222-4333-8444-555555555555");
    expect(() => orders.createOrder({ email: "x@example.com", product: "gold" as never, amount_cents: 1 })).toThrow(/Unknown product/);
    expect(orders.isProduct("pack5")).toBe(true);
    expect(orders.isProduct("gold")).toBe(false);
    expect(orders.isProduct(undefined)).toBe(false);
  });

  it("lists newest first and honours the limit", () => {
    const a = singleOrder();
    const b = pack5Order();
    db.prepare("UPDATE orders SET created_at = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", a.id);
    const listed = orders.listOrders(1000);
    expect(listed[0]?.id).toBe(b.id);
    expect(listed[listed.length - 1]?.id).toBe(a.id);
    expect(orders.listOrders(1)).toHaveLength(1);
  });

  it("setOrderSession / getOrderBySession / getOrderByPaymentIntent", () => {
    const order = singleOrder();
    orders.setOrderSession(order.id, "cs_test_123");
    expect(orders.getOrderBySession("cs_test_123")?.id).toBe(order.id);
    expect(orders.getOrderBySession("cs_test_nope")).toBeNull();
    expect(orders.getOrderBySession("")).toBeNull();
    orders.markPaid(order.id, { via: "stripe", sessionId: "cs_test_123", paymentIntent: "pi_123" });
    expect(orders.getOrderByPaymentIntent("pi_123")?.id).toBe(order.id);
    expect(orders.getOrderByPaymentIntent("pi_nope")).toBeNull();
  });
});

describe("pricing", () => {
  it("formatUsd prints whole dollars unless there are cents", () => {
    expect(orders.formatUsd(4900)).toBe("$49");
    expect(orders.formatUsd(9900)).toBe("$99");
    expect(orders.formatUsd(14900)).toBe("$149");
    expect(orders.formatUsd(4950)).toBe("$49.50");
    expect(orders.formatUsd(5)).toBe("$0.05");
    expect(orders.formatUsd(123456)).toBe("$1,234.56");
  });

  it("computeOrderAmount applies FOUNDING50 only to pack5 while seats remain", () => {
    expect(orders.computeOrderAmount("single")).toEqual({ amountCents: 4900, coupon: null, couponNotice: null });
    expect(orders.computeOrderAmount("reviewed", "")).toEqual({ amountCents: 19900, coupon: null, couponNotice: null });
    expect(orders.computeOrderAmount("pack5", null)).toEqual({ amountCents: 14900, coupon: null, couponNotice: null });

    const founding = orders.computeOrderAmount("pack5", " founding50 ");
    expect(founding).toEqual({ amountCents: 9900, coupon: "FOUNDING50", couponNotice: null });

    const wrongProduct = orders.computeOrderAmount("single", "FOUNDING50");
    expect(wrongProduct.amountCents).toBe(4900);
    expect(wrongProduct.coupon).toBeNull();
    expect(wrongProduct.couponNotice).toMatch(/only applies to the Agency 5-Pack/);

    const unknown = orders.computeOrderAmount("pack5", "SAVE10");
    expect(unknown.amountCents).toBe(14900);
    expect(unknown.coupon).toBeNull();
    expect(unknown.couponNotice).toMatch(/SAVE10/);
  });

  it("countFoundingRedemptions counts paid FOUNDING50 orders only and foundingLeft never goes negative", () => {
    const before = orders.countFoundingRedemptions();
    const pending = pack5Order();
    expect(orders.countFoundingRedemptions()).toBe(before);
    orders.markPaid(pending.id, { via: "mock" });
    expect(orders.countFoundingRedemptions()).toBe(before + 1);
    pack5Order({ coupon: null, amount_cents: 14900 });
    orders.markPaid(pack5Order({ coupon: null, amount_cents: 14900 }).id, { via: "mock" });
    expect(orders.countFoundingRedemptions()).toBe(before + 1);
    expect(orders.foundingLeft()).toBe(20 - (before + 1));

    const insert = db.prepare(
      "INSERT INTO orders (id, created_at, email, product, status, amount_cents, coupon) VALUES (?, ?, 'x@example.com', 'pack5', 'paid', 9900, 'FOUNDING50')",
    );
    const fill = db.transaction(() => {
      for (let i = 0; i < 25; i++) insert.run(`founding-fill-${i}`, "2026-01-01T00:00:00.000Z");
    });
    fill();
    expect(orders.foundingLeft()).toBe(0);
    const exhausted = orders.computeOrderAmount("pack5", "FOUNDING50");
    expect(exhausted.amountCents).toBe(14900);
    expect(exhausted.coupon).toBeNull();
    expect(exhausted.couponNotice).toMatch(/founding seats are taken/);
    db.prepare("DELETE FROM orders WHERE id LIKE 'founding-fill-%'").run();
  });
});

describe("markPaid", () => {
  it("single: sets paid fields, creates the audit and one job, tracks paid once, and is idempotent", () => {
    const order = singleOrder();
    const paidBefore = funnelCounts(30).paid;
    const queuedBefore = runnerStats().queued;

    const first = orders.markPaid(order.id, { via: "mock" });
    expect(first.order.status).toBe("paid");
    expect(first.order.paid_via).toBe("mock");
    expect(first.order.paid_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(first.creditCode).toBeUndefined();
    const audit = first.audit;
    expect(audit).toBeDefined();
    expect(audit?.order_id).toBe(order.id);
    expect(audit?.tier).toBe("single");
    expect(audit?.white_label).toBe(0);
    expect(audit?.page_limit).toBe(15);
    expect(audit?.url).toBe("https://example.com/shop");
    expect(audit?.origin).toBe("https://example.com");
    expect(audit?.email).toBe("buyer@example.com");
    expect(audit?.status).toBe("queued");
    expect(audit?.token).toHaveLength(22);
    expect(jobsFor(audit?.id ?? "")).toBe(1);
    expect(runnerStats().queued).toBe(queuedBefore + 1);
    expect(funnelCounts(30).paid).toBe(paidBefore + 1);
    expect(orders.auditForOrder(order.id)?.id).toBe(audit?.id);
    expect(mocks.sendEmail).not.toHaveBeenCalled();

    const second = orders.markPaid(order.id, { via: "admin" });
    expect(second.order.paid_via).toBe("mock");
    expect(second.audit?.id).toBe(audit?.id);
    expect(jobsFor(audit?.id ?? "")).toBe(1);
    expect(runnerStats().queued).toBe(queuedBefore + 1);
    expect(funnelCounts(30).paid).toBe(paidBefore + 1);
    expect((db.prepare("SELECT COUNT(*) AS n FROM audits WHERE order_id = ?").get(order.id) as { n: number }).n).toBe(1);
  });

  it("reviewed: audit tier is reviewed with the single-tier page limit", () => {
    const order = singleOrder({ product: "reviewed", amount_cents: 19900 });
    const result = orders.markPaid(order.id, { via: "admin" });
    expect(result.order.paid_via).toBe("admin");
    expect(result.audit?.tier).toBe("reviewed");
    expect(result.audit?.page_limit).toBe(15);
  });

  it("stripe: stores the session and payment intent and keeps an earlier session id when none is given", () => {
    const order = singleOrder();
    orders.setOrderSession(order.id, "cs_test_abc");
    const result = orders.markPaid(order.id, { via: "stripe", paymentIntent: "pi_abc" });
    expect(result.order.stripe_session_id).toBe("cs_test_abc");
    expect(result.order.stripe_payment_intent).toBe("pi_abc");
    const other = singleOrder();
    const withSession = orders.markPaid(other.id, { via: "stripe", sessionId: "cs_test_xyz", paymentIntent: "pi_xyz" });
    expect(withSession.order.stripe_session_id).toBe("cs_test_xyz");
    expect(withSession.order.stripe_payment_intent).toBe("pi_xyz");
  });

  it("pack5: issues a 5-credit code, emails it once, creates no audit, and is idempotent", () => {
    const order = pack5Order();
    const paidBefore = funnelCounts(30).paid;
    const first = orders.markPaid(order.id, { via: "mock" });
    expect(first.audit).toBeUndefined();
    const code = first.creditCode;
    expect(code).toBeDefined();
    expect(code?.code).toMatch(/^AA-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(code?.credits_total).toBe(5);
    expect(code?.credits_left).toBe(5);
    expect(code?.agency_name).toBe("Bright Pixel Studio");
    expect(code?.agency_logo_path).toBe("/data/logos/logo.svg");
    expect(getCodeByOrder(order.id)?.id).toBe(code?.id);
    expect((db.prepare("SELECT COUNT(*) AS n FROM audits WHERE order_id = ?").get(order.id) as { n: number }).n).toBe(0);
    expect(funnelCounts(30).paid).toBe(paidBefore + 1);

    expect(mocks.creditCode).toHaveBeenCalledTimes(1);
    expect(mocks.creditCode.mock.calls[0]?.[0].id).toBe(code?.id);
    expect(mocks.creditCode.mock.calls[0]?.[1].id).toBe(order.id);
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    expect(mocks.sendEmail.mock.calls[0]?.[0]).toMatchObject({ to: "agency@example.com", subject: "Your Agency 5-Pack code" });
    expect(mocks.sendEmail.mock.calls[0]?.[0].html).toContain(code?.code ?? "");

    const second = orders.markPaid(order.id, { via: "stripe", sessionId: "cs_1" });
    expect(second.creditCode?.id).toBe(code?.id);
    expect(second.order.paid_via).toBe("mock");
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    expect(funnelCounts(30).paid).toBe(paidBefore + 1);
    expect((db.prepare("SELECT COUNT(*) AS n FROM credit_codes WHERE order_id = ?").get(order.id) as { n: number }).n).toBe(1);
  });

  it("never lets an email failure break the payment", () => {
    mocks.sendEmail.mockRejectedValueOnce(new Error("resend down"));
    const rejected = orders.markPaid(pack5Order().id, { via: "mock" });
    expect(rejected.order.status).toBe("paid");
    expect(rejected.creditCode).toBeDefined();

    mocks.creditCode.mockImplementationOnce(() => {
      throw new Error("template broken");
    });
    const thrown = orders.markPaid(pack5Order().id, { via: "mock" });
    expect(thrown.order.status).toBe("paid");
    expect(thrown.creditCode).toBeDefined();
  });

  it("throws 404 for an unknown order and rolls back if the audit cannot be created", () => {
    let err: HttpError | null = null;
    try {
      orders.markPaid("does-not-exist", { via: "mock" });
    } catch (e) {
      err = e as HttpError;
    }
    expect(err?.status).toBe(404);
    expect(err?.code).toBe("order_not_found");

    const broken = singleOrder({ url: "not a url at all" });
    expect(() => orders.markPaid(broken.id, { via: "mock" })).toThrow();
    expect(orders.getOrder(broken.id)?.status).toBe("pending");
    expect(orders.auditForOrder(broken.id)).toBeNull();
  });

  it("markRefunded keeps the audit and a later markPaid does not create another", () => {
    const order = singleOrder();
    const paid = orders.markPaid(order.id, { via: "stripe", sessionId: "cs_r", paymentIntent: "pi_r" });
    const refunded = orders.markRefunded(order.id);
    expect(refunded?.status).toBe("refunded");
    expect(orders.auditForOrder(order.id)?.id).toBe(paid.audit?.id);
    const again = orders.markPaid(order.id, { via: "admin" });
    expect(again.order.status).toBe("refunded");
    expect(again.audit?.id).toBe(paid.audit?.id);
    expect(jobsFor(paid.audit?.id ?? "")).toBe(1);
  });
});
