// Order form, mock checkout (test mode), success and cancel pages.
//
//   GET  /order?product=single|reviewed|pack5&url=   order form
//   POST /order                                      validate, create pending order, go to checkout
//   GET  /mock/checkout/:orderId                     simulated checkout (only when no Stripe key)
//   POST /mock/checkout/:orderId/pay|cancel
//   GET  /success?order=&session_id=                 confirms payment (Stripe session or mock), shows result
//   GET  /api/orders/:id/status?session_id=          JSON polled by public/app.js on the "confirming" page
//   GET  /cancel?order=

import fs from "node:fs";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import multer from "multer";
import { FOUNDING_COUPON, PRODUCTS, config, dataPaths } from "../config.js";
import { getCodeByOrder } from "../payments/credits.js";
import {
  auditForOrder,
  computeOrderAmount,
  createOrder,
  foundingLeft,
  formatUsd,
  getOrder,
  isProduct,
  markPaid,
} from "../payments/orders.js";
import { createCheckoutSession, foundingCouponValid, paymentIntentIdOf, retrieveSession } from "../payments/stripe.js";
import { assertPublicUrl } from "../scan/ssrf.js";
import type { OrderRow, Product } from "../types.js";
import { HttpError, asyncHandler } from "../util/http.js";
import { newId } from "../util/ids.js";
import { renderPage } from "../util/render.js";
import { track } from "./funnel.js";

export const router = express.Router();

export const MAX_LOGO_BYTES = 1024 * 1024;
export const MAX_AGENCY_NAME = 80;
const MAX_EMAIL = 254;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,255}$/;
/**
 * The "confirming" page polls the order status every 3 seconds for up to 2 minutes
 * (public/app.js, [data-poll-url]) and reloads once when the payment is confirmed.
 * No timed <meta refresh> (WCAG 2.2.1); without JavaScript the buyer uses "Check now",
 * whose ?t= counter stops offering it after the same number of attempts.
 */
const CONFIRM_MAX_ATTEMPTS = 40;
const CONFIRM_INTERVAL_SECONDS = 3;

const LOGO_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/svg+xml": "svg",
};

export interface ProductInfo {
  id: Product;
  name: string;
  amountCents: number;
  price: string;
  pageLimit: number;
  bullets: string[];
}

export function productInfo(product: Product): ProductInfo {
  const def = PRODUCTS[product];
  const bullets: Record<Product, string[]> = {
    single: [
      `Up to ${config.pageLimitSingle} pages, desktop and mobile`,
      "PDF + JSON + CSV",
      "Fixes from your own markup",
      "Dated remediation record",
      "1 free re-scan within 30 days",
    ],
    reviewed: [
      "Everything in Site Audit",
      "A human runs keyboard, focus-order and screen-reader spot checks",
      "Narrative edited by hand",
      "Delivered within 2 business days",
    ],
    pack5: [
      "5 audits, share the code with your team",
      `Up to ${config.pageLimitPack} pages per site`,
      "White-label PDF with your logo",
      "Re-scan included per audit",
      "Sells your $500-2,000 remediation projects",
    ],
  };
  return { id: product, name: def.name, amountCents: def.amountCents, price: formatUsd(def.amountCents), pageLimit: def.pageLimit, bullets: bullets[product] };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function field(body: unknown, name: string): string {
  if (typeof body !== "object" || body === null) return "";
  const value = (body as Record<string, unknown>)[name];
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === "string" ? first.trim() : "";
}

function queryString(value: unknown): string {
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === "string" ? first.trim() : "";
}

function parseProduct(value: unknown, fallback: Product | null): Product {
  const text = queryString(value);
  if (text === "" && fallback) return fallback;
  if (isProduct(text)) return text;
  throw new HttpError(400, "Choose a product: single, reviewed or pack5.", "invalid_product");
}

function isValidEmail(email: string): boolean {
  return email.length <= MAX_EMAIL && EMAIL_PATTERN.test(email);
}

function requireMockMode(): void {
  if (!config.mockPayments) {
    throw new HttpError(404, "Mock checkout is only available in test mode (no Stripe key configured).", "not_found");
  }
}

function loadOrder(id: string): OrderRow {
  const order = getOrder(id);
  if (!order) throw new HttpError(404, "We couldn't find that order. Check the link in your receipt email.", "order_not_found");
  return order;
}

export interface OrderFormValues {
  url: string;
  email: string;
  agency_name: string;
  coupon: string;
  acknowledge: boolean;
}

export type OrderFormErrors = Partial<Record<keyof OrderFormValues | "agency_logo", string>>;

async function renderOrderForm(
  res: Response,
  product: Product,
  values: OrderFormValues,
  errors: OrderFormErrors,
  status = 200,
  options: { seatsAvailable?: boolean } = {},
): Promise<void> {
  const info = productInfo(product);
  await renderPage(
    res,
    "order",
    {
      title: `Order ${info.name}`,
      product: info,
      values,
      errors,
      hasErrors: Object.keys(errors).length > 0,
      foundingLeft: options.seatsAvailable === false ? 0 : foundingLeft(),
      foundingCode: FOUNDING_COUPON.code,
      foundingPrice: formatUsd(PRODUCTS.pack5.amountCents - FOUNDING_COUPON.amountOffCents),
      maxLogoMb: Math.round(MAX_LOGO_BYTES / (1024 * 1024)),
      maxAgencyName: MAX_AGENCY_NAME,
    },
    status,
  );
}

// ---------------------------------------------------------------------------
// Logo upload (multipart only; plain form posts pass straight through)
// ---------------------------------------------------------------------------

/** Per-request upload problems that should re-render the form instead of erroring. */
const uploadProblems = new WeakMap<Request, string>();

const logoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_LOGO_BYTES, files: 1, fields: 20, fieldSize: 10 * 1024 },
  fileFilter: (req, file, callback) => {
    if (LOGO_EXTENSIONS[file.mimetype] !== undefined) {
      callback(null, true);
      return;
    }
    uploadProblems.set(req, "The logo must be a PNG, JPG or SVG file.");
    callback(null, false);
  },
}).single("agency_logo");

function acceptLogo(req: Request, res: Response, next: NextFunction): void {
  logoUpload(req, res, (err: unknown) => {
    if (!err) {
      next();
      return;
    }
    if (err instanceof multer.MulterError) {
      uploadProblems.set(
        req,
        err.code === "LIMIT_FILE_SIZE"
          ? `That logo is too large. Logos must be ${Math.round(MAX_LOGO_BYTES / (1024 * 1024))} MB or smaller.`
          : "That upload could not be accepted. Try a PNG, JPG or SVG under 1 MB.",
      );
      next();
      return;
    }
    next(err);
  });
}

// ---------------------------------------------------------------------------
// Rate limit: 20 order attempts per hour per IP
// ---------------------------------------------------------------------------

const orderLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  handler: (_req, _res, next) => {
    next(new HttpError(429, "Too many checkout attempts from this address in the last hour. Please try again later.", "rate_limited"));
  },
});

// The confirming page polls every 3s (20/min per open tab); each poll of a pending
// Stripe order can call Stripe, so cap it per IP.
const orderStatusLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  handler: (_req, _res, next) => {
    next(new HttpError(429, "Too many status checks from this address. Please wait a minute.", "rate_limited"));
  },
});

// ---------------------------------------------------------------------------
// GET /order
// ---------------------------------------------------------------------------

router.get(
  "/order",
  asyncHandler(async (req, res) => {
    const product = parseProduct(req.query.product, "single");
    await renderOrderForm(res, product, {
      url: queryString(req.query.url).slice(0, 2048),
      email: "",
      agency_name: "",
      coupon: "",
      acknowledge: false,
    }, {});
  }),
);

// ---------------------------------------------------------------------------
// POST /order
// ---------------------------------------------------------------------------

router.post(
  "/order",
  orderLimiter,
  acceptLogo,
  asyncHandler(async (req, res) => {
    const product = parseProduct(field(req.body, "product"), null);
    const values: OrderFormValues = {
      url: field(req.body, "url").slice(0, 2048),
      email: field(req.body, "email").slice(0, MAX_EMAIL + 1),
      agency_name: field(req.body, "agency_name").slice(0, MAX_AGENCY_NAME + 1),
      coupon: product === "pack5" ? field(req.body, "coupon").slice(0, 40) : "",
      acknowledge: field(req.body, "acknowledge") !== "",
    };
    const errors: OrderFormErrors = {};

    let validatedUrl: URL | null = null;
    if (product === "pack5") {
      if (values.agency_name === "") errors.agency_name = "Enter your agency name; it goes on every white-label report.";
      else if (values.agency_name.length > MAX_AGENCY_NAME) errors.agency_name = `Keep the agency name to ${MAX_AGENCY_NAME} characters.`;
    } else {
      if (values.url === "") {
        errors.url = "Enter the website address you want audited.";
      } else {
        try {
          validatedUrl = await assertPublicUrl(values.url);
        } catch (err) {
          if (err instanceof HttpError && err.status === 400) errors.url = err.message;
          else throw err;
        }
      }
    }
    if (values.email === "") errors.email = "Enter the email address that should receive the report.";
    else if (!isValidEmail(values.email)) errors.email = "That email address doesn't look right.";
    if (!values.acknowledge) errors.acknowledge = "Please confirm you understand what this audit is and isn't.";

    const uploadProblem = uploadProblems.get(req);
    if (uploadProblem) errors.agency_logo = uploadProblem;

    if (Object.keys(errors).length > 0) {
      await renderOrderForm(res, product, values, errors, 400);
      return;
    }

    // Ask Stripe whether the founding coupon still has redemptions left before
    // pricing the order; the count-and-insert below then runs without an await,
    // so two buyers cannot both take the last seat.
    const wantsFounding = product === "pack5" && values.coupon.trim().toUpperCase() === FOUNDING_COUPON.code;
    const seatsAvailable = wantsFounding && !config.mockPayments ? await foundingCouponValid() : undefined;
    const amount = computeOrderAmount(product, values.coupon, { seatsAvailable });
    if (amount.couponNotice && !config.mockPayments) {
      // Stripe's page only shows the total, so explain the price change here and
      // let the buyer continue at the regular price (the test checkout shows it instead).
      errors.coupon = amount.couponNotice;
      values.coupon = "";
      await renderOrderForm(res, product, values, errors, 400, { seatsAvailable });
      return;
    }

    const orderId = newId();
    let logoPath: string | null = null;
    const file = product === "pack5" ? req.file : undefined;
    if (file) {
      const ext = LOGO_EXTENSIONS[file.mimetype];
      if (ext === undefined) {
        errors.agency_logo = "The logo must be a PNG, JPG or SVG file.";
        await renderOrderForm(res, product, values, errors, 400);
        return;
      }
      fs.mkdirSync(dataPaths().logos, { recursive: true });
      logoPath = path.join(dataPaths().logos, `${orderId}.${ext}`);
      fs.writeFileSync(logoPath, file.buffer);
    }

    let order: OrderRow;
    try {
      order = createOrder({
        id: orderId,
        email: values.email,
        product,
        url: product === "pack5" ? null : validatedUrl?.href ?? values.url,
        agency_name: product === "pack5" ? values.agency_name : null,
        agency_logo_path: logoPath,
        coupon: amount.coupon,
        ip: req.ip ?? null,
        amount_cents: amount.amountCents,
      });
    } catch (err) {
      if (logoPath) fs.rmSync(logoPath, { force: true });
      throw err;
    }
    track("checkout_start", { order: order.id, product, amount_cents: order.amount_cents, coupon: order.coupon });

    if (config.mockPayments) {
      const notice = amount.couponNotice ? `?notice=${encodeURIComponent(amount.couponNotice)}` : "";
      res.redirect(`/mock/checkout/${order.id}${notice}`);
      return;
    }
    const session = await createCheckoutSession(order);
    if (!session.url) {
      throw new HttpError(502, "Stripe did not return a checkout page. No charge was made; please try again.", "stripe_checkout_failed");
    }
    res.redirect(303, session.url);
  }),
);

// ---------------------------------------------------------------------------
// Mock checkout (test mode only)
// ---------------------------------------------------------------------------

router.get(
  "/mock/checkout/:orderId",
  asyncHandler(async (req, res) => {
    requireMockMode();
    const order = loadOrder(String(req.params.orderId));
    if (order.status !== "pending") {
      res.redirect(`/success?order=${encodeURIComponent(order.id)}`);
      return;
    }
    const info = productInfo(order.product);
    const discount = info.amountCents - order.amount_cents;
    await renderPage(res, "mock-checkout", {
      title: "Test checkout",
      order,
      product: info,
      listPrice: formatUsd(info.amountCents),
      discount: discount > 0 ? formatUsd(discount) : null,
      total: formatUsd(order.amount_cents),
      notice: queryString(req.query.notice).slice(0, 300),
    });
  }),
);

router.post(
  "/mock/checkout/:orderId/pay",
  asyncHandler(async (req, res) => {
    requireMockMode();
    const order = loadOrder(String(req.params.orderId));
    markPaid(order.id, { via: "mock" });
    res.redirect(`/success?order=${encodeURIComponent(order.id)}`);
  }),
);

router.post(
  "/mock/checkout/:orderId/cancel",
  asyncHandler(async (req, res) => {
    requireMockMode();
    const order = loadOrder(String(req.params.orderId));
    res.redirect(`/cancel?order=${encodeURIComponent(order.id)}`);
  }),
);

// ---------------------------------------------------------------------------
// GET /success
// ---------------------------------------------------------------------------

async function confirmWithStripe(order: OrderRow, sessionId: string): Promise<OrderRow> {
  try {
    const session = await retrieveSession(sessionId);
    if (session.payment_status === "paid" && session.metadata?.order_id === order.id) {
      const result = markPaid(order.id, {
        via: "stripe",
        sessionId: session.id,
        paymentIntent: paymentIntentIdOf(session),
        amountCents: session.amount_total,
        currency: session.currency,
      });
      return result.order;
    }
    if (session.metadata?.order_id !== order.id) {
      console.warn("success: session %s does not belong to order %s, ignoring", sessionId, order.id);
    }
  } catch (err) {
    console.error("success: could not verify Stripe session %s: %s", sessionId, err instanceof Error ? err.message : String(err));
  }
  return order;
}

function sessionIdFrom(value: unknown): string {
  const raw = queryString(value);
  return SESSION_ID_PATTERN.test(raw) ? raw : "";
}

/** A pending Stripe order with a checkout session id is checked against Stripe directly (the webhook may lag). */
async function currentOrder(order: OrderRow, sessionId: string): Promise<OrderRow> {
  if (order.status === "pending" && !config.mockPayments && sessionId !== "") {
    return confirmWithStripe(order, sessionId);
  }
  return order;
}

router.get(
  "/success",
  asyncHandler(async (req, res) => {
    const sessionId = sessionIdFrom(req.query.session_id);
    const order = await currentOrder(loadOrder(queryString(req.query.order)), sessionId);

    const info = productInfo(order.product);
    if (order.status === "pending") {
      const attempt = Math.min(CONFIRM_MAX_ATTEMPTS, Math.max(0, Math.floor(Number(queryString(req.query.t)) || 0)));
      const refreshing = attempt < CONFIRM_MAX_ATTEMPTS;
      const params = new URLSearchParams({ order: order.id });
      if (sessionId !== "") params.set("session_id", sessionId);
      params.set("t", String(attempt + 1));
      const nextUrl = `/success?${params.toString()}`;
      const statusQuery = sessionId !== "" ? `?${new URLSearchParams({ session_id: sessionId }).toString()}` : "";
      await renderPage(res, "success", {
        title: "Confirming your payment",
        state: "confirming",
        order,
        product: info,
        refreshing,
        refreshUrl: nextUrl,
        pollUrl: refreshing ? `/api/orders/${encodeURIComponent(order.id)}/status${statusQuery}` : null,
        pollIntervalMs: CONFIRM_INTERVAL_SECONDS * 1000,
        pollMaxTicks: CONFIRM_MAX_ATTEMPTS,
        mockCheckoutUrl: config.mockPayments ? `/mock/checkout/${order.id}` : null,
        audit: null,
        creditCode: null,
      });
      return;
    }

    const audit = order.product === "pack5" ? null : auditForOrder(order.id);
    const creditCode = order.product === "pack5" ? getCodeByOrder(order.id) : null;
    await renderPage(res, "success", {
      title:
        order.product === "pack5"
          ? order.status === "refunded"
            ? "5-Pack refunded"
            : "Your 5-Pack is ready"
          : audit?.status === "failed"
            ? "Your audit could not be completed"
            : "Your audit is running",
      state: order.status === "refunded" ? "refunded" : "paid",
      order,
      product: info,
      refreshing: false,
      refreshUrl: null,
      pollUrl: null,
      mockCheckoutUrl: null,
      audit,
      creditCode,
      total: formatUsd(order.amount_cents),
    });
  }),
);

// ---------------------------------------------------------------------------
// GET /api/orders/:id/status
// ---------------------------------------------------------------------------

/** Polled by the "confirming" page; `ready` flips once the order is no longer pending. */
router.get(
  "/api/orders/:id/status",
  orderStatusLimiter,
  asyncHandler(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const order = await currentOrder(loadOrder(String(req.params.id)), sessionIdFrom(req.query.session_id));
    res.json({ status: order.status, ready: order.status !== "pending" });
  }),
);

// ---------------------------------------------------------------------------
// GET /cancel
// ---------------------------------------------------------------------------

router.get(
  "/cancel",
  asyncHandler(async (req, res) => {
    const order = getOrder(queryString(req.query.order));
    if (order && order.status !== "pending") {
      // Paid (or refunded) already, e.g. the cancel link reopened from history: show the real state.
      res.redirect(`/success?order=${encodeURIComponent(order.id)}`);
      return;
    }
    const product: Product = order ? order.product : "single";
    const params = new URLSearchParams({ product });
    if (order?.url) params.set("url", order.url);
    await renderPage(res, "cancel", {
      title: "Checkout cancelled",
      order,
      product: productInfo(product),
      retryUrl: `/order?${params.toString()}`,
    });
  }),
);
