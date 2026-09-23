import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { AuditSummary, Finding, SiteMeta } from "../../src/types.js";

// The narrative chooser reads config at import time; make sure this file sees mock mode.
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_BASE_URL;

const { RULES, getRule } = await import("../../src/narrative/rules.js");
const { MANUAL_CHECKS } = await import("../../src/narrative/manual-checks.js");
const mock = await import("../../src/narrative/mock.js");
const claude = await import("../../src/narrative/claude.js");
const { buildNarrative } = await import("../../src/narrative/index.js");

const SPEC_RULE_IDS = [
  "image-alt", "color-contrast", "label", "button-name", "link-name", "select-name", "html-has-lang",
  "document-title", "frame-title", "heading-order", "page-has-heading-one", "list", "listitem",
  "aria-required-attr", "aria-valid-attr-value", "aria-roles", "aria-hidden-focus", "meta-viewport",
  "autocomplete-valid", "duplicate-id-aria", "tabindex", "video-caption", "scrollable-region-focusable",
  "nested-interactive", "target-size", "link-in-text-block", "empty-heading", "role-img-alt", "svg-img-alt",
  "input-image-alt",
];

const WEIGHT_3_RULES = ["image-alt", "color-contrast", "label", "button-name", "link-name", "select-name", "input-image-alt", "meta-viewport", "video-caption", "audio-caption", "role-img-alt", "svg-img-alt"];

const FORBIDDEN = /complian|certif/i;

function fix(ruleId: string, html: string): string {
  const rule = RULES[ruleId];
  if (!rule?.fixHtml) throw new Error(`no fixHtml for ${ruleId}`);
  return rule.fixHtml(html);
}

function finding(rank: number, ruleId: string, patch: Partial<Finding> = {}): Finding {
  return {
    rank,
    ruleId,
    impact: "serious",
    category: "other",
    wcagTags: ["wcag2a"],
    pagesAffected: 2,
    nodesTotal: 3,
    litigationWeight: 1,
    score: 10,
    confidence: "automated",
    examplePageUrl: "http://127.0.0.1:4100/",
    exampleSelector: "img",
    exampleHtml: '<img src="/img/hero-candle.svg">',
    screenshotPath: null,
    help: `Help for ${ruleId}`,
    helpUrl: `https://dequeuniversity.com/rules/axe/4.10/${ruleId}`,
    affectedUrls: ["http://127.0.0.1:4100/", "http://127.0.0.1:4100/products.html"],
    ...patch,
  };
}

const summary: AuditSummary = {
  pagesRequested: 15,
  pagesScanned: 6,
  pagesFailed: 0,
  totalViolationNodes: 41,
  findingsCount: 4,
  byImpact: { critical: 1, serious: 2, moderate: 1, minor: 0 },
  byConfidence: { automated: 3, needs_manual: 1 },
  scanStartedAt: "2026-09-20T10:00:00.000Z",
  scanFinishedAt: "2026-09-20T10:04:00.000Z",
  viewports: ["desktop", "mobile"],
};

const siteMeta: SiteMeta = {
  url: "http://127.0.0.1:4100/",
  origin: "http://127.0.0.1:4100",
  siteTitle: "Northwind Candles",
  platformGuess: "unknown",
};

const sampleFindings: Finding[] = [
  finding(1, "image-alt", { impact: "critical", category: "images", litigationWeight: 3, pagesAffected: 4, nodesTotal: 9 }),
  finding(2, "color-contrast", { category: "contrast", litigationWeight: 3, pagesAffected: 5, nodesTotal: 20, exampleHtml: '<p class="lead">Hand-poured in small batches</p>' }),
  finding(3, "label", { category: "forms", litigationWeight: 3, pagesAffected: 1, nodesTotal: 3, exampleHtml: '<input type="email" name="email" placeholder="Your email">' }),
  finding(4, "some-unknown-rule", { impact: "moderate", confidence: "needs_manual", pagesAffected: 2, nodesTotal: 9, exampleHtml: null, help: "Custom widgets must announce themselves" }),
];

describe("RULES dictionary", () => {
  it("covers every rule id from the spec with complete, well-formed entries", () => {
    expect(Object.keys(RULES).length).toBeGreaterThanOrEqual(30);
    for (const id of SPEC_RULE_IDS) {
      const rule = RULES[id];
      expect(rule, id).toBeDefined();
      expect(rule?.title.length, id).toBeGreaterThan(8);
      expect(rule?.plainEnglish.length, id).toBeGreaterThan(60);
      expect(rule?.whyItMatters.length, id).toBeGreaterThan(60);
      expect(rule?.fixSteps.length, id).toBeGreaterThanOrEqual(1);
      expect(["minutes", "hours", "days"], id).toContain(rule?.effort);
    }
  });

  it("names who is affected and, for weight-3 rules, the complaint frequency", () => {
    for (const [id, rule] of Object.entries(RULES)) {
      expect(/screen reader|blind|low vision|keyboard|deaf|color blind|voice control|motor|tremor|arthritis|phone|mobile|assistive/i.test(rule.whyItMatters), id).toBe(true);
    }
    for (const id of WEIGHT_3_RULES) {
      expect(RULES[id]?.whyItMatters, id).toMatch(/ADA website complaints/);
    }
  });

  it("never uses the forbidden wording anywhere in the dictionary, checklist or fixed copy", () => {
    for (const [id, rule] of Object.entries(RULES)) {
      const text = [rule.title, rule.plainEnglish, rule.whyItMatters, ...rule.fixSteps].join(" ");
      expect(FORBIDDEN.test(text), id).toBe(false);
    }
    for (const check of MANUAL_CHECKS) expect(FORBIDDEN.test(`${check.title} ${check.how}`)).toBe(false);
    for (const step of mock.NEXT_STEPS) expect(FORBIDDEN.test(step)).toBe(false);
  });

  it("has the spec transformers on the named rules and the CSS suggestion for contrast", () => {
    for (const id of ["image-alt", "label", "button-name", "link-name", "html-has-lang", "frame-title", "document-title", "select-name", "color-contrast"]) {
      expect(typeof RULES[id]?.fixHtml, id).toBe("function");
    }
    expect(RULES["color-contrast"]?.fixSteps.join(" ")).toContain("color: #1f2937; background: #ffffff; /* 4.5:1 */");
  });

  it("getRule falls back to a generic entry built from axe help text", () => {
    const entry = getRule("mystery-rule", { help: "Mystery elements must be clear", helpUrl: "https://example.test/mystery" });
    expect(entry.title).toBe("Mystery elements must be clear");
    expect(entry.plainEnglish).toBe("Mystery elements must be clear");
    expect(entry.fixSteps).toEqual(["Read the rule details: https://example.test/mystery"]);
    expect(entry.effort).toBe("hours");
    expect(entry.fixHtml).toBeUndefined();
    expect(getRule("image-alt", { help: "x", helpUrl: "y" })).toBe(RULES["image-alt"]);
  });
});

describe("MANUAL_CHECKS", () => {
  it("has 12 distinct entries with a title and a how", () => {
    expect(MANUAL_CHECKS).toHaveLength(12);
    expect(new Set(MANUAL_CHECKS.map((c) => c.title)).size).toBe(12);
    for (const check of MANUAL_CHECKS) {
      expect(check.title.length).toBeGreaterThan(10);
      expect(check.how.length).toBeGreaterThan(60);
    }
    const all = MANUAL_CHECKS.map((c) => `${c.title} ${c.how}`).join(" ");
    for (const topic of [/keyboard/i, /focus/i, /skip/i, /screen reader/i, /error/i, /200%/, /pause|moving/i, /caption/i, /link text|read more|click here/i, /alt text/i, /color/i]) {
      expect(all).toMatch(topic);
    }
  });
});

describe("fixHtml transformers", () => {
  it("image-alt adds alt text, keeps self-closing syntax and replaces a valueless alt", () => {
    expect(fix("image-alt", '<img src="/img/hero-candle.svg">')).toBe('<img src="/img/hero-candle.svg" alt="Describe what the image shows">');
    expect(fix("image-alt", '<img src="a.png" class="hero"/>')).toBe('<img src="a.png" class="hero" alt="Describe what the image shows" />');
    expect(fix("image-alt", '<img src="a.png" alt>')).toBe('<img src="a.png" alt="Describe what the image shows">');
    expect(fix("image-alt", '<img alt=" " src="a.png">')).toBe('<img alt="Describe what the image shows" src="a.png">');
  });

  it("label wraps the field with a label derived from placeholder, name or id and adds an id when missing", () => {
    expect(fix("label", '<input type="email" name="email" placeholder="Your email">')).toBe(
      '<label for="email">Your email</label>\n<input type="email" name="email" placeholder="Your email" id="email">',
    );
    expect(fix("label", '<input id="first_name" type="text">')).toBe('<label for="first_name">First name</label>\n<input id="first_name" type="text">');
    expect(fix("label", '<textarea name="message" rows="4"></textarea>')).toBe(
      '<label for="message">Message</label>\n<textarea name="message" rows="4" id="message"></textarea>',
    );
    expect(fix("label", '<input type="text">')).toBe('<label for="field">Field name</label>\n<input type="text" id="field">');
    expect(fix("label", '<input type="hidden" name="token" value="abc">')).toBe('<input type="hidden" name="token" value="abc">');
    expect(fix("label", '<input name="billing[postal_code]" type="text">')).toBe(
      '<label for="billing-postal-code">Billing postal code</label>\n<input name="billing[postal_code]" type="text" id="billing-postal-code">',
    );
  });

  it("select-name wraps the select with a label", () => {
    expect(fix("select-name", '<select name="shipping"><option>Standard</option></select>')).toBe(
      '<label for="shipping">Shipping</label>\n<select name="shipping" id="shipping"><option>Standard</option></select>',
    );
    expect(fix("select-name", "<select><option>One</option></select>")).toBe(
      '<label for="field">Choose an option</label>\n<select id="field"><option>One</option></select>',
    );
  });

  it("button-name inserts text, labels icon buttons, fixes image buttons and closes truncated markup", () => {
    expect(fix("button-name", '<button class="icon-btn"></button>')).toBe('<button class="icon-btn">Describe the action</button>');
    expect(fix("button-name", '<button class="menu"><svg aria-hidden="true"><path d="M0 0h10"/></svg></button>')).toBe(
      '<button class="menu" aria-label="Describe the action"><svg aria-hidden="true"><path d="M0 0h10"/></svg></button>',
    );
    expect(fix("button-name", '<button type="submit"><img src="/icons/cart.png"></button>')).toBe(
      '<button type="submit"><img src="/icons/cart.png" alt="Describe the action"></button>',
    );
    expect(fix("button-name", '<input type="submit" class="btn">')).toBe('<input type="submit" class="btn" value="Describe the action">');
    expect(fix("button-name", '<button class="x">')).toBe('<button class="x">Describe the action</button>');
    expect(fix("button-name", "<button>   </button>")).toBe("<button>Describe the action</button>");
  });

  it("link-name inserts text, describes image links and labels icon links", () => {
    expect(fix("link-name", '<a href="#"></a>')).toBe('<a href="#">Describe where this link goes</a>');
    expect(fix("link-name", '<a href="/"><img src="logo.svg" alt=""></a>')).toBe('<a href="/"><img src="logo.svg" alt="Describe where this link goes"></a>');
    expect(fix("link-name", '<a href="https://facebook.com/x" class="social"><i class="icon-facebook"></i></a>')).toBe(
      '<a href="https://facebook.com/x" class="social" aria-label="Describe where this link goes"><i class="icon-facebook"></i></a>',
    );
  });

  it("html-has-lang, frame-title and document-title fill in the missing metadata", () => {
    expect(fix("html-has-lang", "<html>")).toBe('<html lang="en">');
    expect(fix("html-has-lang", '<html class="no-js" lang="">')).toBe('<html class="no-js" lang="en">');
    expect(fix("frame-title", '<iframe src="/hours.html" width="300"></iframe>')).toBe(
      '<iframe src="/hours.html" width="300" title="Describe what this frame shows"></iframe>',
    );
    expect(fix("document-title", '<html lang="en">')).toBe('<html lang="en">\n<head>\n  <title>Page name | Site</title>\n</head>');
    expect(fix("document-title", '<head><meta charset="utf-8"></head>')).toBe('<head>\n  <title>Page name | Site</title><meta charset="utf-8"></head>');
    expect(fix("document-title", "<head><title></title></head>")).toBe("<head><title>Page name | Site</title></head>");
    expect(fix("document-title", "")).toBe("<head>\n  <title>Page name | Site</title>\n</head>\n");
  });

  it("color-contrast returns the markup unchanged", () => {
    const html = '<p class="lead" style="color:#999">Hand-poured</p>';
    expect(fix("color-contrast", html)).toBe(html);
  });

  it("meta-viewport, tabindex, autocomplete, empty-heading, svg, video and scroll regions get minimal fixes", () => {
    expect(fix("meta-viewport", '<meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no, maximum-scale=1">')).toBe(
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
    );
    expect(fix("meta-viewport", '<meta name="viewport" content="user-scalable=0">')).toBe(
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
    );
    expect(fix("tabindex", '<a href="/products.html" tabindex="5">Products</a>')).toBe('<a href="/products.html" tabindex="0">Products</a>');
    expect(fix("tabindex", '<div tabindex="0"><a tabindex="-1" href="#">x</a></div>')).toBe('<div tabindex="0"><a tabindex="-1" href="#">x</a></div>');
    expect(fix("autocomplete-valid", '<input autocomplete="zipcode" name="zip">')).toBe('<input autocomplete="postal-code" name="zip">');
    expect(fix("autocomplete-valid", '<input autocomplete="banana" name="x">')).toBe('<input autocomplete="banana" name="x">');
    expect(fix("empty-heading", '<h2 class="section-title"></h2>')).toBe('<h2 class="section-title">Section title</h2>');
    expect(fix("svg-img-alt", '<svg role="img" viewBox="0 0 10 10"><path d="M0 0"/></svg>')).toBe(
      '<svg role="img" viewBox="0 0 10 10" aria-label="Describe what the graphic shows"><path d="M0 0"/></svg>',
    );
    expect(fix("video-caption", '<video src="pour.mp4" controls></video>')).toBe(
      '<video src="pour.mp4" controls>\n  <track kind="captions" src="captions.vtt" srclang="en" label="English">\n</video>',
    );
    expect(fix("scrollable-region-focusable", '<div class="terms" style="overflow:auto;height:200px">')).toBe(
      '<div class="terms" style="overflow:auto;height:200px" tabindex="0">',
    );
    expect(fix("input-image-alt", '<input type="image" src="go.png">')).toBe('<input type="image" src="go.png" alt="Describe what this button does">');
    expect(fix("role-img-alt", '<span role="img" class="icon-star"></span>')).toBe('<span role="img" class="icon-star" aria-label="Describe what the image shows"></span>');
  });

  it("escapes derived label text and never throws on garbage input", () => {
    expect(fix("label", '<input name="a" placeholder="Tom &amp; Jerry <3">')).toBe(
      '<label for="a">Tom &amp;amp; Jerry &lt;3</label>\n<input name="a" placeholder="Tom &amp; Jerry <3" id="a">',
    );
    for (const [id, rule] of Object.entries(RULES)) {
      if (!rule.fixHtml) continue;
      for (const input of ["", "plain text", "<", "<img", "<button", "<<>>", "<a href='x'>", "<html", "<meta name='viewport'>"]) {
        expect(() => rule.fixHtml?.(input), `${id} on ${JSON.stringify(input)}`).not.toThrow();
        expect(typeof rule.fixHtml?.(input)).toBe("string");
      }
    }
  });
});

describe("buildMockNarrative", () => {
  const narrative = mock.buildMockNarrative(sampleFindings, summary, siteMeta);

  it("writes the executive summary from the template with the real numbers", () => {
    expect(narrative.executiveSummary).toBe(
      "We scanned 6 pages of Northwind Candles (http://127.0.0.1:4100) at desktop and mobile sizes and found 4 distinct accessibility issues affecting 41 elements, including 3 critical or serious ones. " +
        "The top priorities are Images are missing text descriptions, Text is too light against its background and Form fields have no label. " +
        "Automated checks find roughly 30-40% of WCAG issues; the manual checks in section 5 cover the rest.",
    );
  });

  it("writes one risk line per category among the top 5 with page counts", () => {
    const lines = narrative.riskOverview.split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe("Images: 1 issue across 4 pages. Screen reader users can't tell what your pictures show.");
    expect(lines[1]).toMatch(/^Color contrast: 1 issue across 5 pages\./);
    expect(lines[2]).toMatch(/^Forms: 1 issue across 2 pages\./);
    expect(lines[3]).toMatch(/^Other checks: 1 issue across 2 pages\./);
  });

  it("lists the top 3 priorities with page counts", () => {
    expect(narrative.topPriorities).toEqual([
      "Images are missing text descriptions (4 pages)",
      "Text is too light against its background (5 pages)",
      "Form fields have no label (1 page)",
    ]);
  });

  it("maps every finding to a dictionary entry with before/after markup", () => {
    expect(narrative.findings.map((f) => f.ruleId)).toEqual(["image-alt", "color-contrast", "label", "some-unknown-rule"]);
    const [imageAlt, contrast, label, unknown] = narrative.findings;
    expect(imageAlt?.beforeHtml).toBe('<img src="/img/hero-candle.svg">');
    expect(imageAlt?.afterHtml).toBe('<img src="/img/hero-candle.svg" alt="Describe what the image shows">');
    expect(imageAlt?.effort).toBe("hours");
    expect(contrast?.afterHtml).toBe(contrast?.beforeHtml);
    expect(label?.afterHtml).toContain('<label for="email">Your email</label>');
    expect(unknown?.title).toBe("Custom widgets must announce themselves");
    expect(unknown?.beforeHtml).toBeNull();
    expect(unknown?.afterHtml).toBeNull();
    expect(unknown?.plainEnglish).toMatch(/verify by hand/);
    expect(unknown?.fixSteps).toEqual(["Read the rule details: https://dequeuniversity.com/rules/axe/4.10/some-unknown-rule"]);
  });

  it("ships the 12 manual checks, 4 next steps and the dictionary marker", () => {
    expect(narrative.manualChecks).toHaveLength(12);
    expect(narrative.nextSteps).toHaveLength(4);
    expect(narrative.nextSteps[0]).toMatch(/top 3/);
    expect(narrative.nextSteps[1]).toMatch(/developer/);
    expect(narrative.nextSteps[2]).toMatch(/re-scan within 30 days/);
    expect(narrative.nextSteps[3]).toMatch(/manual checks/);
    expect(narrative.generatedBy).toBe("dictionary");
    expect(narrative.model).toBeUndefined();
    expect(FORBIDDEN.test(JSON.stringify(narrative))).toBe(false);
  });

  it("sorts by rank regardless of input order and handles a clean site", () => {
    const shuffled = mock.buildMockNarrative([...sampleFindings].reverse(), summary, siteMeta);
    expect(shuffled.findings.map((f) => f.ruleId)).toEqual(narrative.findings.map((f) => f.ruleId));

    const clean = mock.buildMockNarrative([], { ...summary, findingsCount: 0, totalViolationNodes: 0, byImpact: { critical: 0, serious: 0, moderate: 0, minor: 0 } }, { ...siteMeta, siteTitle: "" });
    expect(clean.executiveSummary).toMatch(/^We scanned 6 pages of 127\.0\.0\.1 \(http:\/\/127\.0\.0\.1:4100\)/);
    expect(clean.executiveSummary).toMatch(/found no issues/);
    expect(clean.riskOverview).toMatch(/no issues/);
    expect(clean.topPriorities).toEqual([]);
    expect(clean.findings).toEqual([]);
  });

  it("uses singular forms and 'top priority' when there is one finding", () => {
    const one = mock.buildMockNarrative([sampleFindings[0] as Finding], { ...summary, pagesScanned: 1, findingsCount: 1, totalViolationNodes: 1, byImpact: { critical: 1, serious: 0, moderate: 0, minor: 0 } }, siteMeta);
    expect(one.executiveSummary).toContain("We scanned 1 page of");
    expect(one.executiveSummary).toContain("found 1 distinct accessibility issue affecting 1 element, including 1 critical or serious one.");
    expect(one.executiveSummary).toContain("The top priority is Images are missing text descriptions.");
  });
});

describe("buildNarrative (mode switch)", () => {
  it("uses the dictionary and says so when no ANTHROPIC_API_KEY is set", async () => {
    const lines: string[] = [];
    const narrative = await buildNarrative(sampleFindings, summary, siteMeta, (line) => lines.push(line));
    expect(narrative.generatedBy).toBe("dictionary");
    expect(lines).toEqual(["narrative: using dictionary (no ANTHROPIC_API_KEY)"]);
  });
});

describe("claude narrative helpers", () => {
  it("builds the payload from the top 25 findings with at most 5 urls and a dictionary hint", () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      finding(i + 1, i === 0 ? "image-alt" : `rule-${i}`, { affectedUrls: Array.from({ length: 8 }, (_, j) => `http://s/p${j}`) }),
    );
    const payload = claude.buildClaudePayload([...many].reverse(), summary, siteMeta);
    expect(payload.siteMeta).toBe(siteMeta);
    expect(payload.summary).toBe(summary);
    expect(payload.findings).toHaveLength(25);
    expect(payload.findings[0]?.ruleId).toBe("image-alt");
    expect(payload.findings[0]?.dictionaryHint).toBe(RULES["image-alt"]?.plainEnglish);
    expect(payload.findings[1]?.dictionaryHint).toBeUndefined();
    expect(payload.findings[0]?.affectedUrls).toHaveLength(5);
    expect(payload.findings[24]?.ruleId).toBe("rule-24");
    expect(Object.keys(payload.findings[0] ?? {})).toEqual([
      "ruleId", "impact", "confidence", "pagesAffected", "nodesTotal", "affectedUrls", "exampleHtml", "help", "helpUrl", "dictionaryHint",
    ]);
  });

  it("NarrativeSchema accepts a full narrative and rejects a bad effort", () => {
    const good = mock.buildMockNarrative(sampleFindings, summary, siteMeta);
    const { generatedBy: _g, ...parsedShape } = good;
    expect(claude.NarrativeSchema.safeParse(parsedShape).success).toBe(true);
    expect(claude.NarrativeSchema.safeParse({ ...parsedShape, findings: [{ ...parsedShape.findings[0], effort: "weeks" }] }).success).toBe(false);
  });

  it("copyRuleViolation allows only the permitted phrase", () => {
    const base = claude.NarrativeSchema.parse({
      ...mock.buildMockNarrative(sampleFindings, summary, siteMeta),
    });
    expect(claude.copyRuleViolation(base)).toBeNull();
    expect(claude.copyRuleViolation({ ...base, nextSteps: ["Fixing these issues helps, but this does not make your site compliant."] })).toBeNull();
    expect(claude.copyRuleViolation({ ...base, executiveSummary: "After these fixes your site will be WCAG compliant." })).toMatch(/forbidden wording/);
    expect(claude.copyRuleViolation({ ...base, findings: [{ ...base.findings[0]!, whyItMatters: "We certify this page." }] })).toMatch(/forbidden wording/);
  });

  it("reconcileNarrative fills gaps from the dictionary, drops unknown rules, forces beforeHtml and pads manual checks", () => {
    const parsed = {
      executiveSummary: "  Claude summary. ",
      riskOverview: "",
      topPriorities: [],
      findings: [
        { ruleId: "label", title: "Your contact form fields have no labels", plainEnglish: "Claude text.", whyItMatters: "Claude why.", fixSteps: ["Do this", " "], beforeHtml: "<input>", afterHtml: '<label for="email">Email</label><input id="email">', effort: "minutes" as const },
        { ruleId: "made-up-rule", title: "Nope", plainEnglish: "x", whyItMatters: "y", fixSteps: [], beforeHtml: null, afterHtml: null, effort: "days" as const },
        { ruleId: "some-unknown-rule", title: "Custom widgets", plainEnglish: "Claude text 2.", whyItMatters: "why 2", fixSteps: [], beforeHtml: "<div>hallucinated</div>", afterHtml: "<div>fixed</div>", effort: "hours" as const },
      ],
      manualChecks: [{ title: "Tab through checkout", how: "Use only the keyboard." }],
      nextSteps: ["Fix labels first."],
    };
    const narrative = claude.reconcileNarrative(parsed, [...sampleFindings].reverse(), summary, siteMeta, "claude-opus-5");
    expect(narrative.generatedBy).toBe("claude");
    expect(narrative.model).toBe("claude-opus-5");
    expect(narrative.executiveSummary).toBe("Claude summary.");
    expect(narrative.riskOverview).toMatch(/^Images: 1 issue across 4 pages\./);
    expect(narrative.topPriorities).toEqual(mock.buildTopPriorities(sampleFindings));
    expect(narrative.nextSteps).toEqual(["Fix labels first."]);

    expect(narrative.findings.map((f) => f.ruleId)).toEqual(["image-alt", "color-contrast", "label", "some-unknown-rule"]);
    const [imageAlt, , label, unknown] = narrative.findings;
    expect(imageAlt?.title).toBe("Images are missing text descriptions");
    expect(label?.title).toBe("Your contact form fields have no labels");
    expect(label?.beforeHtml).toBe('<input type="email" name="email" placeholder="Your email">');
    expect(label?.afterHtml).toBe('<label for="email">Email</label><input id="email">');
    expect(label?.fixSteps).toEqual(["Do this"]);
    expect(unknown?.beforeHtml).toBeNull();
    expect(unknown?.afterHtml).toBeNull();
    expect(unknown?.fixSteps).toEqual(["Read the rule details: https://dequeuniversity.com/rules/axe/4.10/some-unknown-rule"]);

    expect(narrative.manualChecks.length).toBeGreaterThanOrEqual(8);
    expect(narrative.manualChecks.length).toBeLessThanOrEqual(12);
    expect(narrative.manualChecks[0]).toEqual({ title: "Tab through checkout", how: "Use only the keyboard." });
  });

  it("reconcileNarrative gives dictionary entries to findings beyond the top 25 even when the model wrote them", () => {
    const many = Array.from({ length: 27 }, (_, i) => finding(i + 1, `rule-${i}`, { exampleHtml: null }));
    const parsed = claude.NarrativeSchema.parse({
      ...mock.buildMockNarrative(many, summary, siteMeta),
      findings: many.map((f) => ({ ruleId: f.ruleId, title: `Model ${f.ruleId}`, plainEnglish: "p", whyItMatters: "w", fixSteps: ["s"], beforeHtml: null, afterHtml: null, effort: "minutes" })),
    });
    const narrative = claude.reconcileNarrative(parsed, many, summary, siteMeta, "m");
    expect(narrative.findings[24]?.title).toBe("Model rule-24");
    expect(narrative.findings[25]?.title).toBe("Help for rule-25");
    expect(narrative.findings).toHaveLength(27);
  });

  it("describeFailure gives a short reason for plain errors and unknown values", () => {
    expect(claude.describeFailure(new Error("model refused the request"))).toBe("model refused the request");
    expect(claude.describeFailure("weird")).toBe("weird");
  });
});

describe("buildClaudeNarrative failure path", () => {
  const saved = { key: process.env.ANTHROPIC_API_KEY, base: process.env.ANTHROPIC_BASE_URL };
  afterEach(() => {
    if (saved.key === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved.key;
    if (saved.base === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = saved.base;
  });

  async function closedPort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        server.close(() => resolve(port));
      });
      server.on("error", reject);
    });
  }

  it("falls back to the dictionary and logs the reason when the API is unreachable", async () => {
    const port = await closedPort();
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-not-real";
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
    const lines: string[] = [];
    const narrative = await claude.buildClaudeNarrative(sampleFindings, summary, siteMeta, (line) => lines.push(line));
    expect(narrative.generatedBy).toBe("dictionary");
    expect(narrative.findings).toHaveLength(4);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^narrative: claude failed \(.+\), using dictionary$/);
  });
});
