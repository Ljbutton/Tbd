// Ranking engine (spec section 8): folds the per-page, per-viewport axe results
// into one Finding per rule, scores it and orders the list.

import type { Confidence, Finding, Impact, PageScan, RawNode, RawViolation } from "../types.js";
import { IMPACT_WEIGHTS, categoryFor, litigationWeight } from "./litigation.js";

const IMPACT_ORDER: readonly Impact[] = ["critical", "serious", "moderate", "minor"];
const MAX_AFFECTED_URLS = 30;

/** Per-page bookkeeping for one rule. */
interface PageHit {
  url: string;
  desktopNodes: number | null;
  mobileNodes: number | null;
  desktopExample: RawNode | null;
  mobileExample: RawNode | null;
}

interface RuleAccumulator {
  ruleId: string;
  confidence: Confidence;
  impact: Impact | null;
  tags: Set<string>;
  help: string;
  helpUrl: string;
  /** Insertion order = first-seen order of pages across the scans array. */
  pages: Map<string, PageHit>;
}

function mostSevere(a: Impact | null, b: Impact | null): Impact | null {
  if (a === null) return b;
  if (b === null) return a;
  return IMPACT_ORDER.indexOf(a) <= IMPACT_ORDER.indexOf(b) ? a : b;
}

function firstNode(violation: RawViolation): RawNode | null {
  const node = violation.nodes[0];
  return node ?? null;
}

function record(
  acc: Map<string, RuleAccumulator>,
  scan: PageScan,
  violation: RawViolation,
  confidence: Confidence,
): void {
  let entry = acc.get(violation.id);
  if (!entry) {
    entry = {
      ruleId: violation.id,
      confidence,
      impact: null,
      tags: new Set(),
      help: violation.help,
      helpUrl: violation.helpUrl,
      pages: new Map(),
    };
    acc.set(violation.id, entry);
  }
  entry.impact = mostSevere(entry.impact, violation.impact);
  for (const tag of violation.tags) entry.tags.add(tag);
  if (!entry.help && violation.help) entry.help = violation.help;
  if (!entry.helpUrl && violation.helpUrl) entry.helpUrl = violation.helpUrl;

  let hit = entry.pages.get(scan.url);
  if (!hit) {
    hit = { url: scan.url, desktopNodes: null, mobileNodes: null, desktopExample: null, mobileExample: null };
    entry.pages.set(scan.url, hit);
  }
  const count = violation.nodes.length;
  if (scan.viewport === "mobile") {
    hit.mobileNodes = (hit.mobileNodes ?? 0) + count;
    if (!hit.mobileExample) hit.mobileExample = firstNode(violation);
  } else {
    hit.desktopNodes = (hit.desktopNodes ?? 0) + count;
    if (!hit.desktopExample) hit.desktopExample = firstNode(violation);
  }
}

/** Desktop count when the rule was seen on desktop for this page, otherwise the mobile count. */
function nodesForPage(hit: PageHit): number {
  if (hit.desktopNodes !== null) return hit.desktopNodes;
  return hit.mobileNodes ?? 0;
}

function exampleForPage(hit: PageHit): RawNode | null {
  return hit.desktopExample ?? hit.mobileExample;
}

function wcagTags(tags: Set<string>): string[] {
  const all = [...tags];
  const wcag = all.filter((t) => /^wcag/i.test(t));
  return wcag.length > 0 ? wcag : all;
}

function selectorFor(node: RawNode): string {
  const parts = Array.isArray(node.target) ? node.target : [];
  return parts.map((p) => (typeof p === "string" ? p : String(p))).join(" ");
}

/**
 * score = impactWeight * litigationWeight * (1 + log2(1 + pagesAffected)) * (1 + log10(1 + nodesTotal)),
 * halved for needs_manual, rounded to 2 decimals.
 */
export function scoreFinding(input: {
  impact: Impact;
  litigationWeight: number;
  pagesAffected: number;
  nodesTotal: number;
  confidence: Confidence;
}): number {
  const raw =
    IMPACT_WEIGHTS[input.impact] *
    input.litigationWeight *
    (1 + Math.log2(1 + Math.max(0, input.pagesAffected))) *
    (1 + Math.log10(1 + Math.max(0, input.nodesTotal)));
  const adjusted = input.confidence === "needs_manual" ? raw * 0.5 : raw;
  return Math.round(adjusted * 100) / 100;
}

/** Sort key: score desc, then impact severity, then rule id. */
export function compareFindings(a: Finding, b: Finding): number {
  if (b.score !== a.score) return b.score - a.score;
  const impactDiff = IMPACT_ORDER.indexOf(a.impact) - IMPACT_ORDER.indexOf(b.impact);
  if (impactDiff !== 0) return impactDiff;
  return a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0;
}

/**
 * Groups every violation (and incomplete result) by rule across pages and
 * viewports, scores each rule and returns the findings ranked from 1.
 *
 * - A page counts once per rule regardless of viewport.
 * - nodesTotal sums desktop node counts; a page where the rule only appeared on
 *   mobile contributes its mobile count.
 * - Rules present only in `incomplete` become needs_manual findings; rules in
 *   `violations` (with or without incomplete hits) are automated and only their
 *   violation nodes are counted.
 */
export function rankFindings(scans: PageScan[]): Finding[] {
  const violations = new Map<string, RuleAccumulator>();
  const incompletes = new Map<string, RuleAccumulator>();

  for (const scan of scans) {
    for (const violation of scan.violations) record(violations, scan, violation, "automated");
    for (const item of scan.incomplete) record(incompletes, scan, item, "needs_manual");
  }

  const merged: RuleAccumulator[] = [...violations.values()];
  for (const [ruleId, entry] of incompletes) {
    if (!violations.has(ruleId)) merged.push(entry);
  }

  const findings: Finding[] = merged.map((entry) => {
    const hits = [...entry.pages.values()];
    const pagesAffected = hits.length;
    const nodesTotal = hits.reduce((sum, hit) => sum + nodesForPage(hit), 0);
    const impact: Impact = entry.impact ?? "moderate";
    const weight = litigationWeight(entry.ruleId);
    const firstHit = hits[0] ?? null;
    const example = firstHit ? exampleForPage(firstHit) : null;
    return {
      rank: 0,
      ruleId: entry.ruleId,
      impact,
      category: categoryFor(entry.ruleId),
      wcagTags: wcagTags(entry.tags),
      pagesAffected,
      nodesTotal,
      litigationWeight: weight,
      score: scoreFinding({ impact, litigationWeight: weight, pagesAffected, nodesTotal, confidence: entry.confidence }),
      confidence: entry.confidence,
      examplePageUrl: firstHit ? firstHit.url : null,
      exampleSelector: example ? selectorFor(example) : null,
      exampleHtml: example ? example.html : null,
      screenshotPath: null,
      help: entry.help,
      helpUrl: entry.helpUrl,
      affectedUrls: hits.slice(0, MAX_AFFECTED_URLS).map((hit) => hit.url),
    };
  });

  findings.sort(compareFindings);
  findings.forEach((finding, index) => {
    finding.rank = index + 1;
  });
  return findings;
}
