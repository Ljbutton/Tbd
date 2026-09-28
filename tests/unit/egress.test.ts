import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// dns.lookup is mocked so hostnames can be pointed at any address without the
// network. The mock is hoisted above every import, including the dynamic ones.
const mocks = vi.hoisted(() => ({
  lookup: vi.fn<(host: string, options: { all: true }) => Promise<{ address: string; family: number }[]>>(),
}));
vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup, default: { lookup: mocks.lookup } }));

// The proxy must be tested in its strict mode regardless of the developer's shell.
delete process.env.ALLOW_PRIVATE_TARGETS;
const strict = await import("../../src/scan/egress.js");
const { isAllowedHost } = await import("../../src/scan/ssrf.js");

function resolvesTo(...addresses: string[]): void {
  mocks.lookup.mockResolvedValue(addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })));
}

const cleanups: (() => Promise<void> | void)[] = [];

afterAll(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

async function listen(server: net.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        if (server instanceof http.Server) server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return (server.address() as AddressInfo).port;
}

/** An "internal" HTTP service that records every request that reaches it. */
async function internalService(): Promise<{ port: number; hits: string[]; headers: http.IncomingHttpHeaders[] }> {
  const hits: string[] = [];
  const headers: http.IncomingHttpHeaders[] = [];
  const server = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    headers.push(req.headers);
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/plain", "x-upstream": "yes" });
      res.end(`internal secret${body ? ` got=${body}` : ""}`);
    });
  });
  return { port: await listen(server), hits, headers };
}

function proxyPort(proxyUrl: string): number {
  return Number(new URL(proxyUrl).port);
}

/** Sends an absolute-form request through the proxy, the way Chromium does for http:// URLs. */
function viaProxy(proxyUrl: string, target: string, init: { method?: string; body?: string } = {}): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: proxyPort(proxyUrl),
        method: init.method ?? "GET",
        path: target,
        headers: { host: new URL(target).host, "proxy-connection": "keep-alive" },
        agent: false,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
      },
    );
    req.on("error", reject);
    req.end(init.body);
  });
}

/** Opens a CONNECT tunnel through the proxy; resolves with the proxy's status and, on 200, the socket. */
function connectViaProxy(proxyUrl: string, authority: string): Promise<{ status: number; socket: net.Socket | null }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: proxyPort(proxyUrl), method: "CONNECT", path: authority, agent: false });
    req.on("connect", (res, socket) => {
      if (res.statusCode === 200) {
        resolve({ status: 200, socket });
      } else {
        socket.destroy();
        resolve({ status: res.statusCode ?? 0, socket: null });
      }
    });
    req.on("response", (res) => {
      res.resume();
      resolve({ status: res.statusCode ?? 0, socket: null });
    });
    req.on("error", reject);
    req.end();
  });
}

beforeEach(() => {
  mocks.lookup.mockReset();
  resolvesTo("93.184.216.34");
});

describe("egress proxy (strict mode)", () => {
  it("refuses private IP literals and internal names for plain http without touching them", async () => {
    const internal = await internalService();
    const proxy = await strict.startEgressProxy();
    for (const target of [
      `http://127.0.0.1:${internal.port}/latest/meta-data/`,
      `http://localhost:${internal.port}/admin`,
      `http://[::1]:${internal.port}/`,
      "http://169.254.169.254/latest/meta-data/",
      "http://metadata.google.internal/computeMetadata/v1/",
    ]) {
      const res = await viaProxy(proxy.url, target);
      expect(res.status, target).toBe(403);
      expect(res.headers[strict.EGRESS_FAILURE_HEADER]).toBe("blocked: private or internal address");
      expect(res.body).not.toContain("secret");
    }
    expect(internal.hits).toEqual([]);
  });

  it("vets the address it connects to, so a rebinding answer after the route-guard check is refused", async () => {
    const internal = await internalService();
    const proxy = await strict.startEgressProxy();
    // First answer (the route guard / assertPublicUrl check) is public; the proxy's own lookup gets loopback.
    mocks.lookup
      .mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }])
      .mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    expect(await isAllowedHost("rebind.example.com")).toBe(true);
    const res = await viaProxy(proxy.url, `http://rebind.example.com:${internal.port}/admin`);
    expect(res.status).toBe(403);
    expect(strict.egressFailure(res.headers as Record<string, string>)).toBe("blocked: private or internal address");
    const tunnel = await connectViaProxy(proxy.url, `rebind.example.com:${internal.port}`);
    expect(tunnel.status).toBe(403);
    expect(internal.hits).toEqual([]);
  });

  it("refuses CONNECT tunnels to private literals and names that resolve privately", async () => {
    const internal = await internalService();
    const proxy = await strict.startEgressProxy();
    expect((await connectViaProxy(proxy.url, `127.0.0.1:${internal.port}`)).status).toBe(403);
    expect((await connectViaProxy(proxy.url, `[::ffff:127.0.0.1]:${internal.port}`)).status).toBe(403);
    expect((await connectViaProxy(proxy.url, "169.254.169.254:80")).status).toBe(403);
    resolvesTo("10.0.0.5");
    expect((await connectViaProxy(proxy.url, `intranet.example.com:${internal.port}`)).status).toBe(403);
    expect(internal.hits).toEqual([]);
  });

  it("returns the same proxy on every call", async () => {
    const a = await strict.startEgressProxy();
    const b = await strict.startEgressProxy();
    expect(a).toBe(b);
    expect(a.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });
});

describe("egress proxy (ALLOW_PRIVATE_TARGETS=1)", () => {
  it("forwards plain http requests and relays CONNECT tunnels", async () => {
    vi.resetModules();
    process.env.ALLOW_PRIVATE_TARGETS = "1";
    try {
      const relaxed = await import("../../src/scan/egress.js");
      const proxy = await relaxed.startEgressProxy();
      cleanups.push(
        () =>
          new Promise<void>((resolve) => {
            proxy.server.closeAllConnections();
            proxy.server.close(() => resolve());
          }),
      );
      const internal = await internalService();

      const get = await viaProxy(proxy.url, `http://127.0.0.1:${internal.port}/page?x=1`);
      expect(get.status).toBe(200);
      expect(get.body).toBe("internal secret");
      expect(get.headers["x-upstream"]).toBe("yes");
      const post = await viaProxy(proxy.url, `http://127.0.0.1:${internal.port}/form`, { method: "POST", body: "a=1" });
      expect(post.body).toBe("internal secret got=a=1");
      expect(internal.hits).toEqual(["GET /page?x=1", "POST /form"]);
      expect(internal.headers[0]?.["proxy-connection"]).toBeUndefined();
      expect(internal.headers[0]?.host).toBe(`127.0.0.1:${internal.port}`);

      // A site cannot fake the proxy's failure marker, and an unreachable site is reported as such.
      const faker = http.createServer((_req, res) => {
        res.writeHead(500, { [relaxed.EGRESS_FAILURE_HEADER]: "blocked: private or internal address" });
        res.end("real site error");
      });
      const fakerPort = await listen(faker);
      const faked = await viaProxy(proxy.url, `http://127.0.0.1:${fakerPort}/`);
      expect(faked.status).toBe(500);
      expect(relaxed.egressFailure(faked.headers as Record<string, string>)).toBeNull();
      const closed = http.createServer();
      const closedPort = await listen(closed);
      await new Promise<void>((resolve) => closed.close(() => resolve()));
      const refused = await viaProxy(proxy.url, `http://127.0.0.1:${closedPort}/`);
      expect(refused.status).toBe(502);
      expect(relaxed.egressFailure(refused.headers as Record<string, string>)).toBe("connection refused");

      const echo = net.createServer((socket) => socket.pipe(socket));
      const echoPort = await listen(echo);
      const tunnel = await connectViaProxy(proxy.url, `127.0.0.1:${echoPort}`);
      expect(tunnel.status).toBe(200);
      const socket = tunnel.socket as net.Socket;
      const reply = await new Promise<string>((resolve) => {
        socket.once("data", (chunk: Buffer) => resolve(chunk.toString("utf8")));
        socket.write("ping through the tunnel");
      });
      socket.destroy();
      expect(reply).toBe("ping through the tunnel");
    } finally {
      delete process.env.ALLOW_PRIVATE_TARGETS;
      vi.resetModules();
    }
  });
});
