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
const { getCodeByOrder, redeemCredit } = await import("../../src/payments/credits.js");
const { handleStripeEvent } = await import("../../src/routes/webhook.js");
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
    const leftBefore = orders.foundingLeft();
    const pending = pack5Order();
    expect(orders.countFoundingRedemptions()).toBe(before);
    // A fresh pending FOUNDING50 order holds its seat while the buyer is at checkout.
    expect(orders.foundingLeft()).toBe(leftBefore - 1);
    orders.markPaid(pending.id, { via: "mock" });
    expect(orders.countFoundingRedemptions()).toBe(before + 1);
    expect(orders.foundingLeft()).toBe(leftBefore - 1);
    pack5Order({ coupon: null, amount_cents: 14900 });
    orders.markPaid(pack5Order({ coupon: null, amount_cents: 14900 }).id, { via: "mock" });
    expect(orders.countFoundingRedemptions()).toBe(before + 1);
    expect(orders.foundingLeft()).toBe(20 - (before + 1) - orders.countFoundingHeld());

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

  it("a refund never gives a founding seat back, and a hold lapses after FOUNDING_HOLD_MINUTES", () => {
    const left = orders.foundingLeft();
    const paid = orders.markPaid(pack5Order().id, { via: "mock" }).order;
    expect(orders.foundingLeft()).toBe(left - 1);
    orders.markRefunded(paid.id);
    expect(orders.getOrder(paid.id)?.status).toBe("refunded");
    expect(orders.foundingLeft()).toBe(left - 1);

    const stale = pack5Order();
    expect(orders.foundingLeft()).toBe(left - 2);
    const lapsed = new Date(Date.now() - (orders.FOUNDING_HOLD_MINUTES + 1) * 60 * 1000).toISOString();
    db.prepare("UPDATE orders SET created_at = ? WHERE id = ?").run(lapsed, stale.id);
    expect(orders.foundingLeft()).toBe(left - 1);
  });

  it("the last seat goes to one buyer only, and Stripe reporting the coupon used up counts as no seats", () => {
    const insert = db.prepare(
      "INSERT INTO orders (id, created_at, email, product, status, amount_cents, coupon) VALUES (?, ?, 'x@example.com', 'pack5', 'paid', 9900, 'FOUNDING50')",
    );
    const fill = db.transaction((n: number) => {
      for (let i = 0; i < n; i++) insert.run(`seat-fill-${i}`, "2026-01-01T00:00:00.000Z");
    });
    fill(orders.foundingLeft() - 1);
    expect(orders.foundingLeft()).toBe(1);

    const first = orders.computeOrderAmount("pack5", "FOUNDING50");
    expect(first).toEqual({ amountCents: 9900, coupon: "FOUNDING50", couponNotice: null });
    pack5Order({ coupon: first.coupon, amount_cents: first.amountCents });
    const second = orders.computeOrderAmount("pack5", "FOUNDING50");
    expect(second.amountCents).toBe(14900);
    expect(second.coupon).toBeNull();
    expect(second.couponNotice).toMatch(/founding seats are taken/);
    db.prepare("DELETE FROM orders WHERE id LIKE 'seat-fill-%' OR (coupon = 'FOUNDING50' AND status = 'pending')").run();

    expect(orders.foundingLeft()).toBeGreaterThan(0);
    const stripeSaysNo = orders.computeOrderAmount("pack5", "FOUNDING50", { seatsAvailable: false });
    expect(stripeSaysNo.amountCents).toBe(14900);
    expect(stripeSaysNo.coupon).toBeNull();
    expect(stripeSaysNo.couponNotice).toMatch(/founding seats are taken/);
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

  it("stores the amount Stripe actually charged and keeps the priced amount when none is given", () => {
    const order = singleOrder({ product: "reviewed", amount_cents: 19900 });
    const paid = orders.markPaid(order.id, { via: "stripe", sessionId: "cs_amt", amountCents: 14900, currency: "USD" });
    expect(paid.order.amount_cents).toBe(14900);
    expect(paid.order.currency).toBe("usd");
    const mock = orders.markPaid(singleOrder().id, { via: "mock" });
    expect(mock.order.amount_cents).toBe(4900);
    const nulls = orders.markPaid(singleOrder().id, { via: "stripe", amountCents: null, currency: null });
    expect(nulls.order.amount_cents).toBe(4900);
    expect(nulls.order.currency).toBe("usd");
  });

  it("markRefunded cancels a 5-Pack's unused credits but keeps audits already started", () => {
    const order = pack5Order({ coupon: null, amount_cents: 14900 });
    const code = orders.markPaid(order.id, { via: "mock" }).creditCode;
    expect(code).toBeDefined();
    const redeemed = redeemCredit(code?.code ?? "");
    expect(redeemed.credits_left).toBe(4);
    orders.markRefunded(order.id);
    expect(getCodeByOrder(order.id)?.credits_left).toBe(0);
    let err: HttpError | null = null;
    try {
      redeemCredit(code?.code ?? "");
    } catch (e) {
      err = e as HttpError;
    }
    expect(err?.code).toBe("no_credits_left");
  });

  it("charge.refunded: a full refund refunds the order and cancels the code; a partial refund changes nothing", () => {
    const refundEvent = (orderId: string, amount: number, refunded: number) =>
      ({
        id: `evt_${refunded}`,
        type: "charge.refunded",
        data: { object: { id: "ch_1", amount, amount_refunded: refunded, refunded: refunded >= amount, payment_intent: null, metadata: { order_id: orderId } } },
      }) as unknown as Parameters<typeof handleStripeEvent>[0];

    const partial = pack5Order({ coupon: null, amount_cents: 14900 });
    orders.markPaid(partial.id, { via: "stripe", paymentIntent: "pi_partial" });
    handleStripeEvent(refundEvent(partial.id, 14900, 500));
    expect(orders.getOrder(partial.id)?.status).toBe("paid");
    expect(getCodeByOrder(partial.id)?.credits_left).toBe(5);

    const full = pack5Order({ coupon: null, amount_cents: 14900 });
    orders.markPaid(full.id, { via: "stripe", paymentIntent: "pi_full" });
    handleStripeEvent(refundEvent(full.id, 14900, 14900));
    expect(orders.getOrder(full.id)?.status).toBe("refunded");
    expect(getCodeByOrder(full.id)?.credits_left).toBe(0);

    const single = singleOrder();
    const paidSingle = orders.markPaid(single.id, { via: "stripe", paymentIntent: "pi_single" });
    handleStripeEvent(refundEvent(single.id, 4900, 4900));
    expect(orders.getOrder(single.id)?.status).toBe("refunded");
    expect(orders.auditForOrder(single.id)?.id).toBe(paidSingle.audit?.id);
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
