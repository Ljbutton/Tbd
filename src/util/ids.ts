import { randomBytes, randomUUID } from "node:crypto";

/** UUID v4 string, used for every primary key. */
export function newId(): string {
  return randomUUID();
}

/** 128-bit random report token as 22-char base64url (no padding). Unguessable; used in /r/:token URLs. */
export function newToken(): string {
  return randomBytes(16).toString("base64url");
}
