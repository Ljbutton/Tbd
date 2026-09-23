// Entry point for the pipeline: picks the dictionary or Claude narrative by mode.

import { config } from "../config.js";
import type { AuditSummary, Finding, Narrative, SiteMeta } from "../types.js";
import { buildClaudeNarrative } from "./claude.js";
import { buildMockNarrative } from "./mock.js";

export { buildClaudeNarrative, NarrativeSchema } from "./claude.js";
export { MANUAL_CHECKS } from "./manual-checks.js";
export { buildMockNarrative } from "./mock.js";
export { RULES, getRule } from "./rules.js";

/**
 * Builds the report narrative. With no ANTHROPIC_API_KEY (config.mockLlm) the
 * dictionary narrative is returned; otherwise Claude is asked and any failure
 * silently falls back to the dictionary (logged via `log`). Never throws.
 */
export async function buildNarrative(
  findings: Finding[],
  summary: AuditSummary,
  siteMeta: SiteMeta,
  log: (line: string) => void = (line) => console.log(line),
): Promise<Narrative> {
  if (config.mockLlm) {
    log("narrative: using dictionary (no ANTHROPIC_API_KEY)");
    return buildMockNarrative(findings, summary, siteMeta);
  }
  return buildClaudeNarrative(findings, summary, siteMeta, log);
}
