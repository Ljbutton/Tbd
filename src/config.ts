import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// In end-to-end runs every third-party integration must be off, regardless of
// what the developer's shell happens to export. Strip the keys before the
// config object is built so the mode getters see a clean environment.
if (process.env.E2E === "1") {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("STRIPE_")) delete process.env[key];
  }
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.RESEND_API_KEY;
}

/** Treat unset and blank values the same so `STRIPE_SECRET_KEY=` still means mock mode. */
function optional(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function numberOr(value: string | undefined, fallback: number): number {
  const parsed = Number(optional(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const nodeEnv = process.env.NODE_ENV ?? "development";
const port = numberOr(process.env.PORT, 3000);

/** Absolute path of the repository root (the directory holding package.json, views/, public/). */
export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const config = {
  port,
  baseUrl: (optional(process.env.BASE_URL) ?? `http://localhost:${port}`).replace(/\/$/, ""),
  dataDir: path.resolve(optional(process.env.DATA_DIR) ?? "./data"),
  nodeEnv,
  stripe: {
    secretKey: optional(process.env.STRIPE_SECRET_KEY),
    webhookSecret: optional(process.env.STRIPE_WEBHOOK_SECRET),
    priceSingle: optional(process.env.STRIPE_PRICE_SINGLE),
    priceReviewed: optional(process.env.STRIPE_PRICE_REVIEWED),
    pricePack5: optional(process.env.STRIPE_PRICE_PACK5),
    couponFounding: optional(process.env.STRIPE_COUPON_FOUNDING),
  },
  anthropic: {
    apiKey: optional(process.env.ANTHROPIC_API_KEY),
    model: optional(process.env.ANTHROPIC_MODEL) ?? "claude-opus-5",
  },
  resend: {
    apiKey: optional(process.env.RESEND_API_KEY),
    from: optional(process.env.EMAIL_FROM) ?? "AccessAudit <reports@example.com>",
  },
  adminPassword: optional(process.env.ADMIN_PASSWORD) ?? (nodeEnv === "production" ? null : "admin"),
  allowPrivateTargets: process.env.ALLOW_PRIVATE_TARGETS === "1",
  pageLimitSingle: numberOr(process.env.PAGE_LIMIT_SINGLE, 15),
  pageLimitPack: numberOr(process.env.PAGE_LIMIT_PACK, 30),
  auditTimeoutMs: numberOr(process.env.AUDIT_TIMEOUT_MS, 720000),
  teaserRateLimit: numberOr(process.env.TEASER_RATE_LIMIT, 5),
  /** True when no Stripe key is set: checkout goes through /mock/checkout. */
  get mockPayments(): boolean {
    return !this.stripe.secretKey;
  },
  /** True when no Anthropic key is set: narratives come from the built-in dictionary. */
  get mockLlm(): boolean {
    return !this.anthropic.apiKey;
  },
  /** True when no Resend key is set: emails are stored in the emails_outbox table. */
  get emailOutbox(): boolean {
    return !this.resend.apiKey;
  },
};

export type Config = typeof config;

export const PRODUCTS = {
  single: { name: "Site Audit", amountCents: 4900, pageLimit: config.pageLimitSingle, whiteLabel: false },
  reviewed: { name: "Reviewed Audit", amountCents: 19900, pageLimit: config.pageLimitSingle, whiteLabel: false },
  pack5: { name: "Agency 5-Pack", amountCents: 14900, pageLimit: config.pageLimitPack, whiteLabel: true, credits: 5 },
} as const;

export type ProductId = keyof typeof PRODUCTS;

export const FOUNDING_COUPON = {
  code: "FOUNDING50",
  amountOffCents: 5000,
  maxRedemptions: 20,
  appliesTo: "pack5",
} as const;

/** Directories the app writes to. Created at boot by ensureDirs(). */
export function dataPaths(): { root: string; audits: string; logos: string } {
  return {
    root: config.dataDir,
    audits: path.join(config.dataDir, "audits"),
    logos: path.join(config.dataDir, "logos"),
  };
}

/** Creates dataDir, dataDir/audits and dataDir/logos (idempotent). Call once at boot. */
export function ensureDirs(): void {
  const paths = dataPaths();
  for (const dir of [paths.root, paths.audits, paths.logos]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** The three startup log lines: which integrations are live and which are mocked. */
export function modeLines(): string[] {
  return [
    `payments: ${config.mockPayments ? "mock" : "stripe"}`,
    `llm: ${config.mockLlm ? "mock" : config.anthropic.model}`,
    `email: ${config.emailOutbox ? "outbox" : "resend"}`,
  ];
}

/** Names of the optional env vars that are currently unset, for the admin mode banner. */
export function missingEnv(): string[] {
  const missing: string[] = [];
  if (!config.stripe.secretKey) missing.push("STRIPE_SECRET_KEY");
  if (!config.stripe.webhookSecret) missing.push("STRIPE_WEBHOOK_SECRET");
  if (!config.stripe.priceSingle) missing.push("STRIPE_PRICE_SINGLE");
  if (!config.stripe.priceReviewed) missing.push("STRIPE_PRICE_REVIEWED");
  if (!config.stripe.pricePack5) missing.push("STRIPE_PRICE_PACK5");
  if (!config.stripe.couponFounding) missing.push("STRIPE_COUPON_FOUNDING");
  if (!config.anthropic.apiKey) missing.push("ANTHROPIC_API_KEY");
  if (!config.resend.apiKey) missing.push("RESEND_API_KEY");
  if (config.adminPassword === null) missing.push("ADMIN_PASSWORD");
  return missing;
}
