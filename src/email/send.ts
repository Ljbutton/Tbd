// Outbound email (spec section 12). Every message is recorded in the
// emails_outbox table: with no RESEND_API_KEY it is stored there instead of
// being sent (and shown at /outbox); with a key it goes through Resend and the
// row records `sent_via: 'resend'`. A Resend failure is logged and the message
// is kept as an outbox row, so a mail problem can never fail an audit or a
// payment: sendEmail() never rejects.

import { Resend } from "resend";
import { config } from "../config.js";
import { db, nowIso } from "../db.js";
import type { EmailRow } from "../types.js";
import { newId } from "../util/ids.js";

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
}

export interface SendEmailResult {
  /** Id of the emails_outbox row (empty when even the insert failed). */
  id: string;
  sentVia: "outbox" | "resend";
  /** Why delivery fell back to the outbox, or null when nothing went wrong. */
  error: string | null;
}

const insertStmt = db.prepare(
  "INSERT INTO emails_outbox (id, to_email, subject, html, sent_via, created_at) VALUES (?, ?, ?, ?, ?, ?)",
);
const listStmt = db.prepare("SELECT * FROM emails_outbox ORDER BY created_at DESC, rowid DESC LIMIT ?");
const getStmt = db.prepare("SELECT * FROM emails_outbox WHERE id = ?");
const listToStmt = db.prepare(
  "SELECT * FROM emails_outbox WHERE to_email = ? COLLATE NOCASE ORDER BY created_at DESC, rowid DESC LIMIT ?",
);

/** The first http(s) link in an HTML string (href attribute or bare URL), or null. */
export function firstHttpLink(html: string): string | null {
  const href = /href\s*=\s*["'](https?:\/\/[^"']+)["']/i.exec(html);
  if (href?.[1]) return href[1];
  const bare = /https?:\/\/[^\s"'<>]+/i.exec(html);
  return bare ? bare[0] : null;
}

/** Every distinct http(s) link in an HTML string, in document order (used by the outbox viewer). */
export function extractHttpLinks(html: string): string[] {
  const links: string[] = [];
  const seen = new Set<string>();
  const pattern = /href\s*=\s*["'](https?:\/\/[^"']+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    const url = decodeEntities(match[1] ?? "");
    if (url && !seen.has(url)) {
      seen.add(url);
      links.push(url);
    }
  }
  return links;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null && "message" in err) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(err);
}

function storeRow(msg: EmailMessage, sentVia: "outbox" | "resend"): string {
  const id = newId();
  insertStmt.run(id, msg.to, msg.subject, msg.html, sentVia, nowIso());
  return id;
}

async function sendViaResend(msg: EmailMessage): Promise<void> {
  const apiKey = config.resend.apiKey;
  if (!apiKey) throw new Error("RESEND_API_KEY is not set");
  const resend = new Resend(apiKey);
  const response = await resend.emails.send({
    from: config.resend.from,
    to: msg.to,
    subject: msg.subject,
    html: msg.html,
  });
  if (response.error) {
    const status = response.error.statusCode === null ? "" : ` (${response.error.statusCode})`;
    throw new Error(`${response.error.name}${status}: ${response.error.message}`);
  }
}

/**
 * Sends an email, or stores it in the outbox when no Resend key is configured.
 * Never rejects: a failed send is logged and kept as an outbox row.
 */
export async function sendEmail(msg: EmailMessage): Promise<SendEmailResult> {
  const message: EmailMessage = {
    to: String(msg.to ?? "").trim(),
    subject: String(msg.subject ?? "").trim(),
    html: String(msg.html ?? ""),
  };

  if (config.emailOutbox) {
    try {
      const id = storeRow(message, "outbox");
      const link = firstHttpLink(message.html);
      console.log("EMAIL (outbox) to=%s subject=%s%s", message.to, message.subject, link ? ` link=${link}` : "");
      return { id, sentVia: "outbox", error: null };
    } catch (err) {
      const reason = describeError(err);
      console.error("EMAIL (outbox) could not store message to=%s subject=%s: %s", message.to, message.subject, reason);
      return { id: "", sentVia: "outbox", error: reason };
    }
  }

  let deliveryError: string | null = null;
  try {
    if (!message.to) throw new Error("recipient address is empty");
    await sendViaResend(message);
  } catch (err) {
    deliveryError = describeError(err);
    console.error("EMAIL (resend) failed to=%s subject=%s: %s", message.to, message.subject, deliveryError);
  }

  const sentVia: "outbox" | "resend" = deliveryError === null ? "resend" : "outbox";
  try {
    const id = storeRow(message, sentVia);
    if (sentVia === "resend") console.log("EMAIL (resend) to=%s subject=%s", message.to, message.subject);
    return { id, sentVia, error: deliveryError };
  } catch (err) {
    const reason = describeError(err);
    console.error("EMAIL could not record message to=%s subject=%s: %s", message.to, message.subject, reason);
    return { id: "", sentVia, error: deliveryError ?? reason };
  }
}

/** Most recent emails (both stored-only and sent), newest first. */
export function listOutbox(limit = 50): EmailRow[] {
  return listStmt.all(Math.max(1, Math.floor(limit))) as EmailRow[];
}

export function getOutboxEmail(id: string): EmailRow | null {
  if (!id) return null;
  return (getStmt.get(id) as EmailRow | undefined) ?? null;
}

/** Emails addressed to one recipient, newest first (admin audit detail). */
export function listEmailsTo(email: string, limit = 10): EmailRow[] {
  const address = (email ?? "").trim();
  if (!address) return [];
  return listToStmt.all(address, Math.max(1, Math.floor(limit))) as EmailRow[];
}
