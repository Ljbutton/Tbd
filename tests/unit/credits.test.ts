import { describe, expect, it } from "vitest";
import type { HttpError } from "../../src/util/http.js";
import { useFreshDataDir } from "./helpers/data-dir.js";

useFreshDataDir("credits");
const { db } = await import("../../src/db.js");
const credits = await import("../../src/payments/credits.js");
const { createOrder } = await import("../../src/payments/orders.js");
const { createAudit } = await import("../../src/audits.js");

const CODE_PATTERN = /^AA-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;

function pack5Order(overrides: { agency_name?: string; agency_logo_path?: string | null; email?: string } = {}) {
  return createOrder({
    email: overrides.email ?? "agency@example.com",
    product: "pack5",
    agency_name: overrides.agency_name ?? "Bright Pixel Studio",
    agency_logo_path: overrides.agency_logo_path ?? null,
    amount_cents: 14900,
  });
}

function caught(fn: () => unknown): HttpError | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err as HttpError;
  }
}

describe("randomCode / normalizeCode", () => {
  it("generates AA-XXXX-XXXX codes from the ambiguity-free alphabet", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 300; i++) {
      const code = credits.randomCode();
      expect(code).toMatch(CODE_PATTERN);
      expect(code).not.toMatch(/[0O1I]/);
      seen.add(code);
    }
    expect(seen.size).toBeGreaterThan(290);
    expect(credits.CODE_ALPHABET).toBe("ABCDEFGHJKLMNPQRSTUVWXYZ23456789");
  });

  it("normalizes case, dashes and whitespace and rejects malformed input", () => {
    expect(credits.normalizeCode("AA-BCDE-FGHJ")).toBe("AA-BCDE-FGHJ");
    expect(credits.normalizeCode("aa-bcde-fghj")).toBe("AA-BCDE-FGHJ");
    expect(credits.normalizeCode("aabcdefghj")).toBe("AA-BCDE-FGHJ");
    expect(credits.normalizeCode("  aa bcde fghj \n")).toBe("AA-BCDE-FGHJ");
    expect(credits.normalizeCode("AA_BCDE_FGHJ")).toBe("AA-BCDE-FGHJ");
    expect(credits.normalizeCode("")).toBeNull();
    expect(credits.normalizeCode("AA-BCDE-FGH")).toBeNull();
    expect(credits.normalizeCode("AA-BCDE-FGHJK")).toBeNull();
    expect(credits.normalizeCode("BB-BCDE-FGHJ")).toBeNull();
    expect(credits.normalizeCode("AA-BCDE-FGH0")).toBeNull();
    expect(credits.normalizeCode("AA-BCDE-FGHI")).toBeNull();
  });
});

describe("createCreditCode", () => {
  it("issues 5 credits and copies the agency details from the order", () => {
    const order = pack5Order({ agency_logo_path: "/data/logos/x.png" });
    const code = credits.createCreditCode(order);
    expect(code.code).toMatch(CODE_PATTERN);
    expect(code.order_id).toBe(order.id);
    expect(code.credits_total).toBe(5);
    expect(code.credits_left).toBe(5);
    expect(code.agency_name).toBe("Bright Pixel Studio");
    expect(code.agency_logo_path).toBe("/data/logos/x.png");
    expect(code.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(credits.getCodeById(code.id)).toEqual(code);
    expect(credits.getCodeByOrder(order.id)).toEqual(code);
    expect(credits.getCodeByOrder("nope")).toBeNull();
  });

  it("retries when the generated code already exists", () => {
    const first = credits.createCreditCode(pack5Order());
    const attempts: string[] = [];
    const generate = (): string => {
      const next = attempts.length === 0 ? first.code : credits.randomCode();
      attempts.push(next);
      return next;
    };
    const second = credits.createCreditCode(pack5Order(), generate);
    expect(attempts.length).toBeGreaterThanOrEqual(2);
    expect(attempts[0]).toBe(first.code);
    expect(second.code).not.toBe(first.code);
    expect(second.code).toMatch(CODE_PATTERN);
    expect((db.prepare("SELECT COUNT(*) AS n FROM credit_codes WHERE code = ?").get(first.code) as { n: number }).n).toBe(1);
  });

  it("gives up after repeated collisions instead of looping forever", () => {
    const existing = credits.createCreditCode(pack5Order());
    expect(() => credits.createCreditCode(pack5Order(), () => existing.code)).toThrow(/unique credit code/);
  });
});

describe("getCode", () => {
  it("finds codes case-insensitively, with or without dashes, and returns null otherwise", () => {
    const code = credits.createCreditCode(pack5Order());
    expect(credits.getCode(code.code)).toEqual(code);
    expect(credits.getCode(code.code.toLowerCase())).toEqual(code);
    expect(credits.getCode(code.code.replace(/-/g, ""))).toEqual(code);
    expect(credits.getCode(`  ${code.code.toLowerCase().replace(/-/g, " ")}  `)).toEqual(code);
    expect(credits.getCode("AA-ZZZZ-ZZZZ")).toBeNull();
    expect(credits.getCode("")).toBeNull();
    expect(credits.getCode("not a code")).toBeNull();
  });
});

describe("redeemCredit", () => {
  it("takes exactly one credit per call and stops at zero", () => {
    const code = credits.createCreditCode(pack5Order());
    for (let expected = 4; expected >= 0; expected--) {
      const fresh = credits.redeemCredit(expected === 4 ? code.code.toLowerCase() : code.code);
      expect(fresh.credits_left).toBe(expected);
      expect(fresh.id).toBe(code.id);
    }
    const err = caught(() => credits.redeemCredit(code.code));
    expect(err?.code).toBe("no_credits_left");
    expect(err?.status).toBe(400);
    expect(err?.message).toBe(credits.CREDIT_MESSAGES.no_credits_left);
    expect(credits.getCode(code.code)?.credits_left).toBe(0);
  });

  it("throws code_not_found for unknown or malformed codes", () => {
    const unknown = caught(() => credits.redeemCredit("AA-ZZZZ-ZZZZ"));
    expect(unknown?.code).toBe("code_not_found");
    expect(unknown?.status).toBe(404);
    const malformed = caught(() => credits.redeemCredit("nope"));
    expect(malformed?.code).toBe("code_not_found");
    expect(malformed?.status).toBe(404);
  });

  it("rolls back inside a failed transaction so the credit is not lost", () => {
    const code = credits.createCreditCode(pack5Order());
    const failing = db.transaction(() => {
      credits.redeemCredit(code.code);
      throw new Error("audit insert failed");
    });
    expect(() => failing()).toThrow("audit insert failed");
    expect(credits.getCode(code.code)?.credits_left).toBe(5);
  });
});

describe("auditsForCode", () => {
  it("lists audits created with the code, newest first", () => {
    const order = pack5Order();
    const code = credits.createCreditCode(order);
    const other = credits.createCreditCode(pack5Order());
    const a1 = createAudit({
      email: order.email,
      url: "https://client-one.example/",
      origin: "https://client-one.example",
      page_limit: 30,
      white_label: 1,
      agency_name: code.agency_name,
      tier: "pack5",
      order_id: order.id,
      credit_code_id: code.id,
    });
    const a2 = createAudit({
      email: order.email,
      url: "https://client-two.example/",
      origin: "https://client-two.example",
      page_limit: 30,
      white_label: 1,
      agency_name: code.agency_name,
      tier: "pack5",
      order_id: order.id,
      credit_code_id: code.id,
    });
    db.prepare("UPDATE audits SET created_at = ? WHERE id = ?").run("2020-01-01T00:00:00.000Z", a1.id);
    createAudit({
      email: "someone@example.com",
      url: "https://elsewhere.example/",
      origin: "https://elsewhere.example",
      page_limit: 30,
      white_label: 1,
      tier: "pack5",
      credit_code_id: other.id,
    });
    const listed = credits.auditsForCode(code.id);
    expect(listed.map((a) => a.id)).toEqual([a2.id, a1.id]);
    expect(credits.auditsForCode(other.id)).toHaveLength(1);
    expect(credits.auditsForCode("missing")).toEqual([]);
    expect(credits.auditsForCode("")).toEqual([]);
  });
});
