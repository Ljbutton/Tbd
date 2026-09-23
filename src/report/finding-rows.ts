import { newId } from "../util/ids.js";
import type { Finding, FindingRow, Impact } from "../types.js";

function parseStringArray(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

const IMPACTS: readonly Impact[] = ["critical", "serious", "moderate", "minor"];

/** Maps a ranked Finding to a findings-table row (assigns a fresh row id). */
export function findingToRow(auditId: string, finding: Finding): FindingRow {
  return {
    id: newId(),
    audit_id: auditId,
    rank: finding.rank,
    rule_id: finding.ruleId,
    impact: finding.impact,
    category: finding.category,
    wcag_tags: JSON.stringify(finding.wcagTags),
    pages_affected: finding.pagesAffected,
    nodes_total: finding.nodesTotal,
    litigation_weight: finding.litigationWeight,
    score: finding.score,
    confidence: finding.confidence,
    example_page_url: finding.examplePageUrl,
    example_selector: finding.exampleSelector,
    example_html: finding.exampleHtml,
    screenshot_path: finding.screenshotPath,
    help: finding.help,
    help_url: finding.helpUrl,
    affected_urls: JSON.stringify(finding.affectedUrls.slice(0, 30)),
  };
}

/** Maps a findings-table row back to the Finding shape the report code consumes. */
export function rowToFinding(row: FindingRow): Finding {
  const impact = IMPACTS.includes(row.impact) ? row.impact : "moderate";
  return {
    rank: row.rank,
    ruleId: row.rule_id,
    impact,
    category: row.category,
    wcagTags: parseStringArray(row.wcag_tags),
    pagesAffected: row.pages_affected,
    nodesTotal: row.nodes_total,
    litigationWeight: row.litigation_weight,
    score: row.score,
    confidence: row.confidence === "needs_manual" ? "needs_manual" : "automated",
    examplePageUrl: row.example_page_url,
    exampleSelector: row.example_selector,
    exampleHtml: row.example_html,
    screenshotPath: row.screenshot_path,
    help: row.help,
    helpUrl: row.help_url,
    affectedUrls: parseStringArray(row.affected_urls),
  };
}
