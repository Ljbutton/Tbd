// URL helpers shared by the crawler, the teaser cache and the report.

import { createHash } from "node:crypto";

/** Query parameters that only carry tracking state and never change the page. */
const TRACKING_PARAM = /^(utm_|fbclid|gclid|mc_|ref$)/;

/** Path extensions that are never HTML documents. */
const NON_HTML_EXTENSION =
  /\.(pdf|jpg|jpeg|png|gif|svg|webp|zip|mp4|mp3|css|js|json|xml|ico|woff|woff2)$/i;

/** Schemes that are not web pages at all. */
const NON_PAGE_SCHEME = /^(mailto|tel|javascript|data|blob|ftp|sms|about|file):/i;

/** Last path segment has a file extension (`/a/b.html` yes, `/a/b` and `/a/b/` no). */
function lastSegmentHasExtension(pathname: string): boolean {
  const trimmed = pathname.replace(/\/+$/, "");
  const last = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  return /\.[a-z0-9]{1,8}$/i.test(last);
}

/**
 * Canonical form of a URL so the crawler visits each page once:
 * resolves `u` against `base`, drops the fragment, lowercases scheme and host,
 * drops default ports, removes tracking query parameters, sorts the rest,
 * collapses repeated slashes and keeps a trailing slash only on
 * directory-like paths (no file extension). Throws TypeError when the input
 * is not a valid URL.
 */
export function normalizeUrl(u: string, base?: string): string {
  const url = base === undefined ? new URL(u.trim()) : new URL(u.trim(), base);
  url.hash = "";
  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase();
  if ((url.protocol === "http:" && url.port === "80") || (url.protocol === "https:" && url.port === "443")) {
    url.port = "";
  }

  for (const key of Array.from(new Set(url.searchParams.keys()))) {
    if (TRACKING_PARAM.test(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  if (url.searchParams.size === 0) url.search = "";

  let pathname = url.pathname.replace(/\/{2,}/g, "/");
  if (pathname === "") pathname = "/";
  if (pathname.length > 1 && pathname.endsWith("/") && lastSegmentHasExtension(pathname)) {
    pathname = pathname.replace(/\/+$/, "");
  }
  url.pathname = pathname;
  return url.href;
}

function hostWithoutWww(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, "");
}

function toUrl(value: string | URL): URL | null {
  if (value instanceof URL) return value;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/**
 * True when both URLs belong to the same site: same protocol, same port and
 * same hostname once a leading `www.` is stripped from each side.
 */
export function sameOrigin(a: string | URL, b: string | URL): boolean {
  const ua = toUrl(a);
  const ub = toUrl(b);
  if (ua === null || ub === null) return false;
  return (
    ua.protocol.toLowerCase() === ub.protocol.toLowerCase() &&
    ua.port === ub.port &&
    hostWithoutWww(ua.hostname) === hostWithoutWww(ub.hostname)
  );
}

/**
 * Cheap pre-filter for the crawler: false for mailto:/tel:/javascript: links
 * and for paths that end in a binary or asset extension. Accepts absolute
 * URLs and bare paths.
 */
export function isProbablyHtml(url: string): boolean {
  const text = (url ?? "").trim();
  if (text === "") return false;
  if (NON_PAGE_SCHEME.test(text)) return false;
  let pathname: string;
  try {
    pathname = new URL(text, "http://placeholder.invalid/").pathname;
  } catch {
    return false;
  }
  const withoutTrailingSlash = pathname.replace(/\/+$/, "");
  return !NON_HTML_EXTENSION.test(withoutTrailingSlash);
}

/** sha256 hex digest of a URL string (teaser cache key). */
export function hashUrl(url: string): string {
  return createHash("sha256").update(url, "utf8").digest("hex");
}
