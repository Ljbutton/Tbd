// STUB - replaced by step S5 (email).
import type { AuditRow, CreditCodeRow, Finding, OrderRow } from "../types.js";

export interface EmailContent {
  subject: string;
  html: string;
}

export function reportReady(_audit: AuditRow, _findings: Finding[]): EmailContent {
  throw new Error("not implemented: reportReady");
}

export function inReview(_audit: AuditRow): EmailContent {
  throw new Error("not implemented: inReview");
}

export function creditCode(_code: CreditCodeRow, _order: OrderRow): EmailContent {
  throw new Error("not implemented: creditCode");
}

export function rescanReminder(_audit: AuditRow): EmailContent {
  throw new Error("not implemented: rescanReminder");
}
