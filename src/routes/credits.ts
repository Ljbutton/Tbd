// Agency 5-Pack credit pages.
//
//   GET  /credits/:code         agency name, credits left, audits started with the code, start form
//   POST /credits/:code/audit   redeem one credit and start a white-label audit

import express, { type Response } from "express";
import { rateLimit } from "express-rate-limit";
import { createAudit } from "../audits.js";
import { config } from "../config.js";
import { db } from "../db.js";
import { enqueueAudit } from "../jobs/runner.js";
import { auditsForCode, getCode, redeemCredit } from "../payments/credits.js";
import { getOrder } from "../payments/orders.js";
import { assertPublicUrl } from "../scan/ssrf.js";
import type { AuditRow, AuditStatus, CreditCodeRow } from "../types.js";
import { HttpError, asyncHandler } from "../util/http.js";
import { renderPage } from "../util/render.js";

export const router = express.Router();

const MAX_EMAIL = 254;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const AUDIT_STATUS_LABELS: Record<AuditStatus, string> = {
  queued: "Waiting in line",
  crawling: "Finding pages",
  scanning: "Scanning pages",
  writing: "Writing the report",
  rendering: "Building the PDF",
  held: "Being reviewed",
  ready: "Ready",
  failed: "Failed",
};

interface CreditFormValues {
  url: string;
  email: string;
}

type CreditFormErrors = Partial<Record<keyof CreditFormValues | "credits", string>>;

function field(body: unknown, name: string): string {
  if (typeof body !== "object" || body === null) return "";
  const value = (body as Record<string, unknown>)[name];
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === "string" ? first.trim() : "";
}

function loadCode(param: unknown): CreditCodeRow {
  const code = getCode(typeof param === "string" ? param : "");
  if (!code) {
    throw new HttpError(404, "We couldn't find that code. Check the email that came with your Agency 5-Pack.", "code_not_found");
  }
  return code;
}

async function renderCreditsPage(
  res: Response,
  code: CreditCodeRow,
  values: CreditFormValues,
  errors: CreditFormErrors,
  status = 200,
): Promise<void> {
  const audits = auditsForCode(code.id);
  await renderPage(
    res,
    "credits",
    {
      title: `${code.agency_name ?? "Agency"} credits`,
      code,
      audits,
      statusLabels: AUDIT_STATUS_LABELS,
      values,
      errors,
      hasErrors: Object.keys(errors).length > 0,
      pageLimit: config.pageLimitPack,
      buyMoreUrl: "/order?product=pack5",
    },
    status,
  );
}

const creditLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  handler: (_req, _res, next) => {
    next(new HttpError(429, "Too many audits started from this address in the last hour. Please try again later.", "rate_limited"));
  },
});

/** Takes one credit and creates + enqueues the audit atomically (a failed insert gives the credit back). */
const startCreditAudit = db.transaction((code: CreditCodeRow, url: URL, email: string): AuditRow => {
  const fresh = redeemCredit(code.code);
  const audit = createAudit({
    email,
    url: url.href,
    origin: url.origin,
    page_limit: config.pageLimitPack,
    white_label: 1,
    agency_name: fresh.agency_name,
    agency_logo_path: fresh.agency_logo_path,
    tier: "pack5",
    order_id: fresh.order_id,
    credit_code_id: fresh.id,
  });
  enqueueAudit(audit.id);
  return audit;
});

router.get(
  "/credits/:code",
  asyncHandler(async (req, res) => {
    const code = loadCode(req.params.code);
    const order = getOrder(code.order_id);
    await renderCreditsPage(res, code, { url: "", email: order?.email ?? "" }, {});
  }),
);

router.post(
  "/credits/:code/audit",
  creditLimiter,
  asyncHandler(async (req, res) => {
    const code = loadCode(req.params.code);
    const values: CreditFormValues = {
      url: field(req.body, "url").slice(0, 2048),
      email: field(req.body, "email").slice(0, MAX_EMAIL + 1),
    };
    const errors: CreditFormErrors = {};

    let target: URL | null = null;
    if (values.url === "") {
      errors.url = "Enter the website address you want audited.";
    } else {
      try {
        target = await assertPublicUrl(values.url);
      } catch (err) {
        if (err instanceof HttpError && err.status === 400) errors.url = err.message;
        else throw err;
      }
    }
    if (values.email === "") errors.email = "Enter the email address that should receive the report.";
    else if (values.email.length > MAX_EMAIL || !EMAIL_PATTERN.test(values.email)) errors.email = "That email address doesn't look right.";
    if (code.credits_left <= 0) errors.credits = "No credits left on this code. Buy another 5-Pack to keep going.";

    if (Object.keys(errors).length > 0 || target === null) {
      await renderCreditsPage(res, code, values, errors, 400);
      return;
    }

    let audit: AuditRow;
    try {
      audit = startCreditAudit(code, target, values.email);
    } catch (err) {
      // Lost a race for the last credit: the transaction rolled back, show the form again.
      if (err instanceof HttpError && err.code === "no_credits_left") {
        errors.credits = err.message;
        await renderCreditsPage(res, code, values, errors, 400);
        return;
      }
      throw err;
    }
    res.redirect(`/r/${audit.token}`);
  }),
);
