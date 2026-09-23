// Agency 5-Pack credit codes: creation, lookup and atomic redemption.
// Codes look like AA-XXXX-XXXX ("AA" for AccessAudit, then eight characters
// from an alphabet without 0/O/1/I so they survive being read out loud).

import { randomInt } from "node:crypto";
import { PRODUCTS } from "../config.js";
import { db, nowIso } from "../db.js";
import type { AuditRow, CreditCodeRow, OrderRow } from "../types.js";
import { HttpError } from "../util/http.js";
import { newId } from "../util/ids.js";

export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const CODE_PREFIX = "AA";
const CODE_RANDOM_LENGTH = 8;
const MAX_CREATE_ATTEMPTS = 25;

export const CREDIT_MESSAGES = {
  code_not_found: "We couldn't find that code. Check the email that came with your Agency 5-Pack.",
  no_credits_left: "No credits left on this code. Buy another 5-Pack to keep going.",
} as const;

const insertStmt = db.prepare(`
  INSERT INTO credit_codes (id, code, order_id, credits_total, credits_left, agency_name, agency_logo_path, created_at)
  VALUES (@id, @code, @order_id, @credits_total, @credits_left, @agency_name, @agency_logo_path, @created_at)
`);
const getByCodeStmt = db.prepare("SELECT * FROM credit_codes WHERE code = ?");
const getByIdStmt = db.prepare("SELECT * FROM credit_codes WHERE id = ?");
const getByOrderStmt = db.prepare("SELECT * FROM credit_codes WHERE order_id = ? ORDER BY created_at ASC LIMIT 1");
const redeemStmt = db.prepare("UPDATE credit_codes SET credits_left = credits_left - 1 WHERE code = ? AND credits_left > 0");
const auditsForCodeStmt = db.prepare("SELECT * FROM audits WHERE credit_code_id = ? ORDER BY created_at DESC");

/** A fresh random code in canonical AA-XXXX-XXXX form. */
export function randomCode(): string {
  let random = "";
  for (let i = 0; i < CODE_RANDOM_LENGTH; i++) {
    random += CODE_ALPHABET[randomInt(0, CODE_ALPHABET.length)];
  }
  return `${CODE_PREFIX}-${random.slice(0, 4)}-${random.slice(4)}`;
}

/**
 * Canonical form of user input: trims, uppercases, drops dashes/spaces and
 * re-inserts the dashes. Returns null when the input cannot be a code.
 */
export function normalizeCode(input: string): string | null {
  const compact = (input ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (compact.length !== CODE_PREFIX.length + CODE_RANDOM_LENGTH) return null;
  if (!compact.startsWith(CODE_PREFIX)) return null;
  const random = compact.slice(CODE_PREFIX.length);
  for (const ch of random) {
    if (!CODE_ALPHABET.includes(ch)) return null;
  }
  return `${CODE_PREFIX}-${random.slice(0, 4)}-${random.slice(4)}`;
}

function isUniqueViolation(err: unknown): boolean {
  const code = typeof err === "object" && err !== null && "code" in err ? (err as { code?: unknown }).code : undefined;
  return code === "SQLITE_CONSTRAINT_UNIQUE" || code === "SQLITE_CONSTRAINT" || code === "SQLITE_CONSTRAINT_PRIMARYKEY";
}

/**
 * Creates the credit code for a paid Agency 5-Pack order (5 credits, agency
 * name and logo copied from the order). Retries on a UNIQUE conflict.
 * `generate` is injectable so tests can force a collision.
 */
export function createCreditCode(order: OrderRow, generate: () => string = randomCode): CreditCodeRow {
  const total = PRODUCTS.pack5.credits;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS; attempt++) {
    const id = newId();
    const code = generate();
    try {
      insertStmt.run({
        id,
        code,
        order_id: order.id,
        credits_total: total,
        credits_left: total,
        agency_name: order.agency_name ?? null,
        agency_logo_path: order.agency_logo_path ?? null,
        created_at: nowIso(),
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        lastError = err;
        continue;
      }
      throw err;
    }
    const row = getByIdStmt.get(id) as CreditCodeRow | undefined;
    if (!row) throw new Error("credit code insert did not persist");
    return row;
  }
  throw new Error(`could not allocate a unique credit code after ${MAX_CREATE_ATTEMPTS} attempts: ${String(lastError)}`);
}

/** Looks a code up case-insensitively, ignoring dashes and whitespace. */
export function getCode(code: string): CreditCodeRow | null {
  const canonical = normalizeCode(code);
  if (canonical === null) return null;
  return (getByCodeStmt.get(canonical) as CreditCodeRow | undefined) ?? null;
}

export function getCodeById(id: string): CreditCodeRow | null {
  if (!id) return null;
  return (getByIdStmt.get(id) as CreditCodeRow | undefined) ?? null;
}

/** The code issued for an order (null for orders that are not a paid 5-Pack). */
export function getCodeByOrder(orderId: string): CreditCodeRow | null {
  if (!orderId) return null;
  return (getByOrderStmt.get(orderId) as CreditCodeRow | undefined) ?? null;
}

/**
 * Atomically takes one credit: a single conditional UPDATE, so two concurrent
 * redemptions of the last credit can never both succeed. Throws HttpError
 * with code `code_not_found` (404) or `no_credits_left` (400).
 */
export function redeemCredit(code: string): CreditCodeRow {
  const canonical = normalizeCode(code);
  if (canonical === null) throw new HttpError(404, CREDIT_MESSAGES.code_not_found, "code_not_found");
  const result = redeemStmt.run(canonical);
  if (result.changes === 1) {
    const row = getByCodeStmt.get(canonical) as CreditCodeRow | undefined;
    if (!row) throw new Error("credit code vanished during redemption");
    return row;
  }
  const existing = getByCodeStmt.get(canonical) as CreditCodeRow | undefined;
  if (!existing) throw new HttpError(404, CREDIT_MESSAGES.code_not_found, "code_not_found");
  throw new HttpError(400, CREDIT_MESSAGES.no_credits_left, "no_credits_left");
}

/** Audits started with this code, newest first. */
export function auditsForCode(codeId: string): AuditRow[] {
  if (!codeId) return [];
  return auditsForCodeStmt.all(codeId) as AuditRow[];
}
