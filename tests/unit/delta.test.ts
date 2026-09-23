import { describe, expect, it } from "vitest";
import { computeDelta, percentFixed } from "../../src/report/delta.js";
import type { Finding } from "../../src/types.js";

function finding(rank: number, ruleId: string, nodesTotal: number, help = `Help for ${ruleId}`): Finding {
  return {
    rank,
    ruleId,
    impact: "serious",
    category: "other",
    wcagTags: ["wcag2a"],
    pagesAffected: 1,
    nodesTotal,
    litigationWeight: 1,
    score: 10,
    confidence: "automated",
    examplePageUrl: "http://s/",
    exampleSelector: "div",
    exampleHtml: "<div></div>",
    screenshotPath: null,
    help,
    helpUrl: `https://dequeuniversity.com/rules/axe/4.10/${ruleId}`,
    affectedUrls: ["http://s/"],
  };
}

const meta = { originalAuditId: "audit-1", originalDate: "2026-09-01T10:00:00.000Z", rescanDate: "2026-09-20T10:00:00.000Z" };

describe("percentFixed", () => {
  it("rounds to the nearest whole percent", () => {
    expect(percentFixed(10, 3)).toBe(70);
    expect(percentFixed(3, 1)).toBe(67);
    expect(percentFixed(3, 2)).toBe(33);
    expect(percentFixed(8, 0)).toBe(100);
  });

  it("clamps to 0-100 and returns 0 when nothing was measured before", () => {
    expect(percentFixed(0, 0)).toBe(0);
    expect(percentFixed(0, 5)).toBe(0);
    expect(percentFixed(4, 9)).toBe(0);
    expect(percentFixed(4, -1)).toBe(100);
  });
});

describe("computeDelta", () => {
  it("classifies rules as fixed, new or unchanged with node counts and dictionary titles", () => {
    const original = [finding(1, "image-alt", 7), finding(2, "color-contrast", 12), finding(3, "custom-rule", 1, "Custom things must be custom")];
    const rescan = [finding(1, "color-contrast", 4), finding(2, "link-name", 2)];
    const delta = computeDelta(original, rescan, meta);

    expect(delta.originalAuditId).toBe("audit-1");
    expect(delta.originalDate).toBe(meta.originalDate);
    expect(delta.rescanDate).toBe(meta.rescanDate);

    expect(delta.fixed).toEqual([
      { ruleId: "image-alt", title: "Images are missing text descriptions", before: 7, after: 0 },
      { ruleId: "custom-rule", title: "Custom things must be custom", before: 1, after: 0 },
    ]);
    expect(delta.unchanged).toEqual([
      { ruleId: "color-contrast", title: "Text is too light against its background", before: 12, after: 4 },
    ]);
    expect(delta.newIssues).toEqual([{ ruleId: "link-name", title: "Links have no readable text", before: 0, after: 2 }]);

    expect(delta.nodesBefore).toBe(20);
    expect(delta.nodesAfter).toBe(6);
    // round(100 * (20 - 6) / 20) = 70
    expect(delta.percentFixed).toBe(70);
  });

  it("reports 100% when everything was fixed and 0% when nothing was found originally", () => {
    const allFixed = computeDelta([finding(1, "image-alt", 3)], [], meta);
    expect(allFixed.percentFixed).toBe(100);
    expect(allFixed.nodesAfter).toBe(0);
    expect(allFixed.unchanged).toEqual([]);
    expect(allFixed.newIssues).toEqual([]);

    const nothingBefore = computeDelta([], [finding(1, "label", 2)], meta);
    expect(nothingBefore.percentFixed).toBe(0);
    expect(nothingBefore.nodesBefore).toBe(0);
    expect(nothingBefore.newIssues).toHaveLength(1);
    expect(nothingBefore.fixed).toEqual([]);
  });

  it("clamps at 0% when the re-scan got worse", () => {
    const worse = computeDelta([finding(1, "label", 2)], [finding(1, "label", 5), finding(2, "image-alt", 3)], meta);
    expect(worse.percentFixed).toBe(0);
    expect(worse.unchanged).toEqual([{ ruleId: "label", title: "Form fields have no label", before: 2, after: 5 }]);
  });

  it("orders entries by rank and folds duplicate rule ids together", () => {
    const original = [finding(3, "label", 1), finding(1, "image-alt", 2), finding(2, "image-alt", 4)];
    const rescan = [finding(2, "select-name", 1), finding(1, "aria-roles", 1)];
    const delta = computeDelta(original, rescan, meta);
    expect(delta.fixed.map((e) => e.ruleId)).toEqual(["image-alt", "label"]);
    expect(delta.fixed[0]?.before).toBe(6);
    expect(delta.newIssues.map((e) => e.ruleId)).toEqual(["aria-roles", "select-name"]);
    expect(delta.nodesBefore).toBe(7);
  });
});
