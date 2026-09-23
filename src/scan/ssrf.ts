// SSRF guard: every user-supplied target (order, teaser, credits) and every
// request the scan browser makes goes through these checks. Only http(s)
// URLs that resolve exclusively to public unicast addresses may be fetched.

import { lookup } from "node:dns/promises";
import net from "node:net";
import { config } from "../config.js";
import { HttpError } from "../util/http.js";

export const SSRF_MESSAGES = {
  invalid_url: "Enter a full website address like https://example.com",
  blocked_target: "That address points to a private or internal network and can't be scanned",
  dns_failed: "We couldn't look up that domain",
} as const;

export type SsrfCode = keyof typeof SSRF_MESSAGES;

export const MAX_URL_LENGTH = 2048;

function fail(code: SsrfCode): HttpError {
  return new HttpError(400, SSRF_MESSAGES[code], code);
}

// ---------------------------------------------------------------------------
// IPv4
// ---------------------------------------------------------------------------

/** Blocked IPv4 ranges as [network, prefixLength]. */
const BLOCKED_V4: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local (cloud metadata lives here)
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved
  ["255.255.255.255", 32], // broadcast
];

/** Parses dotted-quad IPv4 into an unsigned 32-bit number, or null. */
function parseIpv4(ip: string): number | null {
  if (net.isIPv4(ip) === false) return null;
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
  return (((parts[0]! << 24) >>> 0) + (parts[1]! << 16) + (parts[2]! << 8) + parts[3]!) >>> 0;
}

function v4InRange(addr: number, network: string, prefix: number): boolean {
  const net32 = parseIpv4(network);
  if (net32 === null) return false;
  if (prefix === 0) return true;
  const mask = prefix === 32 ? 0xffffffff : ((0xffffffff << (32 - prefix)) >>> 0);
  return ((addr & mask) >>> 0) === ((net32 & mask) >>> 0);
}

function isPublicIpv4(ip: string): boolean {
  const addr = parseIpv4(ip);
  if (addr === null) return false;
  return !BLOCKED_V4.some(([network, prefix]) => v4InRange(addr, network, prefix));
}

// ---------------------------------------------------------------------------
// IPv6
// ---------------------------------------------------------------------------

/**
 * Expands an IPv6 literal (optionally with an embedded dotted IPv4 tail or a
 * `%zone` suffix) into eight 16-bit groups. Returns null when malformed.
 */
function parseIpv6(ip: string): number[] | null {
  let text = ip;
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);
  if (text.startsWith("[") && text.endsWith("]")) text = text.slice(1, -1);
  if (net.isIPv6(text) === false) return null;

  // Convert a trailing dotted IPv4 into two hex groups.
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = parseIpv4(tail);
    if (v4 === null) return null;
    const hi = ((v4 >>> 16) & 0xffff).toString(16);
    const lo = (v4 & 0xffff).toString(16);
    text = `${text.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] === "" || halves[0] === undefined ? [] : halves[0].split(":");
  const rest = halves.length === 2 && halves[1] !== "" ? halves[1]!.split(":") : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 2 && missing < 1) return null;
  if (halves.length === 1 && missing !== 0) return null;
  const groupsText = halves.length === 2 ? [...head, ...new Array<string>(missing).fill("0"), ...rest] : head;
  const groups: number[] = [];
  for (const g of groupsText) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    groups.push(parseInt(g, 16));
  }
  return groups.length === 8 ? groups : null;
}

function v6HasPrefix(groups: number[], prefixGroups: number[], prefixBits: number): boolean {
  let bitsLeft = prefixBits;
  for (let i = 0; i < 8 && bitsLeft > 0; i++) {
    const take = Math.min(16, bitsLeft);
    const mask = take === 16 ? 0xffff : (0xffff << (16 - take)) & 0xffff;
    if (((groups[i] ?? 0) & mask) !== ((prefixGroups[i] ?? 0) & mask)) return false;
    bitsLeft -= take;
  }
  return true;
}

function isPublicIpv6(ip: string): boolean {
  const groups = parseIpv6(ip);
  if (groups === null) return false;
  const allZero = groups.every((g) => g === 0);
  if (allZero) return false; // ::
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return false; // ::1
  if (v6HasPrefix(groups, [0xfc00], 7)) return false; // unique local fc00::/7
  if (v6HasPrefix(groups, [0xfe80], 10)) return false; // link-local fe80::/10
  if (v6HasPrefix(groups, [0xff00], 8)) return false; // multicast ff00::/8
  if (v6HasPrefix(groups, [0x64, 0xff9b], 96)) return false; // NAT64 64:ff9b::/96
  if (v6HasPrefix(groups, [0, 0, 0, 0, 0, 0xffff], 96)) {
    // IPv4-mapped ::ffff:a.b.c.d - judge the embedded IPv4 address.
    const v4 = ((groups[6]! << 16) | groups[7]!) >>> 0;
    const dotted = [v4 >>> 24, (v4 >>> 16) & 0xff, (v4 >>> 8) & 0xff, v4 & 0xff].join(".");
    return isPublicIpv4(dotted);
  }
  return true;
}

/**
 * True when the address is routable on the public internet. Anything that is
 * not a well-formed IPv4/IPv6 literal is treated as not public. This function
 * ignores `config.allowPrivateTargets` so tests and callers get the raw verdict.
 */
export function isPublicIp(ip: string): boolean {
  const text = (ip ?? "").trim();
  if (text === "") return false;
  if (net.isIPv4(text)) return isPublicIpv4(text);
  return isPublicIpv6(text);
}

// ---------------------------------------------------------------------------
// Hostnames
// ---------------------------------------------------------------------------

const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa"];

/** Strips the brackets a URL puts around an IPv6 literal hostname. */
export function stripBrackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

/** True when the hostname is an IPv4 or IPv6 literal (brackets allowed). */
export function isIpLiteral(hostname: string): boolean {
  return net.isIP(stripBrackets(hostname)) !== 0;
}

/**
 * True when a hostname names an internal network by convention (localhost,
 * *.local, *.internal, *.home.arpa) or is an IP literal in a blocked range.
 * Does not consult DNS and ignores `config.allowPrivateTargets`.
 */
export function isBlockedHostname(hostname: string): boolean {
  const host = stripBrackets((hostname ?? "").trim().toLowerCase()).replace(/\.$/, "");
  if (host === "") return true;
  if (host === "localhost") return true;
  if (BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  if (net.isIP(host) !== 0) return !isPublicIp(host);
  return false;
}

/**
 * Resolves a hostname with dns.lookup and returns every address. IP literals
 * are returned as-is without a DNS round trip. Throws `dns_failed` when the
 * lookup fails or yields nothing.
 */
export async function resolveAddresses(hostname: string): Promise<string[]> {
  const host = stripBrackets(hostname);
  if (net.isIP(host) !== 0) return [host];
  let records: { address: string; family: number }[];
  try {
    records = await lookup(host, { all: true });
  } catch {
    throw fail("dns_failed");
  }
  const addresses = records.map((r) => r.address).filter((a) => typeof a === "string" && a !== "");
  if (addresses.length === 0) throw fail("dns_failed");
  return addresses;
}

/**
 * Parses and validates a user-supplied address. Returns the URL when it is an
 * http(s) address whose host resolves only to public addresses. Throws
 * HttpError(400) with code `invalid_url`, `blocked_target` or `dns_failed`.
 * With `config.allowPrivateTargets` the private-network checks are skipped
 * (the scheme, userinfo and length checks still apply).
 */
export async function assertPublicUrl(input: string): Promise<URL> {
  const trimmed = (input ?? "").trim();
  if (trimmed === "" || trimmed.length > MAX_URL_LENGTH) throw fail("invalid_url");
  // Only `scheme://` counts as an explicit scheme so `example.com:8080` still gets https:// prepended.
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw fail("invalid_url");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw fail("invalid_url");
  if (url.username !== "" || url.password !== "") throw fail("invalid_url");
  if (url.hostname === "") throw fail("invalid_url");
  if (url.href.length > MAX_URL_LENGTH) throw fail("invalid_url");

  if (config.allowPrivateTargets) return url;

  if (isBlockedHostname(url.hostname)) throw fail("blocked_target");
  const addresses = await resolveAddresses(url.hostname);
  if (!addresses.every((address) => isPublicIp(address))) throw fail("blocked_target");
  return url;
}

/**
 * Non-throwing variant for the browser route guard: true when the hostname
 * may be fetched. Honors `config.allowPrivateTargets`; DNS failures count as
 * not allowed because nothing could be fetched from them anyway.
 */
export async function isAllowedHost(hostname: string): Promise<boolean> {
  if (config.allowPrivateTargets) return true;
  if (isBlockedHostname(hostname)) return false;
  try {
    const addresses = await resolveAddresses(hostname);
    return addresses.every((address) => isPublicIp(address));
  } catch {
    return false;
  }
}
