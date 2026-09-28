// Breadth-first discovery of same-site HTML pages. The crawl only collects
// URLs; scanning happens in a separate phase so progress reporting is honest.

import type { BrowserContext, Page } from "playwright";
import { closeContext, newScanContext } from "./browser.js";
import { egressFailure } from "./egress.js";
import type { Robots } from "./robots.js";
import { isProbablyHtml, normalizeUrl, sameOrigin } from "./url.js";

export const CRAWL_CAP_MS = 3 * 60 * 1000;
export const CRAWL_NAVIGATION_TIMEOUT_MS = 30000;
export const CRAWL_SETTLE_MS = 1000;
export const START_URL_UNREACHABLE = "start_url_unreachable";
/**
 * Query-string variants of one path (`?page=2`, `?sort=price`) that are queued
 * normally; further variants wait until every other discovered URL has been
 * visited, so pagination chains and facets cannot crowd out distinct pages.
 */
export const MAX_QUERY_VARIANTS_PER_PATH = 2;

export interface CrawlProgress {
  /** Pages accepted so far (what will be scanned). */
  found: number;
  /** URLs still waiting in the queue. */
  queued: number;
  /** URL this event is about. */
  url: string;
  /** What happened, ready for the audit log. */
  message: string;
  kind: "visited" | "skipped" | "failed" | "capped" | "done";
}

export interface CrawlOptions {
  startUrl: string;
  pageLimit: number;
  robots: Robots;
  onProgress?: (progress: CrawlProgress) => void;
  /** Overall cap for the crawl phase (default 3 minutes). */
  capMs?: number;
}

/** Thrown when the start URL itself cannot be loaded. `message` starts with `start_url_unreachable: `. */
export class StartUrlUnreachableError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`${START_URL_UNREACHABLE}: ${reason}`);
    this.name = "StartUrlUnreachableError";
    this.reason = reason;
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message.split("\n")[0] ?? err.message;
  return String(err);
}

function isHtmlContentType(contentType: string | undefined): boolean {
  if (contentType === undefined || contentType === "") return true; // no header: assume a page
  const type = contentType.toLowerCase();
  return type.includes("text/html") || type.includes("application/xhtml+xml");
}

function robotsPath(url: string): string {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
}

function originOf(url: string): string {
  try {
    const origin = new URL(url).origin;
    return origin === "null" ? url : origin;
  } catch {
    return url;
  }
}

/**
 * Where a start-page redirect may land and still be the buyer's site: the same
 * origin (www-insensitive) or its http/https twin on the default port.
 */
function isSameSiteRedirect(final: string, start: string): boolean {
  if (sameOrigin(final, start)) return true;
  const twin = new URL(start);
  if (twin.port !== "") return false;
  twin.protocol = twin.protocol === "https:" ? "http:" : "https:";
  return sameOrigin(final, twin);
}

async function collectHrefs(page: Page): Promise<string[]> {
  try {
    return await page.$$eval("a[href]", (anchors) =>
      anchors.map((a) => a.getAttribute("href") ?? "").filter((href) => href !== ""),
    );
  } catch {
    return [];
  }
}

/**
 * Crawls from `startUrl` and returns up to `pageLimit` same-site HTML page
 * URLs in discovery order (the start URL first). Discovered links must be
 * same-origin (www-insensitive), look like HTML, be allowed by robots.txt and
 * not already seen; the start URL is always kept even if robots disallows it.
 * Each page is recorded under the URL the browser ended up on after
 * redirects, so an alias of a page already found is skipped as a duplicate
 * and a link that redirects off-site is skipped rather than scanned as the
 * customer's page. Responses whose content type is not HTML, error statuses
 * on discovered pages and failed navigations are reported through
 * `onProgress` and skipped. Query-string variants of a path beyond
 * MAX_QUERY_VARIANTS_PER_PATH are visited only once nothing else is queued.
 * The whole phase stops after 3 minutes with whatever was found. Throws
 * StartUrlUnreachableError when the start URL cannot be loaded, answers with
 * an HTTP error status, is not HTML or redirects to a different site.
 */
export async function crawl(options: CrawlOptions): Promise<string[]> {
  const { robots } = options;
  const pageLimit = Math.max(1, Math.floor(options.pageLimit));
  const capMs = options.capMs ?? CRAWL_CAP_MS;
  const startedAt = Date.now();
  const report = (progress: CrawlProgress): void => {
    if (options.onProgress) options.onProgress(progress);
  };

  const start = normalizeUrl(options.startUrl);
  const siteOrigins = new Set<string>([new URL(start).origin]);
  const queue: string[] = [start];
  /** Query variants past MAX_QUERY_VARIANTS_PER_PATH; visited only when `queue` is empty. */
  const deferred: string[] = [];
  const queryVariants = new Map<string, number>();
  const pending = (): number => queue.length + deferred.length;
  const seen = new Set<string>([start]);
  const found: string[] = [];

  let context: BrowserContext | null = null;
  let page: Page | null = null;
  try {
    context = await newScanContext("desktop");
    page = await context.newPage();

    while (pending() > 0 && found.length < pageLimit) {
      const elapsed = Date.now() - startedAt;
      if (elapsed >= capMs) {
        report({
          kind: "capped",
          found: found.length,
          queued: pending(),
          url: queue[0] ?? deferred[0] ?? start,
          message: `crawl time cap reached after ${Math.round(elapsed / 1000)}s; continuing with ${found.length} pages`,
        });
        break;
      }
      const url = (queue.length > 0 ? queue.shift() : deferred.shift()) as string;
      const isStart = url === start;
      const navTimeout = Math.max(1000, Math.min(CRAWL_NAVIGATION_TIMEOUT_MS, capMs - elapsed));

      let status: number | null = null;
      let contentType: string | undefined;
      try {
        const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: navTimeout });
        if (response === null) throw new Error("no response");
        // Blocked or unreachable: the egress proxy answered, not the site.
        const egress = egressFailure(response.headers());
        if (egress !== null) throw new Error(egress);
        status = response.status();
        contentType = response.headers()["content-type"];
      } catch (err) {
        const reason = errorMessage(err);
        if (isStart) throw new StartUrlUnreachableError(reason);
        report({ kind: "failed", found: found.length, queued: pending(), url, message: `could not load ${url} (${reason})` });
        continue;
      }

      // A 404/5xx or bot-challenge page is not the buyer's site: fail on the start page, skip elsewhere.
      if (status !== null && status >= 400) {
        if (isStart) throw new StartUrlUnreachableError(`start page returned HTTP ${status}`);
        report({ kind: "skipped", found: found.length, queued: pending(), url, message: `skipped ${url} (HTTP ${status})` });
        continue;
      }
      if (!isHtmlContentType(contentType)) {
        if (isStart) throw new StartUrlUnreachableError(`start page is not HTML (${contentType ?? "unknown content type"})`);
        report({ kind: "skipped", found: found.length, queued: pending(), url, message: `skipped ${url} (content-type ${contentType})` });
        continue;
      }

      await page.waitForTimeout(Math.min(CRAWL_SETTLE_MS, Math.max(0, capMs - (Date.now() - startedAt))));

      // Where the browser ended up after redirects; the page is recorded under that URL.
      const finalUrl = page.url();
      let final: string;
      try {
        final = normalizeUrl(finalUrl);
      } catch {
        final = finalUrl;
      }
      if (isStart) {
        // http -> https and bare -> www keep the site (links from there count as same-site); anything else is another site.
        if (!isSameSiteRedirect(final, start)) {
          throw new StartUrlUnreachableError(`start page redirects to ${originOf(final)}, a different site`);
        }
        siteOrigins.add(new URL(final).origin);
      } else if (final !== url) {
        if (![...siteOrigins].some((origin) => sameOrigin(final, origin))) {
          report({ kind: "skipped", found: found.length, queued: pending(), url, message: `skipped ${url} (redirects off-site to ${originOf(final)})` });
          continue;
        }
        if (seen.has(final)) {
          report({ kind: "skipped", found: found.length, queued: pending(), url, message: `skipped ${url} (redirects to ${final}, already found or queued)` });
          continue;
        }
        if (!robots.isAllowed(robotsPath(final))) {
          seen.add(final);
          report({ kind: "skipped", found: found.length, queued: pending(), url, message: `skipped ${url} (redirects to ${final}, disallowed by robots.txt)` });
          continue;
        }
      }
      seen.add(final);

      found.push(final);
      report({
        kind: "visited",
        found: found.length,
        queued: pending(),
        url: final,
        message: `found ${final}${final !== url ? ` (redirected from ${url})` : ""}${status !== null ? ` (HTTP ${status})` : ""}`,
      });
      if (found.length >= pageLimit) break;

      const hrefs = await collectHrefs(page);
      let added = 0;
      for (const href of hrefs) {
        if (!isProbablyHtml(href)) continue;
        let candidate: string;
        try {
          candidate = normalizeUrl(href, finalUrl);
        } catch {
          continue;
        }
        if (!isProbablyHtml(candidate)) continue;
        if (seen.has(candidate)) continue;
        if (![...siteOrigins].some((origin) => sameOrigin(candidate, origin))) continue;
        if (!robots.isAllowed(robotsPath(candidate))) {
          seen.add(candidate);
          report({ kind: "skipped", found: found.length, queued: pending(), url: candidate, message: `skipped ${candidate} (disallowed by robots.txt)` });
          continue;
        }
        seen.add(candidate);
        const parsed = new URL(candidate);
        if (parsed.search !== "") {
          const pathKey = `${parsed.origin}${parsed.pathname}`;
          const variants = (queryVariants.get(pathKey) ?? 0) + 1;
          queryVariants.set(pathKey, variants);
          if (variants > MAX_QUERY_VARIANTS_PER_PATH) {
            deferred.push(candidate);
            added += 1;
            continue;
          }
        }
        queue.push(candidate);
        added += 1;
      }
      if (added > 0) {
        report({ kind: "visited", found: found.length, queued: pending(), url: final, message: `queued ${added} new link${added === 1 ? "" : "s"} from ${final}` });
      }
    }
  } finally {
    if (page !== null) {
      try {
        await page.close();
      } catch {
        // Already closed.
      }
    }
    await closeContext(context);
  }

  report({ kind: "done", found: found.length, queued: pending(), url: start, message: `Found ${found.length} page${found.length === 1 ? "" : "s"}` });
  return found;
}
