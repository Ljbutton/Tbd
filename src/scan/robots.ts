// robots.txt loading and matching for the crawler. Only the `*` group is
// honoured; the crawler always scans the start URL the buyer asked for and
// applies these rules to discovered links only.

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
  /** Fetch timeout in milliseconds (default 8000). */
  timeoutMs?: number;
}

/**
 * Fetches `${origin}/robots.txt` with an 8s timeout. Any non-200 response,
 * network error or timeout yields an allow-all Robots.
 */
export async function loadRobots(origin: string, options: LoadRobotsOptions = {}): Promise<Robots> {
  const timeoutMs = options.timeoutMs ?? ROBOTS_TIMEOUT_MS;
  let base: URL;
  try {
    base = new URL(origin);
  } catch {
    return allowAll();
  }
  const target = `${base.origin}/robots.txt`;
  try {
    const response = await fetch(target, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "follow",
      headers: { "user-agent": ROBOTS_USER_AGENT, accept: "text/plain, */*;q=0.5" },
    });
    if (response.status !== 200) return allowAll();
    const text = (await response.text()).slice(0, MAX_ROBOTS_BYTES);
    return parseRobots(text, true);
  } catch {
    return allowAll();
  }
}
