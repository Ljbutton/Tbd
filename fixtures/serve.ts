// Static server for the fixture site (fixtures/site). Used by unit/e2e tests,
// by `npm run sample`, and standalone: `tsx fixtures/serve.ts 4100`.

import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SITE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "site");

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".pdf": "application/pdf",
};

function notFoundPage(pathname: string): string {
  const safe = pathname.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Not found - Northwind Candles</title></head><body><main><h1>Page not found</h1><p>There is nothing at ${safe}.</p><p><a href="/">Back to the shop</a></p></main></body></html>`;
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const requestUrl = new URL(req.url ?? "/", "http://fixture.local");
  let pathname: string;
  try {
    pathname = decodeURIComponent(requestUrl.pathname);
  } catch {
    pathname = "/";
  }
  if (pathname.endsWith("/")) pathname += "index.html";

  const resolved = path.resolve(SITE_DIR, `.${path.posix.normalize(pathname)}`);
  const inside = resolved === SITE_DIR || resolved.startsWith(SITE_DIR + path.sep);
  if (!inside) {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    res.end("Forbidden");
    return;
  }

  let data: Buffer;
  try {
    const stat = await fs.stat(resolved);
    if (stat.isDirectory()) {
      res.writeHead(302, { location: `${pathname}/` });
      res.end();
      return;
    }
    data = await fs.readFile(resolved);
  } catch {
    const body = notFoundPage(pathname);
    res.writeHead(404, { "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(body) });
    res.end(req.method === "HEAD" ? undefined : body);
    return;
  }

  const type = MIME_TYPES[path.extname(resolved).toLowerCase()] ?? "application/octet-stream";
  res.writeHead(200, { "content-type": type, "content-length": data.length, "cache-control": "no-store" });
  res.end(req.method === "HEAD" ? undefined : data);
}

export function createFixtureServer(): http.Server {
  return http.createServer((req, res) => {
    handleRequest(req, res).catch((err: unknown) => {
      console.error("fixture server error", err);
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end("Internal error");
    });
  });
}

export interface FixtureServer {
  url: string;
  close: () => Promise<void>;
}

/** Starts the fixture site on 127.0.0.1 (random port unless given) and returns its base URL. */
export async function startFixtureServer(port = 0): Promise<FixtureServer> {
  const server = createFixtureServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  return Boolean(entry) && path.resolve(entry as string) === fileURLToPath(import.meta.url);
}

if (isEntryPoint()) {
  const requested = Number(process.argv[2] ?? 4100);
  const port = Number.isInteger(requested) && requested >= 0 && requested < 65536 ? requested : 4100;
  startFixtureServer(port)
    .then(({ url }) => {
      console.log(`Northwind Candles fixture site: ${url}`);
    })
    .catch((err: unknown) => {
      console.error(err);
      process.exit(1);
    });
}
