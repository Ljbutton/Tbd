// Before/after comparison between an original audit and its re-scan (spec 10.2).

import { getRule } from "../narrative/rules.js";
import type { Delta, DeltaEntry, Finding } from "../types.js";

export interface DeltaMeta {
  originalAuditId: string;
  originalDate: string;
  rescanDate: string;
}

interface RuleTotals {
  ruleId: string;
  title: string;
  nodes: number;
  rank: number;
}

/** Collapses a findings list to one entry per rule id (rank order preserved, duplicate ids summed). */
function byRule(findings: Finding[]): Map<string, RuleTotals> {
  const map = new Map<string, RuleTotals>();
  const sorted = [...findings].sort((a, b) => a.rank - b.rank);
  for (const finding of sorted) {
    const existing = map.get(finding.ruleId);
    if (existing) {
      existing.nodes += finding.nodesTotal;
      continue;
    }
    map.set(finding.ruleId, {
      ruleId: finding.ruleId,
      title: getRule(finding.ruleId, { help: finding.help, helpUrl: finding.helpUrl }).title,
      nodes: finding.nodesTotal,
      rank: finding.rank,
    });
  }
  return map;
}

function sumNodes(findings: Finding[]): number {
  return findings.reduce((sum, finding) => sum + Math.max(0, finding.nodesTotal), 0);
}

/** percentFixed = round(100 * (before - after) / before), clamped to 0-100 and 0 when before is 0. */
export function percentFixed(nodesBefore: number, nodesAfter: number): number {
  if (nodesBefore <= 0) return 0;
  const raw = Math.round((100 * (nodesBefore - nodesAfter)) / nodesBefore);
  return Math.min(100, Math.max(0, raw));
}

/**
 * Compares two ranked findings lists keyed by rule id:
 * - fixed: rules in the original that are absent from the re-scan
 * - newIssues: rules in the re-scan that were absent from the original
 * - unchanged: rules present in both (before/after node counts may differ)
 */
export function computeDelta(original: Finding[], rescan: Finding[], meta: DeltaMeta): Delta {
  const before = byRule(original);
  const after = byRule(rescan);

  const fixed: DeltaEntry[] = [];
  const unchanged: DeltaEntry[] = [];
  const newIssues: DeltaEntry[] = [];

  for (const entry of before.values()) {
    const later = after.get(entry.ruleId);
    if (later) {
      unchanged.push({ ruleId: entry.ruleId, title: entry.title, before: entry.nodes, after: later.nodes });
    } else {
      fixed.push({ ruleId: entry.ruleId, title: entry.title, before: entry.nodes, after: 0 });
    }
  }
  for (const entry of after.values()) {
    if (!before.has(entry.ruleId)) {
      newIssues.push({ ruleId: entry.ruleId, title: entry.title, before: 0, after: entry.nodes });
    }
  }

  const nodesBefore = sumNodes(original);
  const nodesAfter = sumNodes(rescan);

  return {
    originalAuditId: meta.originalAuditId,
    originalDate: meta.originalDate,
    rescanDate: meta.rescanDate,
    fixed,
    newIssues,
    unchanged,
    nodesBefore,
    nodesAfter,
    percentFixed: percentFixed(nodesBefore, nodesAfter),
  };
}
