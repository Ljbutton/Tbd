// Crawler, scanner and browser-lifecycle tests against local servers in a real
// headless Chromium (pre-installed; see playwright.config.ts). Local servers
// live on 127.0.0.1, so these run with ALLOW_PRIVATE_TARGETS=1; every request
// still goes through the egress proxy, exactly as in production.

import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.ALLOW_PRIVATE_TARGETS = "1";
const { crawl, StartUrlUnreachableError } = await import("../../src/scan/crawler.js");
const { allowAll } = await import("../../src/scan/robots.js");
const { scanPage } = await import("../../src/scan/axe.js");
const { closeBrowser, closeContext, isBrowserReady, newScanContext } = await import("../../src/scan/browser.js");
const { runTeaser } = await import("../../src/scan/teaser.js");

type Routes = Record<string, (res: http.ServerResponse) => void>;

const servers: http.Server[] = [];

async function serve(routes: Routes): Promise<string> {
  const server = http.createServer((req, res) => {
    const handler = routes[req.url ?? "/"];
    if (handler) {
      handler(res);
      return;
    }
    res.writeHead(404, { "content-type": "text/html" });
    res.end("<!doctype html><html lang=en><head><title>Not found</title></head><body><h1>Not found</h1></body></html>");
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function html(title: string, body = ""): (res: http.ServerResponse) => void {
  return (res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html lang="en"><head><title>${title}</title></head><body><main><h1>${title}</h1>${body}</main></body></html>`);
  };
}

function status(code: number, title: string): (res: http.ServerResponse) => void {
  return (res) => {
    res.writeHead(code, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html><head><title>${title}</title></head><body><img src="challenge.png"><button></button><a href="/"></a></body></html>`);
  };
}

function redirect(code: number, location: string): (res: http.ServerResponse) => void {
  return (res) => {
    res.writeHead(code, { location });
    res.end();
  };
}

function links(...hrefs: string[]): string {
  return hrefs.map((href) => `<a href="${href}">${href}</a>`).join(" ");
}

async function expectStartFailure(startUrl: string, reason: RegExp): Promise<void> {
  let caught: unknown = null;
  try {
    await crawl({ startUrl, pageLimit: 5, robots: allowAll() });
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(StartUrlUnreachableError);
  expect((caught as InstanceType<typeof StartUrlUnreachableError>).message).toMatch(/^start_url_unreachable: /);
  expect((caught as InstanceType<typeof StartUrlUnreachableError>).reason).toMatch(reason);
}

beforeAll(() => {
  expect(process.env.ALLOW_PRIVATE_TARGETS).toBe("1");
});

afterAll(async () => {
  await closeBrowser({ force: true });
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe("crawl: start URL", () => {
  it("fails the audit when the start page returns 404 or 503 instead of auditing the error page", async () => {
    const origin = await serve({ "/down": status(503, "Service unavailable") });
    await expectStartFailure(`${origin}/nope.html`, /^start page returned HTTP 404$/);
    await expectStartFailure(`${origin}/down`, /^start page returned HTTP 503$/);
  });

  it("reports an unreachable start page by its network reason, not the proxy's status", async () => {
    const closed = http.createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    await expectStartFailure(`http://127.0.0.1:${port}/`, /^connection refused$/);
  });

  it("fails when the start page redirects to a different site", async () => {
    const foreign = await serve({ "/": html("Someone else") });
    const origin = await serve({ "/": redirect(302, `${foreign}/`) });
    await expectStartFailure(`${origin}/`, /redirects to http:\/\/127\.0\.0\.1:\d+, a different site/);
  });

  it("records the start page under its post-redirect URL", async () => {
    const origin = await serve({ "/": redirect(302, "/en/"), "/en/": html("Home") });
    const found = await crawl({ startUrl: `${origin}/`, pageLimit: 3, robots: allowAll() });
    expect(found).toEqual([`${origin}/en/`]);
  });
});

describe("crawl: discovered links", () => {
  it("skips error pages, off-site redirects and redirect aliases of pages already found", async () => {
    const foreign = await serve({ "/about.html": html("Foreign about page") });
    const origin = await serve({
      "/": html("Home", links("/missing", "/instagram", "/home-alias", "/about", "/about/", "/contact")),
      "/instagram": redirect(302, `${foreign}/about.html`),
      "/home-alias": redirect(302, "/"),
      "/about": redirect(301, "/about/"),
      "/about/": html("About"),
      "/contact": html("Contact"),
    });
    const messages: string[] = [];
    const found = await crawl({ startUrl: `${origin}/`, pageLimit: 10, robots: allowAll(), onProgress: (p) => messages.push(p.message) });
    expect(found).toEqual([`${origin}/`, `${origin}/about/`, `${origin}/contact`]);
    expect(messages).toContain(`skipped ${origin}/missing (HTTP 404)`);
    expect(messages.some((m) => m.startsWith(`skipped ${origin}/instagram (redirects off-site to ${foreign}`))).toBe(true);
    expect(messages.some((m) => m.startsWith(`skipped ${origin}/home-alias (redirects to ${origin}/`))).toBe(true);
    expect(found.some((url) => url.startsWith(foreign))).toBe(false);
  }, 60000);

  it("visits distinct paths before a third query-string variant of the same path", async () => {
    const origin = await serve({
      "/": html("Home", links("/list?page=1", "/list?page=2", "/list?page=3", "/list?page=4", "/about")),
      "/list?page=1": html("List 1"),
      "/list?page=2": html("List 2"),
      "/list?page=3": html("List 3"),
      "/list?page=4": html("List 4"),
      "/about": html("About", links("/team")),
      "/team": html("Team"),
    });
    // /team is two levels deep yet comes before ?page=3 and ?page=4 from the home page; with budget
    // to spare the deferred variants are still crawled, last.
    const found = await crawl({ startUrl: `${origin}/`, pageLimit: 10, robots: allowAll() });
    expect(found).toEqual([
      `${origin}/`,
      `${origin}/list?page=1`,
      `${origin}/list?page=2`,
      `${origin}/about`,
      `${origin}/team`,
      `${origin}/list?page=3`,
      `${origin}/list?page=4`,
    ]);
  }, 60000);
});

describe("scanPage", () => {
  it("treats a 4xx/5xx response as a failed scan instead of auditing the error page", async () => {
    const origin = await serve({ "/waf": status(503, "Access denied"), "/ok": html("Fine") });
    const context = await newScanContext("desktop");
    try {
      const page = await context.newPage();
      const failed = await scanPage(page, `${origin}/waf`, "desktop");
      expect(failed.error).toBe("HTTP 503");
      expect(failed.statusCode).toBe(503);
      expect(failed.title).toBe("");
      expect(failed.violations).toEqual([]);
      expect(failed.incomplete).toEqual([]);

      const ok = await scanPage(page, `${origin}/ok`, "desktop");
      expect(ok.error).toBeUndefined();
      expect(ok.statusCode).toBe(200);
      expect(ok.title).toBe("Fine");
    } finally {
      await closeContext(context);
    }
  });
});

describe("closeBrowser", () => {
  it("waits for a teaser scan in flight instead of killing it, then closes", async () => {
    const origin = await serve({
      "/slow": (res) => {
        setTimeout(() => html("Slow page", '<img src="x.png">')(res), 2500);
      },
    });
    const teaser = runTeaser(`${origin}/slow`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await closeBrowser(); // what runAudit does when an audit finishes
    expect(isBrowserReady()).toBe(true);
    const result = await teaser;
    expect(result.title).toBe("Slow page");
    expect(result.top.some((item) => item.ruleId === "image-alt")).toBe(true);
    // The deferred close runs once the teaser's context is gone.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(isBrowserReady()).toBe(false);
  });
});
