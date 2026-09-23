// Runs axe-core on one page at one viewport and maps the result to PageScan.

import { AxeBuilder } from "@axe-core/playwright";
import axe from "axe-core";
import type { Page } from "playwright";
import type { Impact, PageScan, RawNode, RawViolation, Viewport } from "../types.js";

export const AXE_CORE_VERSION: string = axe.version;
export const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] as const;
export const AXE_DISABLED_RULES = ["region"] as const;
export const PAGE_SCAN_TIMEOUT_MS = 45000;
export const NAVIGATION_TIMEOUT_MS = 30000;
export const SETTLE_MS = 1500;
export const MAX_NODES_PER_RULE = 25;
export const MAX_NODE_HTML_CHARS = 600;

const IMPACTS: ReadonlySet<string> = new Set<Impact>(["critical", "serious", "moderate", "minor"]);

/**
 * @axe-core/playwright types its `page` against whichever playwright-core npm
 * hoisted (its peer range is `>= 1.0.0`), which can differ from the pinned
 * playwright 1.56.1 core. Only the runtime Page object is used, so the cast is
 * safe; typing it via the constructor keeps it correct for any hoisted version.
 */
type AxePage = ConstructorParameters<typeof AxeBuilder>[0]["page"];

function toImpact(value: unknown): Impact | null {
  return typeof value === "string" && IMPACTS.has(value) ? (value as Impact) : null;
}

/** axe targets are CSS selector chains; shadow-DOM hops arrive as nested arrays. */
function selectorParts(target: unknown): string[] {
  if (!Array.isArray(target)) return [String(target)];
  return target.map((part) => (Array.isArray(part) ? part.map(String).join(" ") : String(part)));
}

function toRawNode(node: axe.NodeResult): RawNode {
  const raw: RawNode = {
    target: selectorParts(node.target),
    html: (node.html ?? "").slice(0, MAX_NODE_HTML_CHARS),
  };
  if (typeof node.failureSummary === "string" && node.failureSummary !== "") raw.failureSummary = node.failureSummary;
  return raw;
}

/** Maps an axe Result to the storable RawViolation shape (max 25 nodes, html truncated). */
export function toRawViolation(result: axe.Result): RawViolation {
  return {
    id: result.id,
    impact: toImpact(result.impact),
    tags: Array.isArray(result.tags) ? result.tags.map(String) : [],
    help: result.help ?? "",
    helpUrl: result.helpUrl ?? "",
    description: result.description ?? "",
    nodes: (result.nodes ?? []).slice(0, MAX_NODES_PER_RULE).map(toRawNode),
  };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message.split("\n")[0] ?? err.message;
  return String(err);
}

function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * Navigates `page` to `url`, waits 1.5s for the page to settle, runs axe with
 * the WCAG 2.x A/AA tag set (the `region` best-practice rule disabled) and
 * returns the mapped result. Never throws: any failure (navigation, axe,
 * the 45s overall cap) yields a PageScan with `error` and empty arrays.
 */
export async function scanPage(page: Page, url: string, viewport: Viewport): Promise<PageScan> {
  const scan: PageScan = { url, viewport, statusCode: null, title: "", violations: [], incomplete: [] };

  const work = async (): Promise<void> => {
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
    scan.statusCode = response ? response.status() : null;
    await page.waitForTimeout(SETTLE_MS);
    try {
      scan.title = (await page.title()).trim();
    } catch {
      scan.title = "";
    }
    const results = await new AxeBuilder({ page: page as unknown as AxePage })
      .withTags([...AXE_TAGS])
      .disableRules([...AXE_DISABLED_RULES])
      .analyze();
    scan.violations = results.violations.map(toRawViolation);
    scan.incomplete = results.incomplete.map(toRawViolation);
  };

  try {
    await withTimeout(work(), PAGE_SCAN_TIMEOUT_MS, "Page scan");
  } catch (err) {
    scan.error = errorMessage(err);
    scan.violations = [];
    scan.incomplete = [];
  }
  return scan;
}

/** Total violation nodes in one scan (what the progress counter and teaser report). */
export function countViolationNodes(scan: PageScan): number {
  return scan.violations.reduce((sum, v) => sum + v.nodes.length, 0);
}
