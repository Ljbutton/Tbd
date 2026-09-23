// One-time Stripe setup: creates the three products with one-time USD prices,
// the FOUNDING50 coupon and its promotion code, then prints the env lines to
// paste into .env. Safe to re-run: existing products (by name), prices (by
// amount), coupon and promotion code are reused instead of duplicated.
//
//   STRIPE_SECRET_KEY=sk_test_... npm run stripe:setup

import Stripe from "stripe";
import { FOUNDING_COUPON, PRODUCTS } from "../src/config.js";
import type { Product } from "../src/types.js";

try {
  process.loadEnvFile(".env");
} catch {
  // No .env file: rely on the shell environment.
}

const secretKey = (process.env.STRIPE_SECRET_KEY ?? "").trim();
if (secretKey === "") {
  console.error("STRIPE_SECRET_KEY is required (a test key like sk_test_... is fine). Add it to .env or the shell environment.");
  process.exit(1);
}

const stripe = new Stripe(secretKey);
const LIST_LIMIT = 500;

interface ProductPlan {
  id: Product;
  name: string;
  amountCents: number;
  envVar: string;
}

const PLANS: ProductPlan[] = [
  { id: "single", name: `AccessAudit ${PRODUCTS.single.name}`, amountCents: PRODUCTS.single.amountCents, envVar: "STRIPE_PRICE_SINGLE" },
  { id: "reviewed", name: `AccessAudit ${PRODUCTS.reviewed.name}`, amountCents: PRODUCTS.reviewed.amountCents, envVar: "STRIPE_PRICE_REVIEWED" },
  { id: "pack5", name: `AccessAudit ${PRODUCTS.pack5.name}`, amountCents: PRODUCTS.pack5.amountCents, envVar: "STRIPE_PRICE_PACK5" },
];

const DESCRIPTIONS: Record<Product, string> = {
  single: "Whole-site automated WCAG audit: up to 15 pages, desktop and mobile, PDF/JSON/CSV, one free re-scan.",
  reviewed: "Site Audit plus human keyboard, focus-order and screen-reader spot checks; delivered within 2 business days.",
  pack5: "Five white-label site audits (up to 30 pages each) for agencies, redeemable with one shared code.",
};

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
}

async function findOrCreateProduct(plan: ProductPlan): Promise<Stripe.Product> {
  const existing = await stripe.products.list({ active: true, limit: 100 }).autoPagingToArray({ limit: LIST_LIMIT });
  const found = existing.find((p) => p.name === plan.name);
  if (found) {
    console.log(`product "${plan.name}" exists (${found.id})`);
    return found;
  }
  const created = await stripe.products.create({
    name: plan.name,
    description: DESCRIPTIONS[plan.id],
    metadata: { accessaudit_product: plan.id },
  });
  console.log(`created product "${plan.name}" (${created.id})`);
  return created;
}

async function findOrCreatePrice(product: Stripe.Product, plan: ProductPlan): Promise<Stripe.Price> {
  const prices = await stripe.prices.list({ product: product.id, active: true, type: "one_time", limit: 100 }).autoPagingToArray({ limit: LIST_LIMIT });
  const found = prices.find((p) => p.currency === "usd" && p.unit_amount === plan.amountCents && p.recurring === null);
  if (found) {
    console.log(`price ${dollars(plan.amountCents)} for "${plan.name}" exists (${found.id})`);
    return found;
  }
  const created = await stripe.prices.create({
    product: product.id,
    currency: "usd",
    unit_amount: plan.amountCents,
    nickname: `${plan.name} ${dollars(plan.amountCents)}`,
  });
  console.log(`created price ${dollars(plan.amountCents)} for "${plan.name}" (${created.id})`);
  return created;
}

async function findOrCreateCoupon(): Promise<Stripe.Coupon> {
  const coupons = await stripe.coupons.list({ limit: 100 }).autoPagingToArray({ limit: LIST_LIMIT });
  const found = coupons.find(
    (c) => c.valid && c.name === FOUNDING_COUPON.code && c.amount_off === FOUNDING_COUPON.amountOffCents && c.currency === "usd",
  );
  if (found) {
    console.log(`coupon ${FOUNDING_COUPON.code} exists (${found.id})`);
    return found;
  }
  const created = await stripe.coupons.create({
    name: FOUNDING_COUPON.code,
    amount_off: FOUNDING_COUPON.amountOffCents,
    currency: "usd",
    duration: "once",
    max_redemptions: FOUNDING_COUPON.maxRedemptions,
  });
  console.log(`created coupon ${FOUNDING_COUPON.code} (${created.id}, ${dollars(FOUNDING_COUPON.amountOffCents)} off, max ${FOUNDING_COUPON.maxRedemptions} redemptions)`);
  return created;
}

async function findOrCreatePromotionCode(coupon: Stripe.Coupon): Promise<Stripe.PromotionCode> {
  const codes = await stripe.promotionCodes.list({ code: FOUNDING_COUPON.code, limit: 100 }).autoPagingToArray({ limit: LIST_LIMIT });
  const found = codes.find((c) => c.active);
  if (found) {
    console.log(`promotion code ${FOUNDING_COUPON.code} exists (${found.id})`);
    return found;
  }
  const created = await stripe.promotionCodes.create({
    promotion: { type: "coupon", coupon: coupon.id },
    code: FOUNDING_COUPON.code,
    max_redemptions: FOUNDING_COUPON.maxRedemptions,
  });
  console.log(`created promotion code ${FOUNDING_COUPON.code} (${created.id})`);
  return created;
}

async function main(): Promise<void> {
  const account = await stripe.accounts.retrieveCurrent();
  const mode = secretKey.startsWith("sk_live_") ? "LIVE" : "test";
  console.log(`Stripe account ${account.id} (${mode} mode)\n`);

  const envLines: string[] = [];
  for (const plan of PLANS) {
    const product = await findOrCreateProduct(plan);
    const price = await findOrCreatePrice(product, plan);
    envLines.push(`${plan.envVar}=${price.id}`);
  }
  const coupon = await findOrCreateCoupon();
  await findOrCreatePromotionCode(coupon);
  envLines.push(`STRIPE_COUPON_FOUNDING=${coupon.id}`);

  console.log("\nAdd these to your .env:\n");
  for (const line of envLines) console.log(line);
  console.log("\nThen run `stripe listen --forward-to localhost:3000/api/stripe/webhook` and copy the whsec_... into STRIPE_WEBHOOK_SECRET.");
}

main().catch((err: unknown) => {
  if (err instanceof Stripe.errors.StripeError) {
    console.error(`Stripe error (${err.type}): ${err.message}`);
  } else {
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  }
  process.exit(1);
});
