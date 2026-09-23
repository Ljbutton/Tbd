// Marketing surface: landing page, SEO pages, legal pages, sample PDF, sitemap,
// robots.txt, the embed script and the health endpoint. Copy for the SEO pages
// and the landing FAQ lives in content/*.json so wording changes need no code.

import fs from "node:fs";
import path from "node:path";
import express, { type Request } from "express";
import { FOUNDING_COUPON, PRODUCTS, ROOT_DIR, config } from "../config.js";
import { runnerStats } from "../jobs/runner.js";
import { formatUsd, foundingLeft } from "../payments/orders.js";
import { isBrowserReady } from "../scan/browser.js";
import { HttpError, asyncHandler, escapeHtml } from "../util/http.js";
import { renderPage } from "../util/render.js";

export const router = express.Router();

export const CONTENT_DIR = path.join(ROOT_DIR, "content");
export const PUBLIC_DIR = path.join(ROOT_DIR, "public");
export const SAMPLE_PDF_PATH = path.join(PUBLIC_DIR, "sample-report.pdf");
export const SAMPLE_PREVIEW_PATH = path.join(PUBLIC_DIR, "sample-report-preview.png");
export const EMBED_JS_PATH = path.join(PUBLIC_DIR, "embed.js");
export const SAMPLE_MISSING_MESSAGE = "Run npm run sample";
export const LEGAL_UPDATED = "September 23, 2026";
export const LEGAL_PAGES = ["terms", "privacy"] as const;
export type LegalPage = (typeof LEGAL_PAGES)[number];

const LANDING_TITLE = "Website accessibility audit ranked by lawsuit risk";
const LANDING_DESCRIPTION =
  "Paste your URL and get a plain-English WCAG audit of up to 15 pages in about 10 minutes, ranked by lawsuit risk, with copy-paste fixes from your own code. $49 one time. No overlay, no subscription.";

// ---------------------------------------------------------------------------
// Content files
// ---------------------------------------------------------------------------

export interface FaqEntry {
  q: string;
  a: string;
}

export interface ChecklistStep {
  title: string;
  detail: string;
}

export interface SeoPage {
  slug: string;
  platform: string;
  title: string;
  metaDescription: string;
  h1: string;
  intro: string;
  tipsHeading: string;
  platformTips: string[];
  faq: FaqEntry[];
  /** Only the demand-letter page carries a numbered checklist. */
  checklist: ChecklistStep[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function contentError(file: string, detail: string): Error {
  return new Error(`content/${file}: ${detail}`);
}

function requireString(obj: Record<string, unknown>, key: string, file: string, where: string): string {
  const value = obj[key];
  if (typeof value !== "string" || value.trim() === "") throw contentError(file, `${where}.${key} must be a non-empty string`);
  return value;
}

function optionalString(obj: Record<string, unknown>, key: string, fallback: string): string {
  const value = obj[key];
  return typeof value === "string" && value.trim() !== "" ? value : fallback;
}

function requireStringArray(obj: Record<string, unknown>, key: string, file: string, where: string): string[] {
  const value = obj[key];
  if (!Array.isArray(value) || value.length === 0 || value.some((v) => typeof v !== "string" || v.trim() === "")) {
    throw contentError(file, `${where}.${key} must be a non-empty array of strings`);
  }
  return value as string[];
}

function parseFaq(value: unknown, file: string, where: string): FaqEntry[] {
  if (!Array.isArray(value) || value.length === 0) throw contentError(file, `${where} must be a non-empty array`);
  return value.map((entry, i) => {
    if (!isRecord(entry)) throw contentError(file, `${where}[${i}] must be an object`);
    return { q: requireString(entry, "q", file, `${where}[${i}]`), a: requireString(entry, "a", file, `${where}[${i}]`) };
  });
}

function parseChecklist(value: unknown, file: string, where: string): ChecklistStep[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw contentError(file, `${where} must be an array`);
  return value.map((entry, i) => {
    if (!isRecord(entry)) throw contentError(file, `${where}[${i}] must be an object`);
    return {
      title: requireString(entry, "title", file, `${where}[${i}]`),
      detail: requireString(entry, "detail", file, `${where}[${i}]`),
    };
  });
}

function readJsonFile(file: string): unknown {
  const full = path.join(CONTENT_DIR, file);
  let text: string;
  try {
    text = fs.readFileSync(full, "utf8");
  } catch (err) {
    throw contentError(file, `could not be read (${err instanceof Error ? err.message : String(err)})`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    throw contentError(file, `is not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
}

function loadLandingFaq(): FaqEntry[] {
  return parseFaq(readJsonFile("landing-faq.json"), "landing-faq.json", "faq");
}

function loadSeoPages(): SeoPage[] {
  const file = "seo-pages.json";
  const raw = readJsonFile(file);
  if (!Array.isArray(raw) || raw.length === 0) throw contentError(file, "must be a non-empty array of pages");
  const pages = raw.map((entry, i) => {
    const where = `pages[${i}]`;
    if (!isRecord(entry)) throw contentError(file, `${where} must be an object`);
    const slug = requireString(entry, "slug", file, where);
    if (!/^[a-z0-9-]+$/.test(slug)) throw contentError(file, `${where}.slug must be lowercase letters, digits and dashes`);
    const platform = optionalString(entry, "platform", "unknown");
    return {
      slug,
      platform,
      title: requireString(entry, "title", file, where),
      metaDescription: requireString(entry, "metaDescription", file, where),
      h1: requireString(entry, "h1", file, where),
      intro: requireString(entry, "intro", file, where),
      tipsHeading: optionalString(entry, "tipsHeading", "Fixing the usual issues"),
      platformTips: requireStringArray(entry, "platformTips", file, where),
      faq: parseFaq(entry.faq, file, `${where}.faq`),
      checklist: parseChecklist(entry.checklist, file, `${where}.checklist`),
    };
  });
  const seen = new Set<string>();
  for (const page of pages) {
    if (seen.has(page.slug)) throw contentError(file, `duplicate slug "${page.slug}"`);
    seen.add(page.slug);
  }
  return pages;
}

export const LANDING_FAQ: readonly FaqEntry[] = loadLandingFaq();
export const SEO_PAGES: readonly SeoPage[] = loadSeoPages();
const SEO_BY_SLUG = new Map(SEO_PAGES.map((page) => [page.slug, page]));

export function getSeoPage(slug: string): SeoPage | null {
  return SEO_BY_SLUG.get(slug) ?? null;
}

// ---------------------------------------------------------------------------
// Shared locals and <head> helpers
// ---------------------------------------------------------------------------

/**
 * Styles that only the marketing pages use. They travel in the page <head>
 * (via the `head` local) so the base stylesheet stays untouched; every color
 * pairing here is at or above 4.5:1 against its background.
 */
export const MARKETING_STYLE = `<style>
.hero{padding:3rem 0 2.5rem;background:#eff6ff;border-bottom:1px solid #e5e7eb}
.hero__inner{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,.9fr);gap:2.5rem;align-items:start}
.hero h1{margin-bottom:1rem}
.hero .lead{font-size:1.2rem;color:#374151}
.hero__points{list-style:none;padding:0;margin:1.25rem 0 0;display:flex;flex-wrap:wrap;gap:.5rem 1.25rem;color:#4b5563;font-size:.95rem}
.hero__points li::before{content:"\\2713";color:#166534;font-weight:700;margin-right:.4rem}
.teaser-box{padding:1.5rem}
.teaser-box__title{margin-top:0;font-size:1.3rem}
.teaser-form__row{display:flex;gap:.6rem;flex-wrap:wrap}
.teaser-form__row input{flex:1 1 240px}
.teaser-form__hint{margin:.5rem 0 0}
.teaser-form__status{margin:.5rem 0 0;font-weight:600;min-height:1.5rem}
.teaser-form__status.is-error{color:#b91c1c}
.teaser-result{margin-top:1.25rem}
.teaser-card__title{font-size:1.35rem;margin-bottom:.35rem}
.issue-list{list-style:none;padding:0;margin:1rem 0 0;display:grid;gap:1rem}
.issue-card{border:1px solid #e5e7eb;border-radius:6px;padding:1rem;background:#f9fafb}
.issue-card__head{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center;margin-bottom:.5rem}
.issue-card__head h3{margin:0;font-size:1.05rem}
.issue-card p{margin-bottom:.5rem}
.issue-shot{display:block;max-height:220px;width:auto;max-width:100%;border:1px solid #d1d5db;border-radius:4px;margin:.5rem 0;background:#fff}
.issue-code{font-size:.8rem;margin:.5rem 0 0;max-height:9rem}
.teaser-card__footer{border-top:1px solid #e5e7eb;margin-top:1.25rem;padding-top:1.25rem}
.stats-strip{background:#111827;color:#ffffff;padding:2rem 0}
.stats-strip .stat{background:transparent;border-color:rgba(255,255,255,.25)}
.stats-strip .stat-value{color:#ffffff}
.stats-strip .stat-label,.stats-strip .stat-source{color:#e5e7eb}
.pricing-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1.25rem;align-items:start}
.pricing-card .badge{margin-bottom:.5rem}
.founding-note{background:#dcfce7;color:#166534;border-radius:6px;padding:.6rem .8rem;font-weight:600;margin:1rem 0 0}
.embed-block{margin-top:1.25rem;padding-top:1rem;border-top:1px solid #e5e7eb}
.embed-block p{margin-bottom:.5rem}
.snippet{font-size:.8rem;margin:0 0 .6rem}
.compare-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1.25rem}
.compare-us{border:2px solid #1d4ed8;background:#eff6ff;margin-top:1.25rem}
.checklist{counter-reset:step;list-style:none;padding:0;margin:0 0 1.5rem}
.checklist li{position:relative;padding-left:3.25rem;margin-bottom:1.1rem;min-height:2.5rem}
.checklist li::before{counter-increment:step;content:counter(step);position:absolute;left:0;top:0;width:2.5rem;height:2.5rem;border-radius:50%;background:#1d4ed8;color:#ffffff;display:flex;align-items:center;justify-content:center;font-weight:700}
.checklist strong{display:block;font-size:1.05rem}
.tips{padding-left:1.25rem}
.tips li{margin-bottom:.6rem}
.faq-list details{padding:.9rem 1.1rem}
.faq-list details p{margin:.75rem 0 0}
.legal h2{margin-top:2rem;font-size:1.35rem}
.legal .table th{width:28%}
.cta-band{background:#1d4ed8;color:#ffffff;padding:2.5rem 0;text-align:center}
.cta-band h2{color:#ffffff}
.cta-band p{color:#ffffff}
.btn-light{background:#ffffff;color:#1d4ed8;border-color:#ffffff}
.btn-light:hover{background:#eff6ff;color:#1e40af;border-color:#eff6ff}
.sample-frame{height:600px;display:block}
@media (max-width:900px){.hero__inner,.pricing-grid,.compare-grid{grid-template-columns:minmax(0,1fr)}}
</style>`;

export interface PricingLocals {
  singlePrice: string;
  reviewedPrice: string;
  pack5Price: string;
  foundingPrice: string;
  foundingCode: string;
  foundingLeft: number;
  foundingMax: number;
  pageLimitSingle: number;
  pageLimitPack: number;
  embedSnippet: string;
}

/** Prices, founding-offer state and the embed snippet for views/partials/pricing-cards.ejs. */
export function pricingLocals(): PricingLocals {
  return {
    singlePrice: formatUsd(PRODUCTS.single.amountCents),
    reviewedPrice: formatUsd(PRODUCTS.reviewed.amountCents),
    pack5Price: formatUsd(PRODUCTS.pack5.amountCents),
    foundingPrice: formatUsd(PRODUCTS.pack5.amountCents - FOUNDING_COUPON.amountOffCents),
    foundingCode: FOUNDING_COUPON.code,
    foundingLeft: foundingLeft(),
    foundingMax: FOUNDING_COUPON.maxRedemptions,
    pageLimitSingle: config.pageLimitSingle,
    pageLimitPack: config.pageLimitPack,
    embedSnippet: `<div id="accessaudit-embed"></div><script src="${config.baseUrl}/embed.js" async></script>`,
  };
}

/** Locals views/partials/teaser-box.ejs and the teaser result page rely on. */
export function teaserLocals(prefillUrl = ""): { prefillUrl: string; teaserRateLimit: number; pageLimitSingle: number } {
  return { prefillUrl, teaserRateLimit: config.teaserRateLimit, pageLimitSingle: config.pageLimitSingle };
}

/** JSON-LD <script> with `<` escaped so page content can never close the tag early. */
export function jsonLdScript(data: unknown): string {
  return `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, "\\u003c")}</script>`;
}

export function faqPageJsonLd(faq: readonly FaqEntry[]): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faq.map((entry) => ({
      "@type": "Question",
      name: entry.q,
      acceptedAnswer: { "@type": "Answer", text: entry.a },
    })),
  };
}

interface MetaOptions {
  title: string;
  description: string;
  canonicalPath: string;
  noindex?: boolean;
}

function metaTags(options: MetaOptions): string {
  const canonical = `${config.baseUrl}${options.canonicalPath}`;
  const lines = [
    `<meta name="description" content="${escapeHtml(options.description)}">`,
    `<link rel="canonical" href="${escapeHtml(canonical)}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="AccessAudit">`,
    `<meta property="og:title" content="${escapeHtml(options.title)}">`,
    `<meta property="og:description" content="${escapeHtml(options.description)}">`,
    `<meta property="og:url" content="${escapeHtml(canonical)}">`,
    `<meta name="twitter:card" content="summary">`,
  ];
  if (options.noindex) lines.push(`<meta name="robots" content="noindex">`);
  return lines.join("\n");
}

function queryString(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return "";
}

/** The `?url=` prefill from embed.js, trimmed and capped; never trusted beyond being a string. */
export function prefillFromQuery(req: Request): string {
  return queryString(req.query.url).trim().slice(0, 2048);
}

// ---------------------------------------------------------------------------
// Sitemap and robots
// ---------------------------------------------------------------------------

/** Every public, indexable path (report, credit and admin pages are deliberately absent). */
export function publicPaths(): string[] {
  return ["/", ...SEO_PAGES.map((page) => `/a/${page.slug}`), ...LEGAL_PAGES.map((page) => `/legal/${page}`)];
}

export function sitemapXml(): string {
  const urls = publicPaths()
    .map((p) => {
      const priority = p === "/" ? "1.0" : p.startsWith("/a/") ? "0.8" : "0.3";
      const changefreq = p.startsWith("/legal/") ? "yearly" : "weekly";
      return `  <url><loc>${escapeHtml(`${config.baseUrl}${p}`)}</loc><changefreq>${changefreq}</changefreq><priority>${priority}</priority></url>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

export function robotsTxt(): string {
  return `User-agent: *\nDisallow: /admin\nDisallow: /r/\nDisallow: /credits/\nSitemap: ${config.baseUrl}/sitemap.xml\n`;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const prefillUrl = prefillFromQuery(req);
    const head = [
      MARKETING_STYLE,
      metaTags({ title: `${LANDING_TITLE} | AccessAudit`, description: LANDING_DESCRIPTION, canonicalPath: "/" }),
      jsonLdScript({
        "@context": "https://schema.org",
        "@type": "Organization",
        name: "AccessAudit",
        url: config.baseUrl,
        logo: `${config.baseUrl}/logo.svg`,
      }),
      jsonLdScript(faqPageJsonLd(LANDING_FAQ)),
    ].join("\n");
    await renderPage(res, "index", {
      title: LANDING_TITLE,
      head,
      faq: LANDING_FAQ,
      foundingLeft: foundingLeft(),
      mockPayments: config.mockPayments,
      pricing: pricingLocals(),
      samplePdfExists: fs.existsSync(SAMPLE_PDF_PATH),
      samplePreviewExists: fs.existsSync(SAMPLE_PREVIEW_PATH),
      ...teaserLocals(prefillUrl),
    });
  }),
);

router.get(
  "/a/:slug",
  asyncHandler(async (req, res) => {
    const slug = queryString(req.params.slug);
    const page = getSeoPage(slug);
    if (page === null) throw new HttpError(404, "We couldn't find that page. Check the address or head back to the home page.", "not_found");
    const head = [
      MARKETING_STYLE,
      metaTags({ title: `${page.title} | AccessAudit`, description: page.metaDescription, canonicalPath: `/a/${page.slug}` }),
      jsonLdScript(faqPageJsonLd(page.faq)),
    ].join("\n");
    await renderPage(res, "seo-page", {
      title: page.title,
      head,
      page,
      foundingLeft: foundingLeft(),
      pricing: pricingLocals(),
      samplePdfExists: fs.existsSync(SAMPLE_PDF_PATH),
      ...teaserLocals(prefillFromQuery(req)),
    });
  }),
);

router.get(
  "/legal/:page",
  asyncHandler(async (req, res) => {
    const page = queryString(req.params.page);
    if (!LEGAL_PAGES.includes(page as LegalPage)) {
      throw new HttpError(404, "We couldn't find that page. Check the address or head back to the home page.", "not_found");
    }
    const title = page === "terms" ? "Terms of service" : "Privacy policy";
    const description =
      page === "terms"
        ? "The plain-English terms for buying an AccessAudit automated accessibility audit: what you get, delivery, refunds and limits."
        : "What AccessAudit stores when you scan or buy an audit, how long it is kept, who processes it, and how to have it deleted. No tracking cookies.";
    await renderPage(res, "legal", {
      title,
      head: [MARKETING_STYLE, metaTags({ title: `${title} | AccessAudit`, description, canonicalPath: `/legal/${page}` })].join("\n"),
      page,
      updated: LEGAL_UPDATED,
      pricing: pricingLocals(),
    });
  }),
);

/**
 * Minimal standalone 404 document for the missing sample PDF. The landing page
 * embeds /sample-report.pdf in an iframe, so this must not carry the site
 * layout: duplicate header/nav/main/footer landmarks inside the frame would
 * make the landing page fail its own landmark checks.
 */
export function sampleMissingHtml(): string {
  return [
    "<!DOCTYPE html>",
    '<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    "<title>Sample report not generated yet</title>",
    "<style>body{margin:0;padding:2rem 1rem;font-family:system-ui,sans-serif;color:#1f2937;background:#f9fafb;line-height:1.5}code{background:#e5e7eb;padding:.1em .35em;border-radius:4px}</style>",
    "</head><body>",
    `<p><strong>Sample report not generated yet.</strong> ${escapeHtml(SAMPLE_MISSING_MESSAGE)} to create <code>public/sample-report.pdf</code>.</p>`,
    "</body></html>",
  ].join("\n");
}

router.get(
  "/sample-report.pdf",
  asyncHandler(async (_req, res) => {
    // express.static serves the file when it exists; this route answers 404 when it does not.
    if (!fs.existsSync(SAMPLE_PDF_PATH)) {
      res.setHeader("Cache-Control", "no-store");
      res.status(404).type("html").send(sampleMissingHtml());
      return;
    }
    await new Promise<void>((resolve, reject) => {
      res.sendFile(SAMPLE_PDF_PATH, { headers: { "Content-Type": "application/pdf" } }, (err) => (err ? reject(err) : resolve()));
    });
  }),
);

router.get("/sitemap.xml", (_req, res) => {
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.type("application/xml").send(sitemapXml());
});

router.get("/robots.txt", (_req, res) => {
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.type("text/plain").send(robotsTxt());
});

router.get(
  "/embed.js",
  asyncHandler(async (_req, res) => {
    // Normally served by express.static; kept here so the route exists even if static serving is reconfigured.
    if (!fs.existsSync(EMBED_JS_PATH)) throw new HttpError(404, "embed.js is missing from public/", "not_found");
    res.setHeader("Cache-Control", "public, max-age=3600");
    await new Promise<void>((resolve, reject) => {
      res.sendFile(EMBED_JS_PATH, { headers: { "Content-Type": "application/javascript; charset=utf-8" } }, (err) =>
        err ? reject(err) : resolve(),
      );
    });
  }),
);

router.get("/healthz", (_req, res) => {
  const { queued, running } = runnerStats();
  res.setHeader("Cache-Control", "no-store");
  res.json({
    ok: true,
    mockPayments: config.mockPayments,
    mockLlm: config.mockLlm,
    emailOutbox: config.emailOutbox,
    browserReady: isBrowserReady(),
    queued,
    running,
  });
});
