// Stripe Checkout integration. Only used when STRIPE_SECRET_KEY is set; in
// mock mode the order route never reaches this module.

import Stripe from "stripe";
import { FOUNDING_COUPON, config } from "../config.js";
import type { OrderRow, Product } from "../types.js";
import { HttpError } from "../util/http.js";
import { FOUNDING_HOLD_MINUTES, setOrderSession } from "./orders.js";

let client: Stripe | null = null;

/** Shared Stripe client (default API version of the installed SDK). */
export function getStripe(): Stripe {
  const key = config.stripe.secretKey;
  if (!key) {
    throw new HttpError(500, "Stripe is not configured: set STRIPE_SECRET_KEY or use test mode", "stripe_not_configured");
  }
  if (!client) client = new Stripe(key);
  return client;
}

const PRICE_ENV: Record<Product, string> = {
  single: "STRIPE_PRICE_SINGLE",
  reviewed: "STRIPE_PRICE_REVIEWED",
  pack5: "STRIPE_PRICE_PACK5",
};

/** The Stripe price id for a product, or a 500 pointing at `npm run stripe:setup`. */
export function priceIdFor(product: Product): string {
  const id =
    product === "single"
      ? config.stripe.priceSingle
      : product === "reviewed"
        ? config.stripe.priceReviewed
        : config.stripe.pricePack5;
  if (!id) {
    throw new HttpError(500, `Stripe is configured but ${PRICE_ENV[product]} is missing; run npm run stripe:setup`, "stripe_price_missing");
  }
  return id;
}

function describeStripeError(err: unknown): string {
  if (err instanceof Stripe.errors.StripeError) return `${err.type}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

/**
 * Whether Stripe still accepts the founding coupon (it stops being valid once
 * its redemptions are used up). True in test mode; false when the coupon id
 * is not configured. A lookup failure answers true and leaves the decision to
 * session creation, which fails loudly if the coupon really is gone.
 */
export async function foundingCouponValid(): Promise<boolean> {
  if (config.mockPayments) return true;
  const id = config.stripe.couponFounding;
  if (!id) return false;
  try {
    const coupon = await getStripe().coupons.retrieve(id);
    return coupon.valid;
  } catch (err) {
    console.error("stripe: could not look up coupon %s: %s", id, describeStripeError(err));
    return true;
  }
}

/**
 * Creates a one-time Checkout Session for a pending order and stores its id
 * on the order. The founding coupon is applied server-side when the order
 * earned it; no other discount exists, so Stripe's promotion-code box stays
 * off (a code typed there would bypass the product and seat checks). A
 * founding session expires when the order's seat hold ends.
 */
export async function createCheckoutSession(order: OrderRow): Promise<Stripe.Checkout.Session> {
  const stripe = getStripe();
  const price = priceIdFor(order.product);
  const metadata = { order_id: order.id, product: order.product };
  const founding = order.coupon === FOUNDING_COUPON.code;
  if (founding && !config.stripe.couponFounding) {
    // Never send a buyer to a Stripe page asking more than the order says.
    throw new HttpError(500, "Stripe is configured but STRIPE_COUPON_FOUNDING is missing; run npm run stripe:setup", "stripe_coupon_missing");
  }

  const params: Stripe.Checkout.SessionCreateParams = {
    mode: "payment",
    line_items: [{ price, quantity: 1 }],
    customer_email: order.email,
    metadata,
    // Copy the order id onto the PaymentIntent (and therefore its charges) so
    // charge.refunded webhooks can find the order without a session lookup.
    payment_intent_data: { metadata },
    success_url: `${config.baseUrl}/success?order=${encodeURIComponent(order.id)}&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${config.baseUrl}/cancel?order=${encodeURIComponent(order.id)}`,
  };
  if (founding) {
    params.discounts = [{ coupon: config.stripe.couponFounding as string }];
    params.expires_at = Math.floor(Date.now() / 1000) + FOUNDING_HOLD_MINUTES * 60;
  }

  let session: Stripe.Checkout.Session;
  try {
    session = await stripe.checkout.sessions.create(params);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(
      502,
      `Stripe could not start checkout (${describeStripeError(err)}). No charge was made; please try again in a moment.`,
      "stripe_checkout_failed",
    );
  }
  setOrderSession(order.id, session.id);
  return session;
}

/** Loads a Checkout Session so the success page can confirm payment without waiting for the webhook. */
export async function retrieveSession(id: string): Promise<Stripe.Checkout.Session> {
  return getStripe().checkout.sessions.retrieve(id);
}

/** The PaymentIntent id on a session, whether Stripe returned it expanded or as a string. */
export function paymentIntentIdOf(session: Pick<Stripe.Checkout.Session, "payment_intent">): string | undefined {
  const pi = session.payment_intent;
  if (typeof pi === "string") return pi;
  if (pi && typeof pi === "object" && typeof pi.id === "string") return pi.id;
  return undefined;
}
