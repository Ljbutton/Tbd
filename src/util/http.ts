import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";

/**
 * Error carrying an HTTP status. The error middleware in server.ts renders it
 * as JSON `{error: code, message}` under /api/* and as views/error.ejs elsewhere.
 */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code ?? defaultCode(status);
  }
}

function defaultCode(status: number): string {
  switch (status) {
    case 400:
      return "bad_request";
    case 401:
      return "unauthorized";
    case 403:
      return "forbidden";
    case 404:
      return "not_found";
    case 429:
      return "rate_limited";
    case 503:
      return "unavailable";
    default:
      return status >= 500 ? "server_error" : "error";
  }
}

export type AsyncRouteHandler = (req: Request, res: Response, next: NextFunction) => Promise<unknown> | unknown;

/** Wraps a (possibly async) route handler so thrown errors and rejections reach the error middleware. */
export function asyncHandler(fn: AsyncRouteHandler): RequestHandler {
  return (req, res, next) => {
    Promise.resolve()
      .then(() => fn(req, res, next))
      .catch(next);
  };
}

/** Constant-time string comparison that does not leak length differences. */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

export interface BasicAuthOptions {
  /** Expected username. Default "admin". */
  username?: string;
  /** Expected password, or a function returning it. `null` means "not configured" and yields 503. */
  password: string | null | (() => string | null);
  /** Realm sent in the WWW-Authenticate challenge. Default "admin". */
  realm?: string;
}

/**
 * Basic-auth middleware factory with timing-safe comparison.
 * - No/invalid credentials: 401 with `WWW-Authenticate: Basic realm="<realm>"`.
 * - Password not configured (null): 503 "ADMIN_PASSWORD not set".
 */
export function basicAuth(options: BasicAuthOptions): RequestHandler {
  const username = options.username ?? "admin";
  const realm = options.realm ?? "admin";
  const getPassword = typeof options.password === "function" ? options.password : () => options.password as string | null;

  return (req, res, next) => {
    const expected = getPassword();
    if (expected === null) {
      next(new HttpError(503, "ADMIN_PASSWORD not set", "admin_password_missing"));
      return;
    }
    const header = req.headers.authorization ?? "";
    const match = /^Basic\s+(.+)$/i.exec(header);
    let ok = false;
    if (match) {
      const decoded = Buffer.from(match[1] ?? "", "base64").toString("utf8");
      const idx = decoded.indexOf(":");
      const user = idx >= 0 ? decoded.slice(0, idx) : decoded;
      const pass = idx >= 0 ? decoded.slice(idx + 1) : "";
      // Evaluate both comparisons so timing does not reveal which part failed.
      const userOk = safeEqual(user, username);
      const passOk = safeEqual(pass, expected);
      ok = userOk && passOk;
    }
    if (!ok) {
      res.setHeader("WWW-Authenticate", `Basic realm="${realm}"`);
      next(new HttpError(401, "Authentication required", "unauthorized"));
      return;
    }
    next();
  };
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escapes a value for safe insertion into HTML text or attribute content. */
export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch);
}

/** Turns newlines into <br> tags. Expects ALREADY-ESCAPED text; use textToHtml() for raw strings. */
export function nl2br(escapedText: string): string {
  return escapedText.replace(/\r\n|\r|\n/g, "<br>\n");
}

/** escapeHtml then nl2br: the only safe way to output multi-line user or narrative text with <%- %>. */
export function textToHtml(value: unknown): string {
  return nl2br(escapeHtml(value));
}
