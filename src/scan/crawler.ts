// Breadth-first discovery of same-site HTML pages. The crawl only collects
// URLs; scanning happens in a separate phase so progress reporting is honest.

import type { BrowserContext, Page } from "playwright";
import { closeContext, newScanContext } from "./browser.js";
import type { Robots } from "./robots.js";
import { isProbablyHtml, normalizeUrl, sameOrigin } from "./url.js";

export const CRAWL_CAP_MS = 3 * 60 * 1000;
export const CRAWL_NAVIGATION_TIMEOUT_MS = 30000;
export const CRAWL_SETTLE_MS = 1000;
export const START_URL_UNREACHABLE = "start_url_unreachable";

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
 * Responses whose content type is not HTML, error statuses on discovered
 * pages and failed navigations are reported through `onProgress` and skipped.
 * The whole phase stops after 3 minutes with whatever was found. Throws
 * StartUrlUnreachableError when the start URL cannot be loaded.
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
  const seen = new Set<string>([start]);
  const found: string[] = [];

  let context: BrowserContext | null = null;
  let page: Page | null = null;
  try {
    context = await newScanContext("desktop");
    page = await context.newPage();

    while (queue.length > 0 && found.length < pageLimit) {
      const elapsed = Date.now() - startedAt;
      if (elapsed >= capMs) {
        report({
          kind: "capped",
          found: found.length,
          queued: queue.length,
          url: queue[0] ?? start,
          message: `crawl time cap reached after ${Math.round(elapsed / 1000)}s; continuing with ${found.length} pages`,
        });
        break;
      }
      const url = queue.shift() as string;
      const isStart = url === start;
      const navTimeout = Math.max(1000, Math.min(CRAWL_NAVIGATION_TIMEOUT_MS, capMs - elapsed));

      let status: number | null = null;
      let contentType: string | undefined;
      try {
        const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: navTimeout });
        if (response === null) throw new Error("no response");
        status = response.status();
        contentType = response.headers()["content-type"];
      } catch (err) {
        const reason = errorMessage(err);
        if (isStart) throw new StartUrlUnreachableError(reason);
        report({ kind: "failed", found: found.length, queued: queue.length, url, message: `could not load ${url} (${reason})` });
        continue;
      }

      if (!isHtmlContentType(contentType)) {
        if (isStart) throw new StartUrlUnreachableError(`start page is not HTML (${contentType ?? "unknown content type"})`);
        report({ kind: "skipped", found: found.length, queued: queue.length, url, message: `skipped ${url} (content-type ${contentType})` });
        continue;
      }
      if (!isStart && status !== null && status >= 400) {
        report({ kind: "skipped", found: found.length, queued: queue.length, url, message: `skipped ${url} (HTTP ${status})` });
        continue;
      }

      await page.waitForTimeout(Math.min(CRAWL_SETTLE_MS, Math.max(0, capMs - (Date.now() - startedAt))));

      // A redirect on the start page (http -> https, bare -> www) moves the site; accept links from there too.
      const finalUrl = page.url();
      if (isStart) {
        try {
          const finalOrigin = new URL(finalUrl).origin;
          if (finalOrigin.startsWith("http")) siteOrigins.add(finalOrigin);
        } catch {
          // Keep the original origin.
        }
      }

      found.push(url);
      report({
        kind: "visited",
        found: found.length,
        queued: queue.length,
        url,
        message: `found ${url}${status !== null ? ` (HTTP ${status})` : ""}`,
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
          report({ kind: "skipped", found: found.length, queued: queue.length, url: candidate, message: `skipped ${candidate} (disallowed by robots.txt)` });
          continue;
        }
        seen.add(candidate);
        queue.push(candidate);
        added += 1;
      }
      if (added > 0) {
        report({ kind: "visited", found: found.length, queued: queue.length, url, message: `queued ${added} new link${added === 1 ? "" : "s"} from ${url}` });
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

  report({ kind: "done", found: found.length, queued: queue.length, url: start, message: `Found ${found.length} page${found.length === 1 ? "" : "s"}` });
  return found;
}
