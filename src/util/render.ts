/**
 * Page rendering helper used by every HTML route.
 *
 *   await renderPage(res, "index", { title: "Home", faq, foundingLeft });
 *   await renderPage(res, "error", { title: "Not found", status: 404, message }, 404);
 *
 * renderPage() renders `views/<view>.ejs` with `locals` to a string, then wraps
 * that string in `views/layout.ejs` as `body`. The layout (and the view) receive:
 *   - title        page title (string; the layout appends " | AccessAudit")
 *   - body         the rendered view HTML (layout only, inserted with <%- body %>)
 *   - head         optional raw HTML for <head> (meta description, JSON-LD); default ""
 *   - mockPayments / mockLlm / emailOutbox   config mode flags (TEST MODE chip etc.)
 *   - baseUrl      config.baseUrl
 *   - escapeHtml / nl2br / textToHtml        helpers for the rare <%- %> uses
 *   - ...locals    everything the route passed
 *
 * renderView() renders a single view file to a string without the layout (fragments,
 * emails, embedded report). Both throw on template errors so the error middleware
 * can respond; the middleware itself falls back to plain text if the layout fails.
 */

import path from "node:path";
import ejs from "ejs";
import type { Response } from "express";
import { ROOT_DIR, config } from "../config.js";
import { escapeHtml, nl2br, textToHtml } from "./http.js";

export const VIEWS_DIR = path.join(ROOT_DIR, "views");

export type ViewLocals = Record<string, unknown>;

function sharedLocals(): ViewLocals {
  return {
    mockPayments: config.mockPayments,
    mockLlm: config.mockLlm,
    emailOutbox: config.emailOutbox,
    baseUrl: config.baseUrl,
    nodeEnv: config.nodeEnv,
    escapeHtml,
    nl2br,
    textToHtml,
  };
}

const ejsOptions: ejs.Options = {
  cache: config.nodeEnv === "production",
  rmWhitespace: false,
};

/** Renders views/<view>.ejs to a string (no layout). */
export async function renderView(view: string, locals: ViewLocals = {}): Promise<string> {
  const file = path.join(VIEWS_DIR, `${view}.ejs`);
  return ejs.renderFile(file, { ...sharedLocals(), ...locals }, { ...ejsOptions, filename: file });
}

/** Renders views/<view>.ejs inside views/layout.ejs and sends it with the given status. */
export async function renderPage(res: Response, view: string, locals: ViewLocals = {}, status = 200): Promise<void> {
  const title = typeof locals.title === "string" && locals.title.trim() !== "" ? locals.title : "AccessAudit";
  const head = typeof locals.head === "string" ? locals.head : "";
  const body = await renderView(view, { ...locals, title, head });
  const layoutFile = path.join(VIEWS_DIR, "layout.ejs");
  const html = await ejs.renderFile(
    layoutFile,
    { ...sharedLocals(), ...locals, title, head, body },
    { ...ejsOptions, filename: layoutFile },
  );
  res.status(status).type("html").send(html);
}
