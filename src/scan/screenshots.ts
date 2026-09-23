// Element and viewport screenshots for findings and the teaser.

import fs from "node:fs";
import path from "node:path";
import type { Locator, Page } from "playwright";

export const SCROLL_TIMEOUT_MS = 3000;
export const SCREENSHOT_TIMEOUT_MS = 5000;

/** Locates the first element matching an axe CSS target, forcing the css engine so odd selectors are never misparsed. */
function locate(page: Page, selector: string): Locator {
  return page.locator(`css=${selector}`).first();
}

/**
 * Returns a PNG of the first element matching `selector`, or null when the
 * selector is invalid, matches nothing, the element has no size, or the
 * capture fails or exceeds its timeout.
 */
export async function captureElementBuffer(page: Page, selector: string): Promise<Buffer | null> {
  if (typeof selector !== "string" || selector.trim() === "") return null;
  try {
    const locator = locate(page, selector);
    await locator.scrollIntoViewIfNeeded({ timeout: SCROLL_TIMEOUT_MS });
    const box = await locator.boundingBox({ timeout: SCROLL_TIMEOUT_MS });
    if (box === null || box.width <= 0 || box.height <= 0) return null;
    return await locator.screenshot({ timeout: SCREENSHOT_TIMEOUT_MS, animations: "disabled" });
  } catch {
    return null;
  }
}

/**
 * Saves a screenshot of the first element matching `selector` to `outPath`.
 * True on success, false on any error (invisible or zero-size elements included).
 */
export async function captureElement(page: Page, selector: string, outPath: string): Promise<boolean> {
  const buffer = await captureElementBuffer(page, selector);
  if (buffer === null) return false;
  try {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, buffer);
    return true;
  } catch {
    return false;
  }
}

/** Screenshot of the current viewport (teaser hero). True on success, false on any error. */
export async function captureViewport(page: Page, outPath: string): Promise<boolean> {
  try {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    await page.screenshot({ path: outPath, fullPage: false, timeout: SCREENSHOT_TIMEOUT_MS, animations: "disabled" });
    return true;
  } catch {
    return false;
  }
}
