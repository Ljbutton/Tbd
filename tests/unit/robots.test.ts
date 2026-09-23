import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import { allowAll, compileRobotsPattern, loadRobots, parseRobots } from "../../src/scan/robots.js";

describe("parseRobots", () => {
  it("uses only the * group and ignores other agents", () => {
    const robots = parseRobots(`
      # Northwind
      User-agent: Googlebot
      Disallow: /google-only/

      User-agent: *
      Disallow: /private/
      Disallow: /tmp

      User-agent: Bingbot
      Disallow: /
    `);
    expect(robots.fetched).toBe(true);
    expect(robots.rules.map((r) => r.pattern)).toEqual(["/private/", "/tmp"]);
    expect(robots.isAllowed("/private/secret.html")).toBe(false);
    expect(robots.isAllowed("/private")).toBe(true);
    expect(robots.isAllowed("/tmp")).toBe(false);
    expect(robots.isAllowed("/tmpfiles/x")).toBe(false);
    expect(robots.isAllowed("/google-only/page")).toBe(true);
    expect(robots.isAllowed("/")).toBe(true);
    expect(robots.isAllowed("/about.html")).toBe(true);
  });

  it("merges several * groups and shares rules across consecutive user-agent lines", () => {
    const robots = parseRobots(`
      User-agent: Foo
      User-agent: *
      Disallow: /a/

      User-agent: *
      Disallow: /b/
    `);
    expect(robots.isAllowed("/a/x")).toBe(false);
    expect(robots.isAllowed("/b/x")).toBe(false);
    expect(robots.isAllowed("/c/x")).toBe(true);
  });

  it("treats an empty Disallow as allow-all and is case-insensitive on field names", () => {
    const empty = parseRobots("User-agent: *\nDisallow:\n");
    expect(empty.rules).toHaveLength(0);
    expect(empty.isAllowed("/anything")).toBe(true);
    const mixedCase = parseRobots("USER-AGENT: *\nDISALLOW: /x/\nallow: /x/ok\n");
    expect(mixedCase.isAllowed("/x/no")).toBe(false);
    expect(mixedCase.isAllowed("/x/ok")).toBe(true);
  });

  it("lets the longest matching rule win, with Allow beating Disallow on ties", () => {
    const robots = parseRobots(`
      User-agent: *
      Disallow: /shop/
      Allow: /shop/public/
      Disallow: /shop/public/hidden
      Allow: /tie
      Disallow: /tie
    `);
    expect(robots.isAllowed("/shop/cart")).toBe(false);
    expect(robots.isAllowed("/shop/public/item")).toBe(true);
    expect(robots.isAllowed("/shop/public/hidden-thing")).toBe(false);
    expect(robots.isAllowed("/tie")).toBe(true);
    expect(robots.isAllowed("/tiebreak")).toBe(true);
  });

  it("supports * wildcards and $ end anchors", () => {
    const robots = parseRobots(`
      User-agent: *
      Disallow: /*.pdf$
      Disallow: /*?session=
      Disallow: /print/*/draft
      Allow: /downloads/*.pdf$
    `);
    expect(robots.isAllowed("/guide.pdf")).toBe(false);
    expect(robots.isAllowed("/docs/guide.pdf")).toBe(false);
    expect(robots.isAllowed("/guide.pdfx")).toBe(true);
    expect(robots.isAllowed("/guide.pdf?x=1")).toBe(true);
    expect(robots.isAllowed("/page?session=abc")).toBe(false);
    expect(robots.isAllowed("/page?sessionless=1")).toBe(true);
    expect(robots.isAllowed("/print/2024/draft")).toBe(false);
    expect(robots.isAllowed("/print/2024/final")).toBe(true);
    expect(robots.isAllowed("/downloads/report.pdf")).toBe(true);
  });

  it("escapes regex metacharacters in patterns and tolerates paths without a leading slash", () => {
    expect(compileRobotsPattern("/a.b(c)+[d]").test("/a.b(c)+[d]/x")).toBe(true);
    expect(compileRobotsPattern("/a.b").test("/axb")).toBe(false);
    const robots = parseRobots("User-agent: *\nDisallow: private/\n");
    expect(robots.isAllowed("private/x")).toBe(false);
    expect(robots.isAllowed("")).toBe(true);
  });

  it("allowAll permits everything", () => {
    const robots = allowAll();
    expect(robots.fetched).toBe(false);
    expect(robots.isAllowed("/private/")).toBe(true);
  });
});

describe("loadRobots", () => {
  const servers: http.Server[] = [];

  async function serve(handler: http.RequestListener): Promise<string> {
    const server = http.createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  afterAll(async () => {
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("fetches and parses /robots.txt from the origin", async () => {
    let requestedPath = "";
    const origin = await serve((req, res) => {
      requestedPath = req.url ?? "";
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("User-agent: *\nDisallow: /private/\n");
    });
    const robots = await loadRobots(`${origin}/some/deep/page.html`);
    expect(requestedPath).toBe("/robots.txt");
    expect(robots.fetched).toBe(true);
    expect(robots.isAllowed("/private/secret.html")).toBe(false);
    expect(robots.isAllowed("/about.html")).toBe(true);
  });

  it("allows everything on a non-200 response", async () => {
    const origin = await serve((_req, res) => {
      res.writeHead(404, { "content-type": "text/html" });
      res.end("<h1>Not found</h1>");
    });
    const robots = await loadRobots(origin);
    expect(robots.fetched).toBe(false);
    expect(robots.isAllowed("/private/")).toBe(true);
  });

  it("allows everything when the server is unreachable", async () => {
    const probe = await serve((_req, res) => res.end());
    const server = servers.pop() as http.Server;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const robots = await loadRobots(probe);
    expect(robots.fetched).toBe(false);
    expect(robots.isAllowed("/anything")).toBe(true);
  });

  it("allows everything when the request times out", async () => {
    const origin = await serve(() => {
      // Never respond; the fetch must give up on its own.
    });
    const robots = await loadRobots(origin, { timeoutMs: 300 });
    expect(robots.fetched).toBe(false);
    expect(robots.isAllowed("/private/")).toBe(true);
  });

  it("allows everything for an unparsable origin", async () => {
    const robots = await loadRobots("not an origin");
    expect(robots.fetched).toBe(false);
    expect(robots.isAllowed("/x")).toBe(true);
  });
});
