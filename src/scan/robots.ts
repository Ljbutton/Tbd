// robots.txt loading and matching for the crawler. Only the `*` group is
// honoured; the crawler always scans the start URL the buyer asked for and
// applies these rules to discovered links only.

import http from "node:http";
import https from "node:https";
import type { Readable } from "node:stream";
import zlib from "node:zlib";
import { isDeniedHostname, pinnedLookup } from "./ssrf.js";

export interface RobotsRule {
  allow: boolean;
  /** Raw pattern as written (may contain `*` wildcards and a `$` end anchor). */
  pattern: string;
  /** Matcher compiled from `pattern`. */
  regex: RegExp;
}

export interface Robots {
  /** Rules from the `*` group in file order. Empty means allow everything. */
  rules: RobotsRule[];
  /** True when a robots.txt was fetched with status 200 and parsed. */
  fetched: boolean;
  /** Whether a path (pathname plus query) may be crawled. */
  isAllowed(path: string): boolean;
}

export const ROBOTS_TIMEOUT_MS = 8000;
/** Redirect hops followed for robots.txt (RFC 9309 asks for at least five). */
export const MAX_ROBOTS_REDIRECTS = 5;
const MAX_ROBOTS_BYTES = 512 * 1024;
const ROBOTS_USER_AGENT = "Mozilla/5.0 (compatible; AccessAuditBot/1.0; +https://accessaudit.example/bot)";

/** Compiles a robots pattern: `*` matches anything, a trailing `$` anchors the end. */
export function compileRobotsPattern(pattern: string): RegExp {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const escaped = body
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\/]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}${anchored ? "$" : ""}`);
}

function decide(rules: RobotsRule[], path: string): boolean {
  let best: RobotsRule | null = null;
  for (const rule of rules) {
    if (!rule.regex.test(path)) continue;
    if (best === null || rule.pattern.length > best.pattern.length) {
      best = rule;
    } else if (rule.pattern.length === best.pattern.length && rule.allow && !best.allow) {
      best = rule;
    }
  }
  return best === null ? true : best.allow;
}

function build(rules: RobotsRule[], fetched: boolean): Robots {
  return {
    rules,
    fetched,
    isAllowed(path: string): boolean {
      const target = path === "" ? "/" : path.startsWith("/") ? path : `/${path}`;
      return decide(rules, target);
    },
  };
}

/** A Robots that permits everything (used when robots.txt is missing or broken). */
export function allowAll(): Robots {
  return build([], false);
}

/**
 * Parses robots.txt text and keeps the rules that apply to `User-agent: *`.
 * Consecutive User-agent lines share one group; several `*` groups are merged.
 * Empty Allow/Disallow values are ignored (an empty Disallow means allow all).
 */
export function parseRobots(text: string, fetched = true): Robots {
  const rules: RobotsRule[] = [];
  let agents: string[] = [];
  let collectingAgents = false;
  let groupIsWildcard = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (line === "") continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (field === "user-agent") {
      if (!collectingAgents) {
        agents = [];
        collectingAgents = true;
      }
      agents.push(value.toLowerCase());
      groupIsWildcard = agents.includes("*");
      continue;
    }

    collectingAgents = false;
    if (field !== "allow" && field !== "disallow") continue;
    if (!groupIsWildcard || value === "") continue;
    const pattern = value.startsWith("/") || value.startsWith("*") ? value : `/${value}`;
    rules.push({ allow: field === "allow", pattern, regex: compileRobotsPattern(pattern) });
  }
  return build(rules, fetched);
}

export interface LoadRobotsOptions {
  /** Fetch timeout in milliseconds for the whole redirect chain (default 8000). */
  timeoutMs?: number;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

interface RobotsResponse {
  status: number;
  location: string | null;
  body: string | null;
}

function decoded(res: http.IncomingMessage): Readable {
  const encoding = String(res.headers["content-encoding"] ?? "").trim().toLowerCase();
  if (encoding === "gzip" || encoding === "x-gzip") return res.pipe(zlib.createGunzip());
  if (encoding === "deflate") return res.pipe(zlib.createInflate());
  if (encoding === "br") return res.pipe(zlib.createBrotliDecompress());
  return res;
}

/**
 * One GET without following redirects. The socket is opened through
 * pinnedLookup, so it connects only to addresses that passed the SSRF check.
 * Bodies are read (up to MAX_ROBOTS_BYTES) only for 200 responses.
 */
function getOnce(target: URL, signal: AbortSignal): Promise<RobotsResponse> {
  const client = target.protocol === "https:" ? https : http;
  return new Promise<RobotsResponse>((resolve, reject) => {
    const req = client.request(
      target,
      {
        method: "GET",
        headers: { "user-agent": ROBOTS_USER_AGENT, accept: "text/plain, */*;q=0.5", "accept-encoding": "identity" },
        lookup: pinnedLookup,
        agent: false,
        signal,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = typeof res.headers.location === "string" ? res.headers.location : null;
        if (status !== 200) {
          res.resume();
          resolve({ status, location, body: null });
          return;
        }
        const stream = decoded(res);
        const chunks: Buffer[] = [];
        let size = 0;
        let settled = false;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          resolve({ status, location, body: Buffer.concat(chunks).toString("utf8").slice(0, MAX_ROBOTS_BYTES) });
        };
        stream.on("data", (chunk: Buffer) => {
          if (settled) return;
          chunks.push(chunk);
          size += chunk.length;
          if (size >= MAX_ROBOTS_BYTES) {
            finish();
            res.destroy();
          }
        });
        stream.on("end", finish);
        stream.on("error", (err) => {
          if (!settled) reject(err);
        });
        res.on("error", (err) => {
          if (!settled) reject(err);
        });
        res.on("close", () => {
          if (!settled && !res.complete) reject(new Error("robots.txt response closed early"));
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/**
 * Fetches `${origin}/robots.txt` with an 8s timeout. Any non-200 response,
 * network error or timeout yields an allow-all Robots. Redirects are followed
 * by hand (at most five) and every hop must be an http(s) URL whose host
 * passes the SSRF guard: blocked names and IP literals are refused before
 * connecting and names are vetted at connect time by pinnedLookup. A refused
 * hop also yields allow-all, since crawling itself is route-guarded anyway.
 */
export async function loadRobots(origin: string, options: LoadRobotsOptions = {}): Promise<Robots> {
  const timeoutMs = options.timeoutMs ?? ROBOTS_TIMEOUT_MS;
  let current: URL;
  try {
    current = new URL("/robots.txt", new URL(origin).origin);
  } catch {
    return allowAll();
  }
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    for (let hop = 0; hop <= MAX_ROBOTS_REDIRECTS; hop++) {
      if (current.protocol !== "http:" && current.protocol !== "https:") return allowAll();
      if (current.username !== "" || current.password !== "") return allowAll();
      if (isDeniedHostname(current.hostname)) return allowAll();
      const response = await getOnce(current, signal);
      if (REDIRECT_STATUSES.has(response.status) && response.location !== null) {
        current = new URL(response.location, current);
        continue;
      }
      if (response.status !== 200 || response.body === null) return allowAll();
      return parseRobots(response.body, true);
    }
    return allowAll();
  } catch {
    return allowAll();
  }
}
