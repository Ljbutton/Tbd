// HTML to PDF through the shared headless Chromium (spec section 10).
// The document passed in must be self-contained (render.ts inlines the
// stylesheet, logo and screenshots) so printing needs no network access.

import fs from "node:fs";
import path from "node:path";
import { closeContext, newScanContext } from "../scan/browser.js";

export const PDF_HEADER_TEMPLATE = "<span></span>";
export const PDF_FOOTER_TEMPLATE =
  '<div style="font-size:8px;width:100%;text-align:center;color:#6b7280">Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>';

/** Renders `html` to a Letter-size PDF at `outPath` (parent directory created if needed). */
export async function htmlToPdf(html: string, outPath: string): Promise<void> {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const context = await newScanContext("desktop");
  try {
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: "load" });
    await page.emulateMedia({ media: "print" });
    await page.pdf({
      path: outPath,
      format: "Letter",
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: true,
      headerTemplate: PDF_HEADER_TEMPLATE,
      footerTemplate: PDF_FOOTER_TEMPLATE,
    });
  } finally {
    await closeContext(context);
  }
}
