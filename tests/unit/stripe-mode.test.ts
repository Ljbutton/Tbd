import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import type { HttpError } from "../../src/util/http.js";
import { useFreshDataDir } from "./helpers/data-dir.js";

// Stripe mode with fake keys: config reads these at import time. Nothing here
// talks to Stripe; session creation and coupon lookups are stubbed on the
// shared client, and webhook payloads are signed locally with the SDK.
const STRIPE_ENV: Record<string, string> = {
  STRIPE_SECRET_KEY: "sk_test_unit",
  STRIPE_WEBHOOK_SECRET: "whsec_unit_secret",
  STRIPE_PRICE_SINGLE: "price_single",
  STRIPE_PRICE_REVIEWED: "price_reviewed",
  STRIPE_PRICE_PACK5: "price_pack5",
};
Object.assign(process.env, STRIPE_ENV);
delete process.env.STRIPE_COUPON_FOUNDING;
process.env.BASE_URL = "http://shop.test";
useFreshDataDir("stripe-mode");

const { createApp } = await import("../../src/server.js");
const { config } = await import("../../src/config.js");
const orders = await import("../../src/payments/orders.js");
const { getCodeByOrder } = await import("../../src/payments/credits.js");
const { createCheckoutSession, foundingCouponValid, getStripe } = await import("../../src/payments/stripe.js");

const stripe = getStripe();
const createSession = vi.spyOn(stripe.checkout.sessions, "create");
const retrieveCoupon = vi.spyOn(stripe.coupons, "retrieve");
const retrieveSession = vi.spyOn(stripe.checkout.sessions, "retrieve");

let baseUrl = "";
let server: ReturnType<ReturnType<typeof createApp>["listen"]>;

function packOrder(overrides: Partial<Parameters<typeof orders.createOrder>[0]> = {}) {
  return orders.createOrder({
    email: "agency@example.com",
    product: "pack5",
    agency_name: "Harbor Studio",
    amount_cents: 14900,
    ...overrides,
  });
}

function lastParams(): Stripe.Checkout.SessionCreateParams {
  const call = createSession.mock.calls[createSession.mock.calls.length - 1];
  return call?.[0] as Stripe.Checkout.SessionCreateParams;
}

async function postWebhook(event: Record<string, unknown>): Promise<Response> {
  const payload = JSON.stringify(event);
  const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: STRIPE_ENV.STRIPE_WEBHOOK_SECRET as string });
  return fetch(`${baseUrl}/api/stripe/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": signature },
    body: payload,
  });
}

async function postForm(pathname: string, fields: Record<string, string>): Promise<Response> {
  return fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
}

beforeAll(async () => {
  const app = createApp();
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const key of Object.keys(STRIPE_ENV)) delete process.env[key];
  vi.restoreAllMocks();
});

beforeEach(() => {
  config.stripe.couponFounding = undefined;
  createSession.mockReset();
  createSession.mockImplementation((async () => ({ id: `cs_test_${createSession.mock.calls.length}`, url: "https://checkout.stripe.com/c/pay/test" })) as never);
  retrieveCoupon.mockReset();
  retrieveCoupon.mockImplementation((async () => ({ id: "coupon_founding", valid: true })) as never);
  retrieveSession.mockReset();
  retrieveSession.mockImplementation((async (id: string) => ({ id, object: "checkout.session", payment_status: "unpaid", metadata: {} })) as never);
});

describe("createCheckoutSession", () => {
  it("never turns on Stripe's promotion-code box", async () => {
    const order = orders.createOrder({ email: "b@example.com", product: "reviewed", url: "https://example.com/", amount_cents: 19900 });
    await createCheckoutSession(order);
    const params = lastParams();
    expect(params.line_items).toEqual([{ price: "price_reviewed", quantity: 1 }]);
    expect(params.allow_promotion_codes).toBeUndefined();
    expect(params.discounts).toBeUndefined();
    expect(orders.getOrder(order.id)?.stripe_session_id).toMatch(/^cs_test_/);
  });

  it("refuses a founding order when STRIPE_COUPON_FOUNDING is missing instead of charging full price", async () => {
    const order = packOrder({ coupon: "FOUNDING50", amount_cents: 9900 });
    let err: HttpError | null = null;
    try {
      await createCheckoutSession(order);
    } catch (e) {
      err = e as HttpError;
    }
    expect(err?.status).toBe(500);
    expect(err?.code).toBe("stripe_coupon_missing");
    expect(err?.message).toContain("STRIPE_COUPON_FOUNDING is missing; run npm run stripe:setup");
    expect(createSession).not.toHaveBeenCalled();
  });

  it("applies the founding coupon server-side and expires the session with the seat hold", async () => {
    config.stripe.couponFounding = "coupon_founding";
    const order = packOrder({ coupon: "FOUNDING50", amount_cents: 9900 });
    const now = Math.floor(Date.now() / 1000);
    await createCheckoutSession(order);
    const params = lastParams();
    expect(params.discounts).toEqual([{ coupon: "coupon_founding" }]);
    expect(params.allow_promotion_codes).toBeUndefined();
    const hold = orders.FOUNDING_HOLD_MINUTES * 60;
    expect(params.expires_at).toBeGreaterThanOrEqual(now + hold - 5);
    expect(params.expires_at).toBeLessThanOrEqual(now + hold + 5);
  });
});

describe("founding offer in Stripe mode", () => {
  it("is hidden and not applied while STRIPE_COUPON_FOUNDING is unset", async () => {
    expect(orders.foundingOfferConfigured()).toBe(false);
    expect(orders.foundingLeft()).toBe(0);
    const amount = orders.computeOrderAmount("pack5", "FOUNDING50");
    expect(amount).toMatchObject({ amountCents: 14900, coupon: null });
    expect(amount.couponNotice).toMatch(/isn't available/);
    const form = await (await fetch(`${baseUrl}/order?product=pack5`)).text();
    expect(form).not.toContain("Founding offer");
  });

  it("asks Stripe whether the coupon is still valid", async () => {
    expect(await foundingCouponValid()).toBe(false); // no coupon id configured
    config.stripe.couponFounding = "coupon_founding";
    expect(await foundingCouponValid()).toBe(true);
    retrieveCoupon.mockImplementation((async () => ({ id: "coupon_founding", valid: false })) as never);
    expect(await foundingCouponValid()).toBe(false);
    retrieveCoupon.mockImplementation((async () => {
      throw new Error("network down");
    }) as never);
    expect(await foundingCouponValid()).toBe(true);
  });

  it("POST /order explains a coupon Stripe no longer honours before sending the buyer to checkout", async () => {
    config.stripe.couponFounding = "coupon_founding";
    retrieveCoupon.mockImplementation((async () => ({ id: "coupon_founding", valid: false })) as never);
    const fields = { product: "pack5", email: "late@example.com", agency_name: "Late Studio", coupon: "FOUNDING50", acknowledge: "1" };
    const before = orders.listOrders(1000).length;
    const res = await postForm("/order", fields);
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("founding seats are taken, so the regular price applies");
    expect(html).not.toContain("Founding offer");
    expect(orders.listOrders(1000).length).toBe(before);
    expect(createSession).not.toHaveBeenCalled();

    retrieveCoupon.mockImplementation((async () => ({ id: "coupon_founding", valid: true })) as never);
    const ok = await postForm("/order", fields);
    expect(ok.status).toBe(303);
    expect(ok.headers.get("location")).toBe("https://checkout.stripe.com/c/pay/test");
    const created = orders.listOrders(1)[0];
    expect(created).toMatchObject({ email: "late@example.com", coupon: "FOUNDING50", amount_cents: 9900 });
    expect(lastParams().discounts).toEqual([{ coupon: "coupon_founding" }]);
  });
});

describe("POST /api/stripe/webhook", () => {
  it("stores what Stripe charged when a checkout completes", async () => {
    const order = orders.createOrder({ email: "c@example.com", product: "single", url: "https://example.com/", amount_cents: 4900 });
    const res = await postWebhook({
      id: "evt_paid",
      object: "event",
      type: "checkout.session.completed",
      data: { object: { id: "cs_paid", object: "checkout.session", payment_status: "paid", amount_total: 4900, currency: "usd", payment_intent: "pi_paid", metadata: { order_id: order.id } } },
    });
    expect(res.status).toBe(200);
    expect(orders.getOrder(order.id)).toMatchObject({ status: "paid", amount_cents: 4900, stripe_payment_intent: "pi_paid" });
  });

  it("answers 200 to deliberate ignores and 500 when applying the event fails, so Stripe retries", async () => {
    const unknown = await postWebhook({
      id: "evt_unknown",
      object: "event",
      type: "checkout.session.completed",
      data: { object: { id: "cs_unknown", object: "checkout.session", payment_status: "paid", metadata: { order_id: "no-such-order" } } },
    });
    expect(unknown.status).toBe(200);

    const broken = orders.createOrder({ email: "d@example.com", product: "single", url: "not a url at all", amount_cents: 4900 });
    const res = await postWebhook({
      id: "evt_broken",
      object: "event",
      type: "checkout.session.completed",
      data: { object: { id: "cs_broken", object: "checkout.session", payment_status: "paid", metadata: { order_id: broken.id } } },
    });
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("webhook_handler_failed");
    expect(orders.getOrder(broken.id)?.status).toBe("pending");
  });

  it("a full refund of a 5-Pack cancels its code on the credits and success pages", async () => {
    const order = packOrder();
    const code = orders.markPaid(order.id, { via: "stripe", paymentIntent: "pi_pack" }).creditCode;
    expect(code).toBeDefined();
    const res = await postWebhook({
      id: "evt_refund",
      object: "event",
      type: "charge.refunded",
      data: { object: { id: "ch_pack", object: "charge", amount: 14900, amount_refunded: 14900, refunded: true, payment_intent: "pi_pack", metadata: {} } },
    });
    expect(res.status).toBe(200);
    expect(orders.getOrder(order.id)?.status).toBe("refunded");
    expect(getCodeByOrder(order.id)?.credits_left).toBe(0);

    const credits = await (await fetch(`${baseUrl}/credits/${code?.code}`)).text();
    expect(credits).toContain("This code was cancelled after a refund");
    expect(credits).not.toContain("Start audit (uses 1 credit)");
    const redeem = await postForm(`/credits/${code?.code}/audit`, { url: "https://example.com/", email: "agency@example.com" });
    expect(redeem.status).toBe(400);
    expect(await redeem.text()).toContain("This code was cancelled after a refund");

    const success = await (await fetch(`${baseUrl}/success?order=${order.id}`)).text();
    expect(success).toContain("This code was cancelled after a refund");
    expect(success).not.toContain("Start your first audit");
  });
});

describe("confirming a Stripe payment on /success", () => {
  it("polls a status endpoint instead of a timed <meta refresh> while the order is pending", async () => {
    const order = orders.createOrder({ email: "wait@example.com", product: "single", url: "https://example.com/", amount_cents: 4900 });
    const res = await fetch(`${baseUrl}/success?order=${order.id}&session_id=cs_wait`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Confirming your payment…");
    expect(html).not.toContain('http-equiv="refresh"');
    expect(html).toContain(`data-poll-url="/api/orders/${order.id}/status?session_id=cs_wait"`);
    expect(html).toContain('data-poll-interval="3000"');
    expect(html).toContain('data-poll-max="40"');
    expect(html).toContain(`<a href="/success?order=${order.id}&amp;session_id=cs_wait&amp;t=1">Check now</a>`);
    expect(retrieveSession).toHaveBeenCalledWith("cs_wait");

    // After the last attempt: no polling, the "check again" text is shown.
    const last = await (await fetch(`${baseUrl}/success?order=${order.id}&session_id=cs_wait&t=40`)).text();
    expect(last).not.toContain("data-poll-url");
    expect(last).not.toContain("Check now");
    expect(last).toMatch(/<p class="mb-0" data-poll-expired>/);
  });

  it("GET /api/orders/:id/status confirms with Stripe and reports ready once paid", async () => {
    const order = orders.createOrder({ email: "poll@example.com", product: "single", url: "https://example.com/", amount_cents: 4900 });
    const pending = await fetch(`${baseUrl}/api/orders/${order.id}/status?session_id=cs_poll`);
    expect(pending.status).toBe(200);
    expect(pending.headers.get("cache-control")).toBe("no-store");
    expect(await pending.json()).toEqual({ status: "pending", ready: false });

    // A session for another order never marks this one paid.
    retrieveSession.mockImplementation((async (id: string) => ({ id, object: "checkout.session", payment_status: "paid", amount_total: 4900, currency: "usd", payment_intent: "pi_other", metadata: { order_id: "someone-else" } })) as never);
    expect(await (await fetch(`${baseUrl}/api/orders/${order.id}/status?session_id=cs_poll`)).json()).toEqual({ status: "pending", ready: false });

    retrieveSession.mockImplementation((async (id: string) => ({ id, object: "checkout.session", payment_status: "paid", amount_total: 4900, currency: "usd", payment_intent: "pi_poll", metadata: { order_id: order.id } })) as never);
    const paid = await fetch(`${baseUrl}/api/orders/${order.id}/status?session_id=cs_poll`);
    expect(await paid.json()).toEqual({ status: "paid", ready: true });
    expect(orders.getOrder(order.id)).toMatchObject({ status: "paid", paid_via: "stripe", stripe_payment_intent: "pi_poll" });

    // Without a session id it only reads the stored status.
    const other = orders.createOrder({ email: "poll2@example.com", product: "single", url: "https://example.com/", amount_cents: 4900 });
    retrieveSession.mockClear();
    expect(await (await fetch(`${baseUrl}/api/orders/${other.id}/status`)).json()).toEqual({ status: "pending", ready: false });
    expect(retrieveSession).not.toHaveBeenCalled();
  });

  it("GET /api/orders/:id/status 404s as JSON for an unknown order", async () => {
    const res = await fetch(`${baseUrl}/api/orders/no-such-order/status`);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("order_not_found");
  });
});

describe("GET /cancel", () => {
  it("sends a paid order to its success page instead of saying nothing was billed", async () => {
    const order = orders.createOrder({ email: "e@example.com", product: "single", url: "https://example.com/", amount_cents: 4900 });
    const pending = await fetch(`${baseUrl}/cancel?order=${order.id}`, { redirect: "manual" });
    expect(pending.status).toBe(200);
    expect(await pending.text()).toContain("No charge was made.");
    orders.markPaid(order.id, { via: "admin" });
    const paid = await fetch(`${baseUrl}/cancel?order=${order.id}`, { redirect: "manual" });
    expect(paid.status).toBe(302);
    expect(paid.headers.get("location")).toBe(`/success?order=${order.id}`);
  });
});
