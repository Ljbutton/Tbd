// POST /api/stripe/webhook
//
// Mounting contract (see server.ts): the app applies
//   express.raw({ type: "application/json" }) to /api/stripe/webhook
// and mounts this router at "/" BEFORE express.json(), so req.body is the raw
// Buffer that stripe.webhooks.constructEvent() verifies the signature over.
//
// Local testing: `stripe listen --forward-to localhost:3000/api/stripe/webhook`,
// copy the printed whsec_... into STRIPE_WEBHOOK_SECRET, pay with 4242 4242 4242 4242.
// `stripe trigger checkout.session.completed` carries no order_id metadata; the
// handler logs "no order_id in metadata, ignoring" and still answers 200.

import express from "express";
import type Stripe from "stripe";
import { config } from "../config.js";
import { getOrder, getOrderByPaymentIntent, markPaid, markRefunded } from "../payments/orders.js";
import { getStripe, paymentIntentIdOf } from "../payments/stripe.js";
import { HttpError, asyncHandler } from "../util/http.js";

export const router = express.Router();

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function handleCheckoutSession(session: Stripe.Checkout.Session, eventType: string): void {
  const orderId = session.metadata?.order_id;
  if (!orderId) {
    console.log("webhook %s: no order_id in metadata, ignoring (session %s)", eventType, session.id);
    return;
  }
  if (session.payment_status !== "paid") {
    console.log("webhook %s: session %s for order %s has payment_status=%s, waiting", eventType, session.id, orderId, session.payment_status);
    return;
  }
  try {
    const result = markPaid(orderId, { via: "stripe", sessionId: session.id, paymentIntent: paymentIntentIdOf(session) });
    console.log(
      "webhook %s: order %s paid (%s)",
      eventType,
      orderId,
      result.creditCode ? `credit code ${result.creditCode.code}` : result.audit ? `audit ${result.audit.id}` : "already processed",
    );
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) {
      console.warn("webhook %s: order %s not found, ignoring", eventType, orderId);
      return;
    }
    throw err;
  }
}

function handleChargeRefunded(charge: Stripe.Charge): void {
  const paymentIntent = typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id;
  const fromMetadata = charge.metadata?.order_id ? getOrder(charge.metadata.order_id) : null;
  const order = fromMetadata ?? (paymentIntent ? getOrderByPaymentIntent(paymentIntent) : null);
  if (!order) {
    console.log("webhook charge.refunded: no matching order for charge %s, ignoring", charge.id);
    return;
  }
  markRefunded(order.id);
  console.log(
    "webhook charge.refunded: order %s marked refunded (%d of %d cents refunded); any running audit continues",
    order.id,
    charge.amount_refunded,
    charge.amount,
  );
}

/** Applies one verified Stripe event. Unknown event types are ignored. */
export function handleStripeEvent(event: Stripe.Event): void {
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
      handleCheckoutSession(event.data.object, event.type);
      return;
    case "charge.refunded":
      handleChargeRefunded(event.data.object);
      return;
    default:
      return;
  }
}

router.post(
  "/api/stripe/webhook",
  asyncHandler(async (req, res) => {
    if (config.mockPayments) {
      res.status(503).json({ error: "stripe_not_configured", message: "Stripe is not configured; payments run in mock mode." });
      return;
    }
    const secret = config.stripe.webhookSecret;
    if (!secret) {
      res.status(500).json({ error: "webhook_secret_missing", message: "STRIPE_WEBHOOK_SECRET is not set." });
      return;
    }
    const header = req.headers["stripe-signature"];
    const signature = Array.isArray(header) ? header[0] : header;
    const payload = Buffer.isBuffer(req.body) ? req.body : typeof req.body === "string" ? req.body : null;
    if (!signature || payload === null) {
      res.status(400).json({ error: "invalid_signature", message: "Missing Stripe-Signature header or raw body." });
      return;
    }

    let event: Stripe.Event;
    try {
      event = getStripe().webhooks.constructEvent(payload, signature, secret);
    } catch (err) {
      console.warn("webhook: signature verification failed: %s", describe(err));
      res.status(400).json({ error: "invalid_signature", message: "Webhook signature verification failed." });
      return;
    }

    try {
      handleStripeEvent(event);
    } catch (err) {
      // Never make Stripe retry forever over a local bug: log loudly and acknowledge.
      console.error("webhook %s (%s) failed: %s", event.type, event.id, err instanceof Error ? err.stack ?? err.message : String(err));
    }
    res.status(200).json({ received: true });
  }),
);
