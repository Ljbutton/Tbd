import { describe, expect, it } from "vitest";
import { CATEGORIES, IMPACT_WEIGHTS, LITIGATION, categoryFor, litigationWeight } from "../../src/report/litigation.js";
import { compareFindings, rankFindings, scoreFinding } from "../../src/report/rank.js";
import type { Finding, Impact, PageScan, RawNode, RawViolation, Viewport } from "../../src/types.js";

function nodes(count: number, prefix = "el"): RawNode[] {
  return Array.from({ length: count }, (_, i) => ({
    target: [`.${prefix}-${i}`],
    html: `<div class="${prefix}-${i}"></div>`,
    failureSummary: "Fix any of the following",
  }));
}

function violation(id: string, impact: Impact | null, nodeList: RawNode[], tags = ["wcag2a", "wcag111"]): RawViolation {
  return {
    id,
    impact,
    tags,
    help: `Help for ${id}`,
    helpUrl: `https://dequeuniversity.com/rules/axe/4.10/${id}`,
    description: `Description for ${id}`,
    nodes: nodeList,
  };
}

function scan(url: string, viewport: Viewport, violations: RawViolation[], incomplete: RawViolation[] = []): PageScan {
  return { url, viewport, statusCode: 200, title: `Title of ${url}`, violations, incomplete };
}

describe("scoreFinding (hand-computed expectations)", () => {
  it("critical image-alt on one page with one node scores 31.22", () => {
    // 4 * 3 * (1 + log2(2)) * (1 + log10(2)) = 12 * 2 * 1.30103 = 31.22472
    expect(scoreFinding({ impact: "critical", litigationWeight: 3, pagesAffected: 1, nodesTotal: 1, confidence: "automated" })).toBe(31.22);
  });

  it("critical weight-3 rule on 3 pages with 9 nodes scores exactly 72", () => {
    // 4 * 3 * (1 + log2(4)) * (1 + log10(10)) = 12 * 3 * 2 = 72
    expect(scoreFinding({ impact: "critical", litigationWeight: 3, pagesAffected: 3, nodesTotal: 9, confidence: "automated" })).toBe(72);
  });

  it("serious weight-2 rule on one page with one node scores 15.61", () => {
    // 3 * 2 * 2 * 1.30103 = 15.61236
    expect(scoreFinding({ impact: "serious", litigationWeight: 2, pagesAffected: 1, nodesTotal: 1, confidence: "automated" })).toBe(15.61);
  });

  it("needs_manual halves the score", () => {
    // 2 * 1 * 2 * 1.30103 * 0.5 = 2.60206
    expect(scoreFinding({ impact: "moderate", litigationWeight: 1, pagesAffected: 1, nodesTotal: 1, confidence: "needs_manual" })).toBe(2.6);
    expect(scoreFinding({ impact: "moderate", litigationWeight: 1, pagesAffected: 1, nodesTotal: 1, confidence: "automated" })).toBe(5.2);
  });

  it("zero pages or nodes never produce NaN", () => {
    expect(scoreFinding({ impact: "minor", litigationWeight: 1, pagesAffected: 0, nodesTotal: 0, confidence: "automated" })).toBe(1);
  });
});

describe("litigation table", () => {
  it("has the spec weights and categories", () => {
    expect(litigationWeight("image-alt")).toBe(3);
    expect(litigationWeight("color-contrast")).toBe(3);
    expect(litigationWeight("meta-viewport")).toBe(3);
    expect(litigationWeight("html-has-lang")).toBe(2);
    expect(litigationWeight("heading-order")).toBe(1);
    expect(litigationWeight("duplicate-id-aria")).toBe(1);
    expect(litigationWeight("some-unknown-rule")).toBe(1);
    expect(categoryFor("image-alt")).toBe("images");
    expect(categoryFor("color-contrast")).toBe("contrast");
    expect(categoryFor("label")).toBe("forms");
    expect(categoryFor("button-name")).toBe("links_buttons");
    expect(categoryFor("tabindex")).toBe("keyboard");
    expect(categoryFor("document-title")).toBe("structure");
    expect(categoryFor("html-has-lang")).toBe("language");
    expect(categoryFor("video-caption")).toBe("media");
    expect(categoryFor("aria-roles")).toBe("aria");
    expect(categoryFor("target-size")).toBe("mobile");
    expect(IMPACT_WEIGHTS).toEqual({ critical: 4, serious: 3, moderate: 2, minor: 1 });
    for (const entry of Object.values(LITIGATION)) {
      expect(CATEGORIES).toContain(entry.category);
      expect([1, 2, 3]).toContain(entry.weight);
    }
    expect(Object.keys(LITIGATION).length).toBeGreaterThanOrEqual(38);
  });

  it("classifies unknown rules by id shape and otherwise as other", () => {
    expect(categoryFor("aria-tooltip-name")).toBe("aria");
    expect(categoryFor("server-side-image-map")).toBe("images");
    expect(categoryFor("landmark-one-main")).toBe("structure");
    expect(categoryFor("valid-lang")).toBe("language");
    expect(categoryFor("something-else")).toBe("other");
  });
});

describe("rankFindings", () => {
  it("returns an empty list for no scans, errored scans and scans with no violations", () => {
    expect(rankFindings([])).toEqual([]);
    expect(rankFindings([{ url: "http://a/", viewport: "desktop", statusCode: null, title: "", violations: [], incomplete: [], error: "boom" }])).toEqual([]);
    expect(rankFindings([scan("http://a/", "desktop", [])])).toEqual([]);
  });

  it("builds a fully populated finding for one violation", () => {
    const node: RawNode = { target: ["#hero", "img"], html: '<img src="/img/hero-candle.svg">' };
    const [finding] = rankFindings([scan("http://127.0.0.1:4100/", "desktop", [violation("image-alt", "critical", [node])])]);
    expect(finding).toEqual<Finding>({
      rank: 1,
      ruleId: "image-alt",
      impact: "critical",
      category: "images",
      wcagTags: ["wcag2a", "wcag111"],
      pagesAffected: 1,
      nodesTotal: 1,
      litigationWeight: 3,
      score: 31.22,
      confidence: "automated",
      examplePageUrl: "http://127.0.0.1:4100/",
      exampleSelector: "#hero img",
      exampleHtml: '<img src="/img/hero-candle.svg">',
      screenshotPath: null,
      help: "Help for image-alt",
      helpUrl: "https://dequeuniversity.com/rules/axe/4.10/image-alt",
      affectedUrls: ["http://127.0.0.1:4100/"],
    });
  });

  it("counts a page once per rule across viewports and sums desktop nodes, using mobile only where desktop lacks the rule", () => {
    const scans = [
      scan("http://s/a", "desktop", [violation("image-alt", "critical", nodes(2, "a"))]),
      scan("http://s/a", "mobile", [violation("image-alt", "critical", nodes(3, "am"))]),
      scan("http://s/b", "desktop", []),
      scan("http://s/b", "mobile", [violation("image-alt", "critical", nodes(1, "bm"))]),
    ];
    const [finding] = rankFindings(scans);
    expect(finding?.pagesAffected).toBe(2);
    expect(finding?.nodesTotal).toBe(3);
    // 4 * 3 * (1 + log2(3)) * (1 + log10(4)) = 49.6952...
    expect(finding?.score).toBe(49.7);
    expect(finding?.affectedUrls).toEqual(["http://s/a", "http://s/b"]);
    // Example comes from the desktop scan of the first affected page.
    expect(finding?.exampleSelector).toBe(".a-0");
  });

  it("uses the mobile example when the first affected page only failed on mobile", () => {
    const scans = [
      scan("http://s/a", "desktop", []),
      scan("http://s/a", "mobile", [violation("target-size", "serious", nodes(2, "tap"))]),
    ];
    const [finding] = rankFindings(scans);
    expect(finding?.examplePageUrl).toBe("http://s/a");
    expect(finding?.exampleSelector).toBe(".tap-0");
    expect(finding?.nodesTotal).toBe(2);
  });

  it("turns incomplete-only rules into needs_manual findings with moderate impact when axe gives none", () => {
    const scans = [scan("http://s/a", "desktop", [], [violation("color-contrast", null, nodes(1))])];
    const [finding] = rankFindings(scans);
    expect(finding?.confidence).toBe("needs_manual");
    expect(finding?.impact).toBe("moderate");
    // 2 * 3 * 2 * 1.30103 * 0.5 = 7.80618
    expect(finding?.score).toBe(7.81);
  });

  it("keeps a rule automated when it is in both violations and incomplete, counting only violation nodes", () => {
    const scans = [
      scan("http://s/a", "desktop", [violation("color-contrast", "serious", nodes(2))], [violation("color-contrast", "serious", nodes(5))]),
      scan("http://s/b", "desktop", [], [violation("color-contrast", "serious", nodes(4))]),
    ];
    const [finding] = rankFindings(scans);
    expect(finding?.confidence).toBe("automated");
    expect(finding?.pagesAffected).toBe(1);
    expect(finding?.nodesTotal).toBe(2);
  });

  it("takes the most severe impact seen across pages and unions wcag tags", () => {
    const scans = [
      scan("http://s/a", "desktop", [violation("link-name", "moderate", nodes(1), ["wcag2a", "wcag412"])]),
      scan("http://s/b", "desktop", [violation("link-name", "serious", nodes(1), ["wcag2a", "wcag244", "cat.name-role-value"])]),
    ];
    const [finding] = rankFindings(scans);
    expect(finding?.impact).toBe("serious");
    expect(finding?.wcagTags).toEqual(["wcag2a", "wcag412", "wcag244"]);
  });

  it("keeps all tags when none are wcag tags", () => {
    const [finding] = rankFindings([scan("http://s/a", "desktop", [violation("heading-order", "moderate", nodes(1), ["cat.semantics", "best-practice"])])]);
    expect(finding?.wcagTags).toEqual(["cat.semantics", "best-practice"]);
  });

  it("sorts by score, then impact, then rule id and assigns ranks from 1", () => {
    const scans = [
      scan("http://s/a", "desktop", [
        violation("zzz-minor", "minor", nodes(1)), // 1*1*2*1.30103 = 2.60
        violation("aaa-minor", "minor", nodes(1)), // 2.60, same score: rule id decides
        violation("tabindex", "minor", nodes(1)), // 1*2*2*1.30103 = 5.20 (automated, weight 2)
        violation("image-alt", "critical", nodes(1)), // 31.22
        violation("html-has-lang", "serious", nodes(1)), // 15.61
      ], [
        violation("some-critical-check", "critical", nodes(1)), // 4*1*2*1.30103*0.5 = 5.20 needs_manual
      ]),
    ];
    const findings = rankFindings(scans);
    expect(findings.map((f) => f.ruleId)).toEqual([
      "image-alt",
      "html-has-lang",
      "some-critical-check",
      "tabindex",
      "aaa-minor",
      "zzz-minor",
    ]);
    expect(findings.map((f) => f.score)).toEqual([31.22, 15.61, 5.2, 5.2, 2.6, 2.6]);
    expect(findings.map((f) => f.rank)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("caps affectedUrls at 30 unique pages while still counting every page", () => {
    const scans: PageScan[] = [];
    for (let i = 0; i < 35; i += 1) {
      scans.push(scan(`http://s/p${i}`, "desktop", [violation("image-alt", "critical", nodes(1))]));
      scans.push(scan(`http://s/p${i}`, "mobile", [violation("image-alt", "critical", nodes(1))]));
    }
    const [finding] = rankFindings(scans);
    expect(finding?.pagesAffected).toBe(35);
    expect(finding?.nodesTotal).toBe(35);
    expect(finding?.affectedUrls).toHaveLength(30);
    expect(finding?.affectedUrls[0]).toBe("http://s/p0");
    expect(finding?.affectedUrls[29]).toBe("http://s/p29");
  });

  it("tolerates a violation with no nodes and non-string targets", () => {
    const weird: RawViolation = {
      ...violation("frame-title", "serious", []),
      nodes: [{ target: ["iframe", 3 as unknown as string], html: "<iframe></iframe>" }],
    };
    const [finding] = rankFindings([scan("http://s/a", "desktop", [violation("list", "serious", []), weird])]);
    expect(finding?.ruleId).toBe("frame-title");
    expect(finding?.exampleSelector).toBe("iframe 3");
    const list = rankFindings([scan("http://s/a", "desktop", [violation("list", "serious", [])])])[0];
    expect(list?.nodesTotal).toBe(0);
    expect(list?.exampleHtml).toBeNull();
    expect(list?.exampleSelector).toBeNull();
  });
});

describe("compareFindings", () => {
  const base = (patch: Partial<Finding>): Finding => ({
    rank: 0,
    ruleId: "x",
    impact: "minor",
    category: "other",
    wcagTags: [],
    pagesAffected: 1,
    nodesTotal: 1,
    litigationWeight: 1,
    score: 1,
    confidence: "automated",
    examplePageUrl: null,
    exampleSelector: null,
    exampleHtml: null,
    screenshotPath: null,
    help: "",
    helpUrl: "",
    affectedUrls: [],
    ...patch,
  });

  it("orders by score desc, impact severity, then rule id", () => {
    expect(compareFindings(base({ score: 2 }), base({ score: 3 }))).toBeGreaterThan(0);
    expect(compareFindings(base({ impact: "critical" }), base({ impact: "serious" }))).toBeLessThan(0);
    expect(compareFindings(base({ ruleId: "a" }), base({ ruleId: "b" }))).toBeLessThan(0);
    expect(compareFindings(base({ ruleId: "a" }), base({ ruleId: "a" }))).toBe(0);
  });
});
