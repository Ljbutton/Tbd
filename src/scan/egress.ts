// Pinning egress proxy for the scan browser. Chromium is launched with this
// local HTTP proxy, so every connection a scan makes (redirect hops, iframes,
// scripts and images included) is opened here rather than by Chromium. For
// each connection the proxy resolves the target host once, refuses it unless
// every address is public (ssrf.ts), and connects the socket to exactly the
// address it vetted. Chromium never resolves scanned hosts itself, so a
// DNS-rebinding server cannot hand the browser a private address after the
// check. HTTPS is tunnelled with CONNECT (TLS stays end to end); plain HTTP is
// forwarded. Honors config.allowPrivateTargets like the rest of the guard.

import http from "node:http";
import type { AddressInfo } from "node:net";
import net from "node:net";
import type { Duplex } from "node:stream";
import { isDeniedHostname, pinnedLookup, stripBrackets } from "./ssrf.js";

/** Idle limit for a forwarded plain-HTTP exchange. */
export const EGRESS_IDLE_TIMEOUT_MS = 60000;

/**
 * Header on responses the proxy generated itself (blocked target, unreachable
 * site), carrying the reason. Lets the crawler and scanner report "connection
 * refused" rather than "HTTP 502" as if the site had answered. Stripped from
 * real upstream responses so a site cannot fake it.
 */
export const EGRESS_FAILURE_HEADER = "x-accessaudit-egress";

const BLOCKED_REASON = "blocked: private or internal address";

/** Headers that describe one hop (Chromium to proxy) and must not be forwarded. */
const HOP_BY_HOP = new Set([
  "connection",
  "proxy-connection",
  "keep-alive",
  "proxy-authorization",
  "proxy-authenticate",
  "te",
  "trailer",
  "upgrade",
]);

export interface EgressProxy {
  /** `http://127.0.0.1:<port>`, ready for chromium.launch({ proxy: { server } }). */
  url: string;
  server: http.Server;
}

/** Sockets in this pool were all opened through pinnedLookup. */
const upstreamAgent = new http.Agent({ keepAlive: true, maxSockets: 64 });

let proxyPromise: Promise<EgressProxy> | null = null;

function stripHopByHop(rawHeaders: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    const name = rawHeaders[i] as string;
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || lower === EGRESS_FAILURE_HEADER) continue;
    out.push(name, rawHeaders[i + 1] as string);
  }
  return out;
}

/** Short, buyer-readable reason for a failed upstream connection. */
function failureReason(err: Error & { code?: string }): string {
  switch (err.code) {
    case "blocked_target":
      return BLOCKED_REASON;
    case "dns_failed":
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return "could not look up the domain";
    case "ECONNREFUSED":
      return "connection refused";
    case "ETIMEDOUT":
      return "connection timed out";
    case "ECONNRESET":
      return "connection reset";
    case "EHOSTUNREACH":
    case "ENETUNREACH":
      return "host unreachable";
    default:
      return err.code ? `connection failed (${err.code})` : "connection failed";
  }
}

/** The proxy's own failure reason when it, not the site, produced this response; null otherwise. */
export function egressFailure(headers: Record<string, string>): string | null {
  const value = headers[EGRESS_FAILURE_HEADER];
  return typeof value === "string" && value !== "" ? value : null;
}

function deny(res: http.ServerResponse, status: number, reason: string): void {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", [EGRESS_FAILURE_HEADER]: reason, connection: "close" });
  res.end(`${reason}\n`);
}

function refuseTunnel(socket: Duplex, status: number): void {
  socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? "Error"}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
}

/** Plain http:// requests arrive in absolute form (`GET http://host/path`). */
function forward(req: http.IncomingMessage, res: http.ServerResponse): void {
  let target: URL;
  try {
    target = new URL(req.url ?? "");
  } catch {
    deny(res, 400, "bad proxy request");
    return;
  }
  if (target.protocol !== "http:" || target.hostname === "") {
    deny(res, 400, "bad proxy request: only http:// is forwarded, https:// uses CONNECT");
    return;
  }
  const hostname = stripBrackets(target.hostname);
  if (isDeniedHostname(hostname)) {
    deny(res, 403, BLOCKED_REASON);
    return;
  }

  const upstream = http.request({
    host: hostname,
    port: target.port === "" ? 80 : Number(target.port),
    method: req.method,
    path: `${target.pathname}${target.search}`,
    headers: stripHopByHop(req.rawHeaders),
    lookup: pinnedLookup,
    agent: upstreamAgent,
    timeout: EGRESS_IDLE_TIMEOUT_MS,
  });
  upstream.on("response", (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.statusMessage, stripHopByHop(upstreamRes.rawHeaders));
    upstreamRes.pipe(res);
    upstreamRes.on("error", () => res.destroy());
  });
  upstream.on("timeout", () => upstream.destroy(Object.assign(new Error("upstream timed out"), { code: "ETIMEDOUT" })));
  upstream.on("error", (err: Error & { code?: string }) => {
    deny(res, err.code === "blocked_target" ? 403 : 502, failureReason(err));
  });
  res.on("close", () => {
    if (!res.writableFinished) upstream.destroy();
  });
  req.pipe(upstream);
}

/** https:// (and wss://) goes through a CONNECT tunnel to the vetted address. */
function tunnel(req: http.IncomingMessage, client: Duplex, head: Buffer): void {
  let target: URL;
  try {
    target = new URL(`http://${req.url ?? ""}`);
  } catch {
    refuseTunnel(client, 400);
    return;
  }
  const hostname = stripBrackets(target.hostname);
  if (hostname === "" || target.pathname !== "/" || target.search !== "") {
    refuseTunnel(client, 400);
    return;
  }
  if (isDeniedHostname(hostname)) {
    refuseTunnel(client, 403);
    return;
  }

  let connected = false;
  const upstream = net.connect({ host: hostname, port: target.port === "" ? 80 : Number(target.port), lookup: pinnedLookup });
  upstream.once("connect", () => {
    connected = true;
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length > 0) upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
  });
  upstream.on("error", (err: Error & { code?: string }) => {
    if (!connected) refuseTunnel(client, err.code === "blocked_target" ? 403 : 502);
    else client.destroy();
  });
  client.on("error", () => upstream.destroy());
  client.on("close", () => upstream.destroy());
}

/**
 * Starts the process-wide egress proxy on a random loopback port (once) and
 * returns its address. The server is unref'd so it never keeps the process
 * alive; it stays up for the life of the process.
 */
export function startEgressProxy(): Promise<EgressProxy> {
  if (proxyPromise !== null) return proxyPromise;
  const attempt = new Promise<EgressProxy>((resolve, reject) => {
    const server = http.createServer(forward);
    server.on("connect", tunnel);
    server.on("clientError", (_err, socket) => socket.destroy());
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.unref();
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}`, server });
    });
  });
  proxyPromise = attempt.catch((err: unknown) => {
    proxyPromise = null;
    throw err;
  });
  return proxyPromise;
}
