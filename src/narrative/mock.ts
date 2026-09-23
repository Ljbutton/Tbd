// Dictionary-based narrative (spec 9.3): used whenever no Anthropic key is set
// and as the fallback when the Claude call fails. It must read well on its own
// because it is what most buyers in test mode, and every buyer on a bad day, get.

import { CATEGORY_LABELS, type Category } from "../report/litigation.js";
import type { AuditSummary, Finding, FindingNarrative, Narrative, SiteMeta } from "../types.js";
import { MANUAL_CHECKS } from "./manual-checks.js";
import { getRule } from "./rules.js";

const CATEGORY_RISK: Record<Category, string> = {
  images: "Screen reader users can't tell what your pictures show.",
  contrast: "Visitors with low vision or color blindness struggle to read the text.",
  forms: "Screen reader and voice control users can't tell what your form fields want, which blocks contact forms and checkout.",
  links_buttons: "Blind visitors and voice control users can't tell where links go or what buttons do.",
  keyboard: "People who navigate without a mouse get stuck or land on things they can't use.",
  structure: "Screen reader users lose the outline they use to skim and jump around a page.",
  language: "Screen readers may read your pages in the wrong voice or accent.",
  media: "Deaf and hard-of-hearing visitors miss what your audio and video say.",
  aria: "Custom controls from your theme or plugins don't tell assistive technology what they are or what state they're in.",
  mobile: "Phone users who need to zoom, or whose taps are less precise, can't use parts of the site.",
  other: "These checks affect people who rely on assistive technology in ways specific to each rule.",
};

export const NEXT_STEPS: readonly string[] = [
  "Fix the top 3 priorities first: they carry the most weight and appear on the most pages, so they're where your customers hit trouble first and where a complaint would start.",
  "Hand this report to your developer or theme provider. Each finding names the exact element, shows a before/after code sample and lists the steps to fix it.",
  "Run your free re-scan within 30 days once the fixes are live to get a dated before/after record of what changed.",
  "Complete the manual checks in section 5. Automated testing finds roughly 30-40% of WCAG issues; keyboard, screen reader and zoom checks cover the rest.",
];

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** "A", "A and B", "A, B and C". */
export function joinNatural(items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function isCategory(value: string): value is Category {
  return Object.prototype.hasOwnProperty.call(CATEGORY_LABELS, value);
}

function siteName(siteMeta: SiteMeta): string {
  const title = siteMeta.siteTitle.trim();
  if (title) return title;
  try {
    return new URL(siteMeta.origin).hostname;
  } catch {
    return siteMeta.origin || siteMeta.url;
  }
}

function titleFor(finding: Finding): string {
  return getRule(finding.ruleId, { help: finding.help, helpUrl: finding.helpUrl }).title;
}

function safeFixHtml(finding: Finding, fixHtml: ((html: string) => string) | undefined): string | null {
  if (!fixHtml || finding.exampleHtml === null) return null;
  try {
    return fixHtml(finding.exampleHtml);
  } catch {
    return null;
  }
}

const NEEDS_MANUAL_NOTE =
  "Our automated check couldn't confirm this on its own, so treat it as something to verify by hand on the pages listed below.";

/** Dictionary entry for one finding, with the example markup as before/after. */
export function dictionaryFindingNarrative(finding: Finding): FindingNarrative {
  const rule = getRule(finding.ruleId, { help: finding.help, helpUrl: finding.helpUrl });
  const plainEnglish = finding.confidence === "needs_manual" ? `${rule.plainEnglish} ${NEEDS_MANUAL_NOTE}` : rule.plainEnglish;
  return {
    ruleId: finding.ruleId,
    title: rule.title,
    plainEnglish,
    whyItMatters: rule.whyItMatters,
    fixSteps: [...rule.fixSteps],
    beforeHtml: finding.exampleHtml,
    afterHtml: safeFixHtml(finding, rule.fixHtml),
    effort: rule.effort,
  };
}

export function buildExecutiveSummary(findings: Finding[], summary: AuditSummary, siteMeta: SiteMeta): string {
  const ranked = [...findings].sort((a, b) => a.rank - b.rank);
  const site = siteName(siteMeta);
  const scope = `We scanned ${plural(summary.pagesScanned, "page")} of ${site} (${siteMeta.origin}) at desktop and mobile sizes`;
  if (ranked.length === 0) {
    return `${scope} and the automated checks found no issues. That is a good start, not a finish: automated checks find roughly 30-40% of WCAG issues; the manual checks in section 5 cover the rest.`;
  }
  const severe = summary.byImpact.critical + summary.byImpact.serious;
  const topTitles = ranked.slice(0, 3).map(titleFor);
  const priorities =
    topTitles.length === 1 ? `The top priority is ${topTitles[0]}.` : `The top priorities are ${joinNatural(topTitles)}.`;
  return (
    `${scope} and found ${plural(summary.findingsCount, "distinct accessibility issue")} affecting ` +
    `${plural(summary.totalViolationNodes, "element")}, including ${plural(severe, "critical or serious one")}. ` +
    `${priorities} Automated checks find roughly 30-40% of WCAG issues; the manual checks in section 5 cover the rest.`
  );
}

/** One line per category present among the top 5 findings, with issue and page counts. */
export function buildRiskOverview(findings: Finding[]): string {
  const top = [...findings].sort((a, b) => a.rank - b.rank).slice(0, 5);
  if (top.length === 0) {
    return "The automated checks found no issues on the pages we scanned. That is a good sign, but automated checks find roughly 30-40% of WCAG issues, so the manual checks still matter.";
  }
  const groups = new Map<Category, { issues: number; urls: Set<string>; pages: number }>();
  for (const finding of top) {
    const category: Category = isCategory(finding.category) ? finding.category : "other";
    let group = groups.get(category);
    if (!group) {
      group = { issues: 0, urls: new Set(), pages: 0 };
      groups.set(category, group);
    }
    group.issues += 1;
    group.pages = Math.max(group.pages, finding.pagesAffected);
    for (const url of finding.affectedUrls) group.urls.add(url);
  }
  const lines: string[] = [];
  for (const [category, group] of groups) {
    const pages = Math.max(group.urls.size, group.pages);
    lines.push(
      `${CATEGORY_LABELS[category]}: ${plural(group.issues, "issue")} across ${plural(pages, "page")}. ${CATEGORY_RISK[category]}`,
    );
  }
  return lines.join("\n");
}

export function buildTopPriorities(findings: Finding[]): string[] {
  return [...findings]
    .sort((a, b) => a.rank - b.rank)
    .slice(0, 3)
    .map((finding) => `${titleFor(finding)} (${plural(finding.pagesAffected, "page")})`);
}

export function buildMockNarrative(findings: Finding[], summary: AuditSummary, siteMeta: SiteMeta): Narrative {
  const ranked = [...findings].sort((a, b) => a.rank - b.rank);
  return {
    executiveSummary: buildExecutiveSummary(ranked, summary, siteMeta),
    riskOverview: buildRiskOverview(ranked),
    topPriorities: buildTopPriorities(ranked),
    findings: ranked.map(dictionaryFindingNarrative),
    manualChecks: MANUAL_CHECKS.map((check) => ({ title: check.title, how: check.how })),
    nextSteps: [...NEXT_STEPS],
    generatedBy: "dictionary",
  };
}
