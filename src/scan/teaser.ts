// Free single-page teaser scan: one desktop context, one axe run, top three
// automated findings with dictionary explanations and inline screenshots.
// Never calls Claude (free scans stay free) and never runs longer than 60s.

import type { BrowserContext, Page } from "playwright";
import { getRule } from "../narrative/rules.js";
import { rankFindings } from "../report/rank.js";
import type { Finding, TeaserResult } from "../types.js";
import { HttpError } from "../util/http.js";
import { countViolationNodes, scanPage } from "./axe.js";
import { closeContext, newScanContext } from "./browser.js";
import { captureElementBuffer } from "./screenshots.js";

export const TEASER_TIMEOUT_MS = 60000;
export const TEASER_TOP_COUNT = 3;
export const TEASER_MAX_SCREENSHOT_BYTES = 200 * 1024;
export const TEASER_TIMEOUT_MESSAGE = "That page took too long to load. Try again or scan a different page.";

function timeoutError(): HttpError {
  return new HttpError(504, TEASER_TIMEOUT_MESSAGE, "timeout");
}

function isTimeoutMessage(message: string): boolean {
  return /timed out|timeout/i.test(message);
}

async function screenshotDataUrl(page: Page, finding: Finding): Promise<string | null> {
  if (finding.exampleSelector === null || finding.exampleSelector === "") return null;
  const buffer = await captureElementBuffer(page, finding.exampleSelector);
  if (buffer === null || buffer.length > TEASER_MAX_SCREENSHOT_BYTES) return null;
  return `data:image/png;base64,${buffer.toString("base64")}`;
}

async function runTeaserWork(url: string, context: BrowserContext): Promise<TeaserResult> {
  const page = await context.newPage();
  const scan = await scanPage(page, url, "desktop");
  if (scan.error !== undefined) {
    if (isTimeoutMessage(scan.error)) throw timeoutError();
    throw new HttpError(502, `We couldn't load that page (${scan.error}). Check the address and try again.`, "page_unreachable");
  }

  const findings = rankFindings([scan]);
  const automated = findings.filter((f) => f.confidence === "automated");
  const needsManualCount = findings.length - automated.length;

  const top: TeaserResult["top"] = [];
  for (const finding of automated.slice(0, TEASER_TOP_COUNT)) {
    const rule = getRule(finding.ruleId, { help: finding.help, helpUrl: finding.helpUrl });
    top.push({
      ruleId: finding.ruleId,
      title: rule.title,
      impact: finding.impact,
      nodes: finding.nodesTotal,
      plainEnglish: rule.plainEnglish,
      screenshotDataUrl: await screenshotDataUrl(page, finding),
      exampleHtml: finding.exampleHtml ?? "",
    });
  }

  return {
    url: scan.url,
    title: scan.title,
    scannedAt: new Date().toISOString(),
    violationNodes: countViolationNodes(scan),
    rulesFailed: scan.violations.length,
    top,
    needsManualCount,
    cached: false,
  };
}

/**
 * Scans one page at desktop size and returns the teaser card data. Throws
 * HttpError 504 (`timeout`) when the page does not finish within 60s and
 * HttpError 502 (`page_unreachable`) when it cannot be loaded at all. The
 * browser context is always closed before this returns.
 */
export async function runTeaser(url: string): Promise<TeaserResult> {
  let context: BrowserContext | null = null;
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(timeoutError()), TEASER_TIMEOUT_MS);
  });
  try {
    context = await newScanContext("desktop");
    return await Promise.race([runTeaserWork(url, context), deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    await closeContext(context);
  }
}
