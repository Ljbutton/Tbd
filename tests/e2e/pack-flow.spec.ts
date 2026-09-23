// End-to-end: the Agency 5-Pack. An agency buys the pack with a logo and the
// FOUNDING50 code, gets a credit code by email, redeems one credit for a
// white-label audit of a client site, and the report carries the agency's
// brand and never ours. A second test covers the form's validation, a
// cancelled checkout with an unknown coupon, and an admin marking a pending
// order paid by hand (bank transfer / Fiverr orders).

import { expect, test } from "@playwright/test";
import { startFixtureServer, type FixtureServer } from "../../fixtures/serve.js";
import {
  ADMIN_CREDENTIALS,
  REPORT_URL_RE,
  TOKEN_RE,
  foundingSeatsLeft,
  pngLogo,
  tokenFromReportUrl,
  waitForAudit,
  type JsonReport,
} from "./helpers.js";

const CODE_RE = /^AA-[A-Z2-9]{4}-[A-Z2-9]{4}$/;

let fixture: FixtureServer;

test.beforeAll(async () => {
  fixture = await startFixtureServer();
});

test.afterAll(async () => {
  await fixture.close();
});

test("Agency 5-Pack: logo and FOUNDING50, code by email, one credit starts a white-label audit", async ({ page, request, browser }) => {
  test.setTimeout(600000);
  const clientUrl = `${fixture.url}/products.html`;
  const seatsBefore = await foundingSeatsLeft(page);
  expect(seatsBefore).toBeGreaterThan(0);

  // Order form: no website field for a pack, logo upload, coupon
  await page.goto("/order?product=pack5");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Order your Agency 5-Pack");
  expect(await page.getByLabel("Website address").count()).toBe(0);
  await expect(page.getByText(`Founding offer: the first 20 agencies pay $99 with code FOUNDING50 (${seatsBefore} left).`)).toBeVisible();
  await page.getByLabel("Email").fill("agency@example.com");
  await page.getByLabel("Agency name").fill("Northwind Digital");
  await page.getByLabel(/Agency logo/).setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: pngLogo() });
  await page.getByLabel(/Coupon code/).fill("FOUNDING50");
  await page.getByLabel(/I understand this is an automated audit/).check();
  await page.getByRole("button", { name: "Continue to payment" }).click();

  // Mock checkout shows the discounted total
  await expect(page).toHaveURL(/\/mock\/checkout\/[^/?]+$/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Pay $99");
  await expect(page.locator("tr", { hasText: "Agency 5-Pack" })).toContainText("$149");
  await expect(page.locator("tr", { hasText: "Coupon FOUNDING50" })).toContainText("-$50");
  await expect(page.locator("tr", { hasText: "Total due today" })).toContainText("$99");
  await expect(page.locator("dd", { hasText: "Northwind Digital" })).toBeVisible();
  await page.getByRole("button", { name: /^Pay \$99 \(test mode\)$/ }).click();

  // Success page: the code and five credits
  await expect(page).toHaveURL(/\/success\?order=/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your 5-Pack is ready");
  await expect(page.getByText("Thanks for your order of $99.")).toBeVisible();
  const code = ((await page.getByTestId("credit-code").textContent()) ?? "").trim();
  expect(code).toMatch(CODE_RE);
  await expect(page.getByTestId("credits-left")).toHaveText("5 credits left");
  await expect(page.getByRole("link", { name: "Start your first audit" })).toHaveAttribute("href", `/credits/${code}`);
  await expect(page.getByText(`http://localhost:3101/credits/${code}`)).toBeVisible();

  // One founding seat was used
  expect(await foundingSeatsLeft(page)).toBe(seatsBefore - 1);

  // The code email is in the outbox with the credits link
  await page.goto("/outbox");
  await page.getByRole("link", { name: "Your Agency 5-Pack code" }).first().click();
  await expect(page.getByRole("heading", { level: 2, name: "Your Agency 5-Pack code" })).toBeVisible();
  await expect(page.getByText("agency@example.com").first()).toBeVisible();
  await expect(page.getByRole("link", { name: `http://localhost:3101/credits/${code}` })).toBeVisible();

  // Code lookup is forgiving about case and dashes; unknown codes are 404
  expect((await request.get(`/credits/${code.toLowerCase().replace(/-/g, "")}`)).status()).toBe(200);
  expect((await request.get("/credits/AA-ZZZZ-ZZZZ")).status()).toBe(404);
  expect((await request.get("/credits/AA-ZZZZ-ZZZZ")).headers()["x-robots-tag"] ?? "").not.toContain("index");

  // Redeem one credit
  await page.goto(`/credits/${code}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Northwind Digital");
  await expect(page.getByText(`Code ${code}`)).toBeVisible();
  await expect(page.getByTestId("credits-left")).toHaveText("5");
  await expect(page.getByTestId("audits-started")).toHaveText("0");
  await expect(page.getByText("No audits yet.")).toBeVisible();
  await expect(page.getByLabel("Send the report to")).toHaveValue("agency@example.com");
  await page.getByLabel("Client website address").fill(clientUrl);
  await page.getByRole("button", { name: "Start audit (uses 1 credit)" }).click();

  await expect(page).toHaveURL(REPORT_URL_RE);
  const token = tokenFromReportUrl(page.url());
  expect(token).toMatch(TOKEN_RE);
  const reportPath = `/r/${token}`;
  await expect(page.locator("p.muted").first()).toContainText("Agency 5-Pack for Northwind Digital");
  await expect(page.getByTestId("report-progress")).toContainText("of up to 30 pages scanned");

  await page.goto(`/credits/${code}`);
  await expect(page.getByTestId("credits-left")).toHaveText("4");
  await expect(page.getByTestId("audits-started")).toHaveText("1");
  const auditRow = page.locator("tr", { hasText: clientUrl });
  await expect(auditRow.getByRole("link", { name: "Open" })).toHaveAttribute("href", reportPath);

  const outcome = await waitForAudit(request, token);
  expect(outcome).toMatchObject({ status: "ready", ready: true, error: null });

  // The white-label report: agency brand on the cover, none of ours anywhere
  await page.goto(reportPath);
  await expect(page.getByRole("link", { name: "Download PDF" })).toBeVisible();
  await expect(page.getByTestId("rescan-card")).toContainText("1 free re-scan available until");
  const report = page.locator(".report--web");
  await expect(report.locator(".report-brand__name")).toHaveText("Northwind Digital");
  await expect(report.locator("img.report-brand__logo--agency")).toHaveAttribute("src", /^data:image\/png;base64,/);
  await expect(report.locator("img.report-brand__logo--agency")).toHaveAttribute("alt", "Northwind Digital logo");
  await expect(report.locator("#report-cover")).not.toContainText("Prepared for");
  await expect(report).not.toContainText("Scanned with");
  await expect(report).not.toContainText("AccessAudit");
  await expect(report).toContainText("Images are missing text descriptions");
  await expect(report.locator("#report-pages")).toContainText("/products.html");

  const pdf = await request.get(`${reportPath}/pdf`);
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()["content-type"]).toContain("application/pdf");
  expect((await pdf.body()).length).toBeGreaterThan(20000);

  const json = (await (await request.get(`${reportPath}/json`)).json()) as JsonReport;
  expect(json.url).toBe(clientUrl);
  expect(json.summary.pagesScanned).toBe(5);
  expect(json.findings.map((finding) => finding.ruleId)).toContain("image-alt");

  const record = await (await request.get(`${reportPath}/record`)).text();
  expect(record).toContain("Accessibility Remediation Record");
  expect(record).toContain("Northwind Digital");
  expect(record).not.toContain("AccessAudit");

  // The credits page lists the finished audit
  await page.goto(`/credits/${code}`);
  await expect(page.locator("tr", { hasText: clientUrl })).toContainText("Ready");
  await expect(page.locator("tr", { hasText: clientUrl }).getByRole("link", { name: "Open" })).toHaveAttribute("href", reportPath);

  // The report-ready email went to the agency address
  await page.goto("/outbox");
  await expect(page.locator("tr", { hasText: "agency@example.com" }).filter({ hasText: "Your accessibility audit is ready" })).toHaveCount(1);

  // Admin sees the discounted order and the white-label audit
  const admin = await browser.newContext({ httpCredentials: ADMIN_CREDENTIALS });
  const adminPage = await admin.newPage();
  await adminPage.goto("/admin");
  const orderRow = adminPage.locator("tr", { hasText: "agency@example.com" });
  await expect(orderRow).toContainText("pack5");
  await expect(orderRow).toContainText("FOUNDING50");
  await expect(orderRow).toContainText("$99");
  await expect(orderRow).toContainText("mock");
  const auditAdminRow = adminPage.locator("tr", { has: adminPage.locator(`a[href="${reportPath}"]`) });
  await expect(auditAdminRow).toContainText("white-label");
  await expect(auditAdminRow).toContainText("ready");
  await admin.close();
});

test("5-Pack form validation, cancelled checkout with an unknown coupon, and admin Mark paid", async ({ page, browser }) => {
  test.setTimeout(300000);

  // Empty submit: every problem is listed inline
  await page.goto("/order?product=pack5");
  await page.getByRole("button", { name: "Continue to payment" }).click();
  await expect(page).toHaveURL(/\/order$/);
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("Enter your agency name");
  await expect(alert).toContainText("Enter the email address that should receive the report.");
  await expect(alert).toContainText("Please confirm you understand what this audit is and isn't.");

  // A text file is not a logo
  await page.getByLabel("Email").fill("studio@example.com");
  await page.getByLabel("Agency name").fill("Harbor Studio");
  await page.getByLabel(/Agency logo/).setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("not an image") });
  await page.getByLabel(/Coupon code/).fill("NOTACODE");
  await page.getByLabel(/I understand this is an automated audit/).check();
  await page.getByRole("button", { name: "Continue to payment" }).click();
  await expect(page.getByRole("alert")).toContainText("The logo must be a PNG, JPG or SVG file.");
  await expect(page.getByLabel("Email")).toHaveValue("studio@example.com");
  await expect(page.getByLabel("Agency name")).toHaveValue("Harbor Studio");
  await expect(page.getByLabel(/Coupon code/)).toHaveValue("NOTACODE");
  await expect(page.getByLabel(/I understand this is an automated audit/)).toBeChecked();

  // Without the file the order goes through; the unknown coupon is ignored with a notice
  await page.getByRole("button", { name: "Continue to payment" }).click();
  await expect(page).toHaveURL(/\/mock\/checkout\/[^/?]+\?notice=/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Pay $149");
  await expect(page.getByText(`We don't recognise the code "NOTACODE", so the regular price applies.`)).toBeVisible();
  expect(await page.locator("tr", { hasText: "Coupon" }).count()).toBe(0);
  const orderId = /\/mock\/checkout\/([^/?]+)/.exec(page.url())?.[1] ?? "";
  expect(orderId).not.toBe("");

  // Cancel: nothing charged, a way back to the form
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page).toHaveURL(new RegExp(`/cancel\\?order=${orderId}$`));
  await expect(page.getByText("No charge was made.")).toBeVisible();
  await expect(page.locator('a[href^="/order?product=pack5"]').first()).toBeVisible();
  await page.goto(`/success?order=${orderId}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Confirming your payment…");
  await expect(page.getByRole("link", { name: "Return to the test checkout" })).toHaveAttribute("href", `/mock/checkout/${orderId}`);

  // Admin marks the pending order paid by hand
  const admin = await browser.newContext({ httpCredentials: ADMIN_CREDENTIALS });
  const adminPage = await admin.newPage();
  await adminPage.goto("/admin");
  const pendingRow = adminPage.locator("tr", { hasText: "studio@example.com" });
  await expect(pendingRow).toContainText("pending");
  await expect(pendingRow).toContainText("$149");
  await pendingRow.getByRole("button", { name: "Mark paid" }).click();
  await expect(adminPage.locator(".alert-success")).toContainText("Order marked paid.");
  const paidRow = adminPage.locator("tr", { hasText: "studio@example.com" });
  await expect(paidRow).toContainText("paid");
  await expect(paidRow).toContainText("admin");
  expect(await paidRow.getByRole("button", { name: "Mark paid" }).count()).toBe(0);
  await admin.close();

  // The buyer's success page now shows the code, and it works
  await page.goto(`/success?order=${orderId}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your 5-Pack is ready");
  const code = ((await page.getByTestId("credit-code").textContent()) ?? "").trim();
  expect(code).toMatch(CODE_RE);
  await page.goto(`/credits/${code}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Harbor Studio");
  await expect(page.getByTestId("credits-left")).toHaveText("5");
  await expect(page.getByText("White-label report with the Harbor Studio name on the cover.")).toBeVisible();
  await page.goto("/outbox");
  await expect(page.locator("tr", { hasText: "studio@example.com" }).filter({ hasText: "Your Agency 5-Pack code" })).toHaveCount(1);
});
