// Orders: creation, lookup, pricing and the one place an order becomes paid.
// markPaid() is idempotent and runs inside a database transaction so a
// webhook, the success page and an admin click can all call it safely.

import { createAudit, getAudit } from "../audits.js";
import { FOUNDING_COUPON, PRODUCTS, config } from "../config.js";
import { db, nowIso } from "../db.js";
import { sendEmail } from "../email/send.js";
import { creditCode as creditCodeTemplate } from "../email/templates.js";
import { enqueueAudit } from "../jobs/runner.js";
import { track } from "../routes/funnel.js";
import type { AuditRow, CreditCodeRow, OrderRow, Product } from "../types.js";
import { HttpError } from "../util/http.js";
import { newId } from "../util/ids.js";
import { cancelCodeForOrder, createCreditCode, getCodeByOrder } from "./credits.js";

export interface CreateOrderInput {
  /** Optional caller-chosen id (the order route names the logo file after it before inserting). */
  id?: string;
  email: string;
  product: Product;
  url?: string | null;
  agency_name?: string | null;
  agency_logo_path?: string | null;
  coupon?: string | null;
  ip?: string | null;
  amount_cents: number;
  currency?: string;
}

export interface MarkPaidInfo {
  via: "mock" | "stripe" | "admin";
  sessionId?: string;
  paymentIntent?: string;
  /** What Stripe actually charged (session.amount_total), stored so records match the money collected. */
  amountCents?: number | null;
  /** Stripe's lowercase currency code for amountCents. */
  currency?: string | null;
}

export interface MarkPaidResult {
  order: OrderRow;
  audit?: AuditRow;
  creditCode?: CreditCodeRow;
}

export interface OrderAmount {
  amountCents: number;
  /** The coupon that will be stored on the order (null when none applied). */
  coupon: string | null;
  /** Set when the buyer typed a coupon that could not be applied; shown on the checkout page. */
  couponNotice: string | null;
}

export const PRODUCT_IDS: readonly Product[] = ["single", "reviewed", "pack5"];

/**
 * How long a pending FOUNDING50 order holds its seat. The Stripe Checkout
 * session for a founding order expires after the same window, so an abandoned
 * checkout releases the seat on both sides at about the same time.
 */
export const FOUNDING_HOLD_MINUTES = 60;

export function isProduct(value: unknown): value is Product {
  return typeof value === "string" && (PRODUCT_IDS as readonly string[]).includes(value);
}

const insertStmt = db.prepare(`
  INSERT INTO orders (id, created_at, email, product, status, amount_cents, currency, url, agency_name,
    agency_logo_path, coupon, ip)
  VALUES (@id, @created_at, @email, @product, 'pending', @amount_cents, @currency, @url, @agency_name,
    @agency_logo_path, @coupon, @ip)
`);
const getStmt = db.prepare("SELECT * FROM orders WHERE id = ?");
const getBySessionStmt = db.prepare("SELECT * FROM orders WHERE stripe_session_id = ? LIMIT 1");
const getByPaymentIntentStmt = db.prepare("SELECT * FROM orders WHERE stripe_payment_intent = ? LIMIT 1");
const listStmt = db.prepare("SELECT * FROM orders ORDER BY created_at DESC LIMIT ?");
// Refunded orders stay counted: Stripe never gives a coupon redemption back.
const countFoundingStmt = db.prepare("SELECT COUNT(*) AS n FROM orders WHERE coupon = ? AND status IN ('paid', 'refunded')");
const countFoundingHeldStmt = db.prepare("SELECT COUNT(*) AS n FROM orders WHERE coupon = ? AND status = 'pending' AND created_at > ?");
const setSessionStmt = db.prepare("UPDATE orders SET stripe_session_id = ? WHERE id = ?");
const markPaidStmt = db.prepare(`
  UPDATE orders SET status = 'paid', paid_via = @paid_via, paid_at = @paid_at,
    amount_cents = COALESCE(@amount_cents, amount_cents), currency = COALESCE(@currency, currency),
    stripe_session_id = COALESCE(@stripe_session_id, stripe_session_id),
    stripe_payment_intent = COALESCE(@stripe_payment_intent, stripe_payment_intent)
  WHERE id = @id
`);
const markRefundedStmt = db.prepare("UPDATE orders SET status = 'refunded' WHERE id = ?");
const auditForOrderStmt = db.prepare("SELECT * FROM audits WHERE order_id = ? ORDER BY created_at ASC LIMIT 1");

/** "$49", "$99.50": whole dollars unless there are cents. */
export function formatUsd(cents: number): string {
  const dollars = Math.floor(cents / 100);
  const rest = cents % 100;
  const whole = dollars.toLocaleString("en-US");
  return rest === 0 ? `$${whole}` : `$${whole}.${String(rest).padStart(2, "0")}`;
}

/** Orders that were paid with the founding coupon (refunded ones included, as on Stripe's side). */
export function countFoundingRedemptions(): number {
  const row = countFoundingStmt.get(FOUNDING_COUPON.code) as { n: number };
  return row.n;
}

/** Pending FOUNDING50 orders younger than FOUNDING_HOLD_MINUTES: seats held while the buyer is at checkout. */
export function countFoundingHeld(now: Date = new Date()): number {
  const cutoff = new Date(now.getTime() - FOUNDING_HOLD_MINUTES * 60 * 1000).toISOString();
  const row = countFoundingHeldStmt.get(FOUNDING_COUPON.code, cutoff) as { n: number };
  return row.n;
}

/**
 * The founding discount can only be honoured when checkout can apply it:
 * always in test mode, and with Stripe only when STRIPE_COUPON_FOUNDING is set.
 */
export function foundingOfferConfigured(): boolean {
  return config.mockPayments || Boolean(config.stripe.couponFounding);
}

/** Founding-offer seats still open (never negative; 0 when the offer cannot be applied at checkout). */
export function foundingLeft(): number {
  if (!foundingOfferConfigured()) return 0;
  return Math.max(0, FOUNDING_COUPON.maxRedemptions - countFoundingRedemptions() - countFoundingHeld());
}

/**
 * Price for a product plus an optional coupon. FOUNDING50 takes $50 off the
 * Agency 5-Pack while founding seats remain; any other input is ignored with
 * a notice for the checkout page. `seatsAvailable: false` (Stripe reports the
 * coupon as used up) is treated like a full count of seats.
 */
export function computeOrderAmount(
  product: Product,
  couponInput?: string | null,
  options: { seatsAvailable?: boolean } = {},
): OrderAmount {
  const base = PRODUCTS[product].amountCents;
  const typed = (couponInput ?? "").trim().toUpperCase();
  if (typed === "") return { amountCents: base, coupon: null, couponNotice: null };
  if (typed !== FOUNDING_COUPON.code) {
    return { amountCents: base, coupon: null, couponNotice: `We don't recognise the code "${typed}", so the regular price applies.` };
  }
  if (product !== FOUNDING_COUPON.appliesTo) {
    return {
      amountCents: base,
      coupon: null,
      couponNotice: `${FOUNDING_COUPON.code} only applies to the ${PRODUCTS.pack5.name}, so the regular price applies.`,
    };
  }
  if (!foundingOfferConfigured()) {
    return {
      amountCents: base,
      coupon: null,
      couponNotice: `The founding offer isn't available right now, so the regular price applies.`,
    };
  }
  if (options.seatsAvailable === false || foundingLeft() <= 0) {
    return {
      amountCents: base,
      coupon: null,
      couponNotice: `All ${FOUNDING_COUPON.maxRedemptions} founding seats are taken, so the regular price applies.`,
    };
  }
  return { amountCents: Math.max(0, base - FOUNDING_COUPON.amountOffCents), coupon: FOUNDING_COUPON.code, couponNotice: null };
}

export function createOrder(input: CreateOrderInput): OrderRow {
  if (!isProduct(input.product)) throw new HttpError(400, "Unknown product", "invalid_product");
  const id = input.id ?? newId();
  insertStmt.run({
    id,
    created_at: nowIso(),
    email: input.email,
    product: input.product,
    amount_cents: Math.round(input.amount_cents),
    currency: input.currency ?? "usd",
    url: input.url ?? null,
    agency_name: input.agency_name ?? null,
    agency_logo_path: input.agency_logo_path ?? null,
    coupon: input.coupon ?? null,
    ip: input.ip ?? null,
  });
  const row = getOrder(id);
  if (!row) throw new Error("order insert did not persist");
  return row;
}

export function getOrder(id: string): OrderRow | null {
  if (!id) return null;
  return (getStmt.get(id) as OrderRow | undefined) ?? null;
}

export function getOrderBySession(sessionId: string): OrderRow | null {
  if (!sessionId) return null;
  return (getBySessionStmt.get(sessionId) as OrderRow | undefined) ?? null;
}

export function getOrderByPaymentIntent(paymentIntent: string): OrderRow | null {
  if (!paymentIntent) return null;
  return (getByPaymentIntentStmt.get(paymentIntent) as OrderRow | undefined) ?? null;
}

export function listOrders(limit = 100): OrderRow[] {
  return listStmt.all(Math.max(1, Math.floor(limit))) as OrderRow[];
}

/** Remembers the Stripe Checkout session created for an order. */
export function setOrderSession(orderId: string, sessionId: string): void {
  setSessionStmt.run(sessionId, orderId);
}

/** The audit created when a single/reviewed order was paid (null before payment or for 5-Packs). */
export function auditForOrder(orderId: string): AuditRow | null {
  if (!orderId) return null;
  return (auditForOrderStmt.get(orderId) as AuditRow | undefined) ?? null;
}

const markRefundedTx = db.transaction((orderId: string): void => {
  markRefundedStmt.run(orderId);
  cancelCodeForOrder(orderId);
});

/**
 * Marks an order refunded (a full charge.refunded). Audits already created
 * keep running and stay available; a refunded 5-Pack's unused credits are
 * cancelled (Terms section 6). Nothing is deleted.
 */
export function markRefunded(orderId: string): OrderRow | null {
  markRefundedTx(orderId);
  return getOrder(orderId);
}

function existingResult(order: OrderRow): MarkPaidResult {
  const result: MarkPaidResult = { order };
  if (order.product === "pack5") {
    const code = getCodeByOrder(order.id);
    if (code) result.creditCode = code;
  } else {
    const audit = auditForOrder(order.id);
    if (audit) result.audit = audit;
  }
  return result;
}

const markPaidTx = db.transaction((orderId: string, info: MarkPaidInfo): { result: MarkPaidResult; changed: boolean } => {
  const order = getOrder(orderId);
  if (!order) throw new HttpError(404, "Order not found", "order_not_found");
  // Already paid (or paid then refunded): return what was created the first time.
  if (order.status !== "pending") return { result: existingResult(order), changed: false };

  const chargedCents = typeof info.amountCents === "number" && Number.isFinite(info.amountCents) ? Math.round(info.amountCents) : null;
  const chargedCurrency = typeof info.currency === "string" && info.currency.trim() !== "" ? info.currency.trim().toLowerCase() : null;
  if ((chargedCents !== null && chargedCents !== order.amount_cents) || (chargedCurrency !== null && chargedCurrency !== order.currency)) {
    console.warn(
      "markPaid: order %s was priced at %d %s but %s charged %d %s; storing the charged amount",
      order.id,
      order.amount_cents,
      order.currency,
      info.via,
      chargedCents ?? order.amount_cents,
      chargedCurrency ?? order.currency,
    );
  }
  markPaidStmt.run({
    id: order.id,
    paid_via: info.via,
    paid_at: nowIso(),
    amount_cents: chargedCents,
    currency: chargedCurrency,
    stripe_session_id: info.sessionId ?? null,
    stripe_payment_intent: info.paymentIntent ?? null,
  });
  const paid = getOrder(order.id);
  if (!paid) throw new Error("order vanished while marking paid");

  const result: MarkPaidResult = { order: paid };
  if (paid.product === "pack5") {
    result.creditCode = createCreditCode(paid);
  } else {
    if (!paid.url) throw new Error(`order ${paid.id} has no url`);
    const audit = createAudit({
      email: paid.email,
      url: paid.url,
      origin: new URL(paid.url).origin,
      page_limit: PRODUCTS[paid.product].pageLimit,
      white_label: 0,
      tier: paid.product,
      order_id: paid.id,
    });
    enqueueAudit(audit.id);
    result.audit = getAudit(audit.id) ?? audit;
  }
  return { result, changed: true };
});

function sendCreditCodeEmail(order: OrderRow, code: CreditCodeRow): void {
  try {
    const content = creditCodeTemplate(code, order);
    sendEmail({ to: order.email, subject: content.subject, html: content.html }).catch((err: unknown) => {
      console.error("markPaid: credit code email failed for order %s: %s", order.id, err instanceof Error ? err.message : String(err));
    });
  } catch (err) {
    console.error("markPaid: credit code email failed for order %s: %s", order.id, err instanceof Error ? err.message : String(err));
  }
}

/**
 * Marks an order paid exactly once. Inside one transaction: sets the paid
 * fields, then either issues the 5-Pack credit code or creates + enqueues the
 * audit. Calling it again returns the same audit/code and does nothing else.
 * After the transaction it sends the credit-code email (never throws) and
 * records the `paid` funnel event on the first call only.
 */
export function markPaid(orderId: string, info: MarkPaidInfo): MarkPaidResult {
  const { result, changed } = markPaidTx(orderId, info);
  if (changed) {
    track("paid", { order: result.order.id, product: result.order.product, via: info.via, amount_cents: result.order.amount_cents });
    if (result.creditCode) sendCreditCodeEmail(result.order, result.creditCode);
  }
  return result;
}
