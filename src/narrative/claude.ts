// Claude-written narrative (spec 9.4). The call shape follows the verified SDK
// usage in the facts file: messages.parse + zodOutputFormat, adaptive thinking,
// medium effort, 120 s timeout. Any failure at all falls back to the dictionary
// narrative and is logged for the admin; nothing here ever throws into the
// pipeline.

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { config } from "../config.js";
import type { AuditSummary, Finding, FindingNarrative, Narrative, SiteMeta } from "../types.js";
import { MANUAL_CHECKS } from "./manual-checks.js";
import { buildMockNarrative, dictionaryFindingNarrative } from "./mock.js";
import { RULES } from "./rules.js";

export const NarrativeSchema = z.object({
  executiveSummary: z.string(),
  riskOverview: z.string(),
  topPriorities: z.array(z.string()),
  findings: z.array(
    z.object({
      ruleId: z.string(),
      title: z.string(),
      plainEnglish: z.string(),
      whyItMatters: z.string(),
      fixSteps: z.array(z.string()),
      beforeHtml: z.string().nullable(),
      afterHtml: z.string().nullable(),
      effort: z.enum(["minutes", "hours", "days"]),
    }),
  ),
  manualChecks: z.array(z.object({ title: z.string(), how: z.string() })),
  nextSteps: z.array(z.string()),
});

export type ParsedNarrative = z.infer<typeof NarrativeSchema>;

export const MAX_CLAUDE_FINDINGS = 25;
const MAX_PAYLOAD_URLS = 5;
const MIN_MANUAL_CHECKS = 8;
const MAX_MANUAL_CHECKS = 12;
const REQUEST_TIMEOUT_MS = 120_000;

export const SYSTEM = [
  "You write the narrative for a website accessibility audit report sold by AccessAudit. The reader is a non-technical small-business owner or a freelance web designer who will hand the report to whoever maintains the site.",
  "",
  "Voice:",
  '- Plain English, second person ("your site", "your visitors"). No jargon; when a technical term is unavoidable, explain it in the same sentence.',
  '- Be concrete. Name who is affected (for example, "screen reader users hear \'image\' with no description") and what happens to them on this site.',
  "- American English spelling.",
  "",
  "Honesty rules (non-negotiable):",
  "- Never claim or imply that fixing these issues makes the site compliant, certified, or protected from lawsuits, and never give legal advice.",
  '- Never use the word "compliant" or "compliance" except in the exact phrase "this does not make your site compliant".',
  "- Automated checks find roughly 30-40% of WCAG issues; say so where relevant and point to the manual checks in section 5 of the report.",
  "",
  "Output rules:",
  "- executiveSummary: 3-5 sentences using the numbers in summary (pages scanned, distinct issues, elements affected, critical or serious count) and naming the top priorities. End by noting that automated checks find roughly 30-40% of WCAG issues and the manual checks in section 5 cover the rest.",
  "- riskOverview: one short paragraph grouping the findings by category (images, contrast, forms, links and buttons, keyboard, structure, language, media, custom controls, mobile) with page counts and who each category affects.",
  "- topPriorities: up to 3 items, each a finding title plus its page count.",
  "- findings: include EVERY finding from the input exactly once, in the order given, with ruleId copied exactly as provided. For each: title (short, plain, names the problem); plainEnglish (2-3 sentences on what we found on this site); whyItMatters (2-3 sentences on who is affected and how); fixSteps (2-5 concrete steps a developer or site-builder user can follow); beforeHtml (the provided exampleHtml VERBATIM, character for character, or null only when exampleHtml is null); afterHtml (a minimal corrected version of that same markup that keeps every original attribute and only adds or changes what the fix needs, or null when the fix is CSS-only, in which case put the CSS in fixSteps); effort (minutes, hours or days).",
  '- Findings with confidence "needs_manual" could not be confirmed automatically: say so in plainEnglish and explain how to verify by hand.',
  "- Use dictionaryHint as a starting point where it helps, but tailor the text to this site: its platform, its page names and what the example markup shows.",
  "- manualChecks: 8-12 items, each with a title and a how that a non-expert can follow in under ten minutes.",
  "- nextSteps: 3-5 sentences: what to fix first, who to hand the report to, the free re-scan within 30 days, and completing the manual checks.",
].join("\n");

export interface ClaudePayloadFinding {
  ruleId: string;
  impact: Finding["impact"];
  confidence: Finding["confidence"];
  pagesAffected: number;
  nodesTotal: number;
  affectedUrls: string[];
  exampleHtml: string | null;
  help: string;
  helpUrl: string;
  dictionaryHint: string | undefined;
}

export interface ClaudePayload {
  siteMeta: SiteMeta;
  summary: AuditSummary;
  findings: ClaudePayloadFinding[];
}

/** The top 25 findings plus site and summary data, as sent to the model. */
export function buildClaudePayload(findings: Finding[], summary: AuditSummary, siteMeta: SiteMeta): ClaudePayload {
  const top = [...findings].sort((a, b) => a.rank - b.rank).slice(0, MAX_CLAUDE_FINDINGS);
  return {
    siteMeta,
    summary,
    findings: top.map((finding) => ({
      ruleId: finding.ruleId,
      impact: finding.impact,
      confidence: finding.confidence,
      pagesAffected: finding.pagesAffected,
      nodesTotal: finding.nodesTotal,
      affectedUrls: finding.affectedUrls.slice(0, MAX_PAYLOAD_URLS),
      exampleHtml: finding.exampleHtml,
      help: finding.help,
      helpUrl: finding.helpUrl,
      dictionaryHint: RULES[finding.ruleId]?.plainEnglish,
    })),
  };
}

const ALLOWED_COMPLIANCE_PHRASE = /this does not make your site compliant/gi;
const FORBIDDEN_COPY = /complian|certif/i;

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => collectStrings(v, out));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => collectStrings(v, out));
}

/**
 * The honesty rule from spec section 1 applies to generated text too: any
 * use of the forbidden wording outside the one permitted phrase disqualifies
 * the whole response (the dictionary text is used instead).
 */
export function copyRuleViolation(parsed: ParsedNarrative): string | null {
  const strings: string[] = [];
  collectStrings(parsed, strings);
  for (const text of strings) {
    const stripped = text.replace(ALLOWED_COMPLIANCE_PHRASE, "");
    const match = FORBIDDEN_COPY.exec(stripped);
    if (match) {
      const start = Math.max(0, match.index - 40);
      return `forbidden wording "${stripped.slice(start, match.index + match[0].length + 40).trim()}"`;
    }
  }
  return null;
}

function nonEmpty(items: string[]): string[] {
  return items.map((s) => s.trim()).filter((s) => s !== "");
}

/**
 * Merges the model output with the input findings so the report never has a
 * hole: every input rule id gets an entry (dictionary when the model skipped
 * it or when it sat beyond the top 25), unknown rule ids are dropped, the
 * order follows the ranking, beforeHtml is forced to the verbatim example, and
 * the manual checks are kept between 8 and 12 items.
 */
export function reconcileNarrative(
  parsed: ParsedNarrative,
  findings: Finding[],
  summary: AuditSummary,
  siteMeta: SiteMeta,
  model: string,
): Narrative {
  const ranked = [...findings].sort((a, b) => a.rank - b.rank);
  const fallback = buildMockNarrative(ranked, summary, siteMeta);
  const byRule = new Map<string, ParsedNarrative["findings"][number]>();
  for (const entry of parsed.findings) {
    if (!byRule.has(entry.ruleId)) byRule.set(entry.ruleId, entry);
  }

  const merged: FindingNarrative[] = ranked.map((finding, index) => {
    const dictionary = dictionaryFindingNarrative(finding);
    const fromModel = index < MAX_CLAUDE_FINDINGS ? byRule.get(finding.ruleId) : undefined;
    if (!fromModel) return dictionary;
    const fixSteps = nonEmpty(fromModel.fixSteps);
    return {
      ruleId: finding.ruleId,
      title: fromModel.title.trim() || dictionary.title,
      plainEnglish: fromModel.plainEnglish.trim() || dictionary.plainEnglish,
      whyItMatters: fromModel.whyItMatters.trim() || dictionary.whyItMatters,
      fixSteps: fixSteps.length > 0 ? fixSteps : dictionary.fixSteps,
      beforeHtml: finding.exampleHtml,
      afterHtml: finding.exampleHtml === null ? null : fromModel.afterHtml,
      effort: fromModel.effort,
    };
  });

  let manualChecks = parsed.manualChecks
    .map((check) => ({ title: check.title.trim(), how: check.how.trim() }))
    .filter((check) => check.title !== "" && check.how !== "");
  if (manualChecks.length < MIN_MANUAL_CHECKS) {
    const have = new Set(manualChecks.map((c) => c.title.toLowerCase()));
    for (const check of MANUAL_CHECKS) {
      if (manualChecks.length >= MAX_MANUAL_CHECKS) break;
      if (!have.has(check.title.toLowerCase())) manualChecks.push({ title: check.title, how: check.how });
    }
  }
  manualChecks = manualChecks.slice(0, MAX_MANUAL_CHECKS);

  const topPriorities = nonEmpty(parsed.topPriorities).slice(0, 3);
  const nextSteps = nonEmpty(parsed.nextSteps);

  return {
    executiveSummary: parsed.executiveSummary.trim() || fallback.executiveSummary,
    riskOverview: parsed.riskOverview.trim() || fallback.riskOverview,
    topPriorities: topPriorities.length > 0 ? topPriorities : fallback.topPriorities,
    findings: merged,
    manualChecks,
    nextSteps: nextSteps.length > 0 ? nextSteps : fallback.nextSteps,
    generatedBy: "claude",
    model,
  };
}

/** Short, admin-readable reason for a failed call. */
export function describeFailure(error: unknown): string {
  if (error instanceof Anthropic.APIConnectionTimeoutError) return "timeout after 120s";
  if (error instanceof Anthropic.APIConnectionError) return `connection error: ${error.message}`;
  if (error instanceof Anthropic.APIError) {
    const status = error.status === undefined ? "" : `${error.status} `;
    return `${status}${error.name}: ${error.message}`;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Asks Claude for the narrative. Resolves to the dictionary narrative (never
 * rejects) when the API key is missing, the call fails, the model refuses, the
 * output cannot be parsed, or the copy breaks the honesty rules.
 */
export async function buildClaudeNarrative(
  findings: Finding[],
  summary: AuditSummary,
  siteMeta: SiteMeta,
  log: (line: string) => void = (line) => console.warn(line),
): Promise<Narrative> {
  try {
    const payload = buildClaudePayload(findings, summary, siteMeta);
    const client = new Anthropic();
    const response = await client.messages.parse(
      {
        model: config.anthropic.model,
        max_tokens: 16000,
        thinking: { type: "adaptive" },
        output_config: { effort: "medium", format: zodOutputFormat(NarrativeSchema) },
        system: SYSTEM,
        messages: [{ role: "user", content: JSON.stringify(payload) }],
      },
      { timeout: REQUEST_TIMEOUT_MS },
    );

    if (response.stop_reason === "refusal") throw new Error("model refused the request");
    if (response.stop_reason === "max_tokens") throw new Error("output truncated at max_tokens");
    const parsed = response.parsed_output;
    if (!parsed) throw new Error("response did not parse against NarrativeSchema");

    const violation = copyRuleViolation(parsed);
    if (violation) throw new Error(`copy rule violation: ${violation}`);

    const narrative = reconcileNarrative(parsed, findings, summary, siteMeta, response.model || config.anthropic.model);
    log(`narrative: claude ok (${narrative.model}, ${parsed.findings.length} findings written)`);
    return narrative;
  } catch (error) {
    log(`narrative: claude failed (${describeFailure(error)}), using dictionary`);
    return buildMockNarrative(findings, summary, siteMeta);
  }
}
