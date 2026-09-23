// End-to-end: the Site Audit buyer's path through the real server, from the
// landing page and the free scan to a ready report, its exports, the free
// re-scan with a before/after section, the admin pages, a failed audit and a
// Reviewed Audit released by hand. The target site is the bundled fixture
// store (fixtures/site), served from a random port in beforeAll.

import { expect, test } from "@playwright/test";
import { startFixtureServer, type FixtureServer } from "../../fixtures/serve.js";
import {
  ADMIN_CREDENTIALS,
  CSV_HEADER,
  FIXTURE_RULES,
  REPORT_URL_RE,
  TEASER_WAIT_MS,
  TOKEN_RE,
  orderAndPay,
  tokenFromReportUrl,
  waitForAudit,
  type JsonReport,
  type TeaserResponse,
} from "./helpers.js";

let fixture: FixtureServer;

test.beforeAll(async () => {
  fixture = await startFixtureServer();
});

test.afterAll(async () => {
  await fixture.close();
});

test("landing page renders and the free single-page scan returns three ranked issues", async ({ page, request }) => {
  await page.goto("/");
  await expect(page).toHaveTitle(/AccessAudit/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Find out what an ADA lawsuit would find on your website. Before a lawyer does.",
  );
  await expect(page.getByRole("link", { name: "Audit my site" })).toHaveAttribute("href", "/order?product=single");
  await expect(page.getByRole("link", { name: "Get 5 credits" })).toHaveAttribute("href", "/order?product=pack5");
  await expect(page.getByRole("link", { name: "Order a reviewed audit" })).toHaveAttribute("href", "/order?product=reviewed");
  await expect(page.locator("footer").getByText("TEST MODE")).toBeVisible();
  await expect(page.locator("iframe.sample-frame")).toHaveAttribute("src", "/sample-report.pdf");

  // The free scan through the form (progressively enhanced by public/app.js).
  const scanBox = page.locator("#scan");
  await scanBox.getByLabel("Your page address").fill(`${fixture.url}/`);
  await scanBox.getByRole("button", { name: "Scan one page free" }).click();
  const resultHeading = scanBox.getByRole("heading", { name: /^\d+ issues on this page across \d+ rules$/ });
  await expect(resultHeading).toBeVisible({ timeout: TEASER_WAIT_MS });
  const counts = /^(\d+) issues on this page across (\d+) rules$/.exec(((await resultHeading.textContent()) ?? "").trim());
  expect(counts).not.toBeNull();
  expect(Number(counts?.[1])).toBeGreaterThan(0);
  expect(Number(counts?.[2])).toBeGreaterThanOrEqual(3);
  await expect(scanBox.locator(".issue-card")).toHaveCount(3);
  await expect(scanBox.locator(".issue-card .badge").first()).toBeVisible();
  await expect(scanBox.locator(".issue-card pre code").first()).not.toBeEmpty();
  await expect(scanBox.getByText("This is one page at desktop size.")).toBeVisible();
  await expect(scanBox.getByRole("link", { name: /Get the full-site audit/ })).toHaveAttribute(
    "href",
    /^\/order\?product=single&url=http%3A%2F%2F127\.0\.0\.1/,
  );

  // The API behind the form: the same page is served from the 24-hour cache, bad input is a 400.
  const cached = await request.post("/api/teaser", { data: { url: `${fixture.url}/` } });
  expect(cached.status()).toBe(200);
  const body = (await cached.json()) as TeaserResponse;
  expect(body.cached).toBe(true);
  expect(body.top).toHaveLength(3);
  for (const issue of body.top) {
    expect(["critical", "serious", "moderate", "minor"]).toContain(issue.impact);
    expect(issue.plainEnglish.length).toBeGreaterThan(20);
    expect(issue.nodes).toBeGreaterThan(0);
  }
  const invalid = await request.post("/api/teaser", { data: { url: "not a url" } });
  expect(invalid.status()).toBe(400);
  expect(((await invalid.json()) as { error: string }).error).toBe("invalid_url");
});

test("Site Audit: order, mock payment, progress, ready report, exports, free re-scan and admin", async ({ page, request, browser }) => {
  test.setTimeout(600000);
  const siteUrl = `${fixture.url}/`;

  // Order form -> mock checkout -> success page
  const reportPath = await orderAndPay(page, { product: "single", url: siteUrl, email: "buyer@example.com" });
  const token = tokenFromReportUrl(reportPath);
  await expect(page.getByText("In test mode, see")).toBeVisible();

  // Progress page while the pipeline runs
  await page.goto(reportPath);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("127.0.0.1");
  const progress = page.getByTestId("report-progress");
  await expect(progress).toBeVisible();
  await expect(progress).toHaveAttribute("data-poll-url", `/api/audits/${token}/status`);
  await expect(progress.locator('[data-poll-field="label"]')).toHaveText(
    /^(Waiting in line|Finding pages|Scanning pages|Writing your report|Building the PDF)$/,
  );
  await expect(progress).toContainText("of up to 15 pages scanned");
  expect(await page.getByRole("link", { name: "Download PDF" }).count()).toBe(0);
  expect((await request.get(`${reportPath}/pdf`)).status()).toBe(404);

  const outcome = await waitForAudit(request, token);
  expect(outcome).toMatchObject({ status: "ready", ready: true, error: null });
  expect(outcome.progressPages).toBe(5);
  expect(outcome.progressIssues).toBeGreaterThan(0);

  // The finished report page
  await page.goto(reportPath);
  const downloads = page.getByTestId("report-downloads");
  await expect(downloads.getByRole("link", { name: "Download PDF" })).toHaveAttribute("href", `${reportPath}/pdf`);
  await expect(downloads.getByRole("link", { name: "JSON" })).toHaveAttribute("href", `${reportPath}/json`);
  await expect(downloads.getByRole("link", { name: "CSV" })).toHaveAttribute("href", `${reportPath}/csv`);
  await expect(downloads.getByRole("link", { name: "Remediation record" })).toHaveAttribute("href", `${reportPath}/record`);
  await expect(downloads.getByRole("button", { name: "Copy issue table as HTML" })).toBeVisible();
  await expect(page.getByTestId("rescan-card")).toContainText("1 free re-scan available until");

  const report = page.locator(".report--web");
  for (const heading of ["Executive summary", "Issues at a glance", "Findings in detail", "Manual checks you still need", "Pages scanned", "Method and limits"]) {
    await expect(report.getByRole("heading", { level: 2, name: new RegExp(heading) })).toBeVisible();
  }
  expect(await report.getByRole("heading", { level: 2, name: /Before \/ after/ }).count()).toBe(0);
  await expect(report.locator(".report-brand__name")).toHaveText("AccessAudit");
  await expect(report.locator("#report-cover")).toContainText("Prepared for");
  await expect(report.locator("#report-cover")).toContainText("buyer@example.com");
  await expect(report).toContainText("Images are missing text descriptions");
  const pagesTable = report.locator("#report-pages");
  await expect(pagesTable.locator("tbody tr")).toHaveCount(5);
  for (const path of ["/products.html", "/about.html", "/contact.html", "/checkout.html"]) {
    await expect(pagesTable).toContainText(path);
  }
  // Disallowed by robots.txt, and only referenced from an iframe (which is itself a
  // finding, so its address shows up in a "Before" snippet): neither page is crawled.
  await expect(pagesTable).not.toContainText("/private/secret.html");
  await expect(pagesTable).not.toContainText("/hours.html");
  await expect(report).not.toContainText("/private/secret.html");

  // Downloads
  const pdf = await request.get(`${reportPath}/pdf`);
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()["content-type"]).toContain("application/pdf");
  expect(pdf.headers()["content-disposition"]).toMatch(/attachment; filename="accessaudit-127\.0\.0\.1-\d{4}-\d{2}-\d{2}\.pdf"/);
  const pdfBytes = await pdf.body();
  expect(pdfBytes.length).toBeGreaterThan(20000);
  expect(pdfBytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");

  const jsonRes = await request.get(`${reportPath}/json`);
  expect(jsonRes.status()).toBe(200);
  expect(jsonRes.headers()["content-disposition"]).toMatch(/accessaudit-127\.0\.0\.1-\d{4}-\d{2}-\d{2}\.json/);
  const json = (await jsonRes.json()) as JsonReport;
  expect(json.version).toBe(1);
  expect(json.url).toBe(siteUrl);
  expect(json.summary.pagesScanned).toBe(5);
  expect(json.summary.pagesFailed).toBe(0);
  expect(json.summary.findingsCount).toBe(json.findings.length);
  expect(json.delta).toBeNull();
  expect(json.manualChecks.length).toBeGreaterThanOrEqual(8);
  const ruleIds = json.findings.map((finding) => finding.ruleId);
  for (const ruleId of FIXTURE_RULES) expect(ruleIds).toContain(ruleId);
  expect(json.findings.map((finding) => finding.rank)).toEqual(json.findings.map((_, i) => i + 1));
  for (const finding of json.findings) {
    expect(["automated", "needs_manual"]).toContain(finding.confidence);
    expect(finding.narrative.ruleId).toBe(finding.ruleId);
    expect(finding.narrative.fixSteps.length).toBeGreaterThan(0);
    expect(finding.affectedUrls.length).toBeGreaterThan(0);
  }

  const csvRes = await request.get(`${reportPath}/csv`);
  expect(csvRes.status()).toBe(200);
  expect(csvRes.headers()["content-disposition"]).toMatch(/accessaudit-127\.0\.0\.1-\d{4}-\d{2}-\d{2}\.csv/);
  const csv = await csvRes.text();
  expect(csv.split("\r\n")[0]).toBe(CSV_HEADER);
  expect(csv).toContain("image-alt");

  const record = await request.get(`${reportPath}/record`);
  expect(record.status()).toBe(200);
  expect(record.headers()["content-type"]).toContain("text/html");
  expect(record.headers()["content-disposition"]).toMatch(/^inline;/);
  const recordHtml = await record.text();
  expect(recordHtml).toContain("Accessibility Remediation Record");
  expect(recordHtml).toContain("This record documents automated testing performed on the dates above.");
  expect(recordHtml).toContain(json.reportId);

  const fragment = await request.get(`${reportPath}/html`);
  expect(fragment.status()).toBe(200);
  const fragmentHtml = await fragment.text();
  expect(fragmentHtml.trimStart().startsWith("<table")).toBe(true);
  expect(fragmentHtml).toContain("image-alt");

  // Screenshots are served only with the report token
  const shotSrc = await report.locator('img[src^="/screenshots/"]').first().getAttribute("src");
  expect(shotSrc).toMatch(new RegExp(`^/screenshots/${json.reportId}/f\\d+\\.png\\?t=${token}$`));
  const shotPath = (shotSrc as string).split("?")[0] as string;
  const shot = await request.get(shotSrc as string);
  expect(shot.status()).toBe(200);
  expect(shot.headers()["content-type"]).toContain("image/png");
  expect((await request.get(shotPath)).status()).toBe(404);
  expect((await request.get(`${shotPath}?t=${"A".repeat(22)}`)).status()).toBe(404);
  expect((await request.get(`/screenshots/${json.reportId}/..%2Freport.pdf?t=${token}`)).status()).toBe(404);

  // Report pages are never indexed
  const reportRes = await request.get(reportPath);
  expect(reportRes.headers()["x-robots-tag"]).toContain("noindex");

  // Outbox has the report-ready email with the report link
  await page.goto("/outbox");
  await page.getByRole("link", { name: "Your accessibility audit is ready" }).first().click();
  await expect(page.getByRole("heading", { level: 2, name: "Your accessibility audit is ready" })).toBeVisible();
  await expect(page.getByText("buyer@example.com").first()).toBeVisible();
  await expect(page.getByRole("link", { name: `http://localhost:3101${reportPath}` })).toBeVisible();

  // Free re-scan -> new report with a Before / after section
  await page.goto(reportPath);
  await page.getByRole("button", { name: "Run the free re-scan" }).click();
  await expect(page).toHaveURL(REPORT_URL_RE);
  const rescanToken = tokenFromReportUrl(page.url());
  expect(rescanToken).toMatch(TOKEN_RE);
  expect(rescanToken).not.toBe(token);
  const rescanPath = `/r/${rescanToken}`;
  await expect(page.locator("p.eyebrow").first()).toContainText("Re-scan");
  await expect(page.getByTestId("report-progress")).toBeVisible();

  const rescanOutcome = await waitForAudit(request, rescanToken);
  expect(rescanOutcome).toMatchObject({ status: "ready", error: null });

  await page.goto(rescanPath);
  await expect(page.locator(".report--web").getByRole("heading", { level: 2, name: /Before \/ after/ })).toBeVisible();
  await expect(page.getByTestId("rescan-card")).toContainText("This is your re-scan");
  await expect(page.getByTestId("rescan-card").getByRole("link", { name: "Open the original report" })).toHaveAttribute("href", reportPath);
  const rescanJson = (await (await request.get(`${rescanPath}/json`)).json()) as JsonReport;
  expect(rescanJson.delta).not.toBeNull();
  const delta = rescanJson.delta as NonNullable<JsonReport["delta"]>;
  expect(delta.originalAuditId).toBe(json.reportId);
  expect(delta.unchanged.length).toBeGreaterThan(0);
  expect(delta.nodesBefore).toBeGreaterThan(0);
  expect(delta.percentFixed).toBeGreaterThanOrEqual(0);
  expect(delta.percentFixed).toBeLessThanOrEqual(100);
  expect(new Date(delta.rescanDate).getTime()).toBeGreaterThanOrEqual(new Date(delta.originalDate).getTime());
  const rescanRecord = await (await request.get(`${rescanPath}/record`)).text();
  expect(rescanRecord).toContain("Re-scan date");
  expect(rescanRecord).toContain("Percent fixed");

  // The original now says the re-scan was used; neither audit can be re-scanned again
  await page.goto(reportPath);
  await expect(page.getByTestId("rescan-card")).toContainText("Re-scan used");
  await expect(page.getByTestId("rescan-card").getByRole("link", { name: /Open the re-scan report/ })).toHaveAttribute("href", rescanPath);
  expect((await request.post(`${reportPath}/rescan`, { maxRedirects: 0 })).status()).toBe(400);
  expect((await request.post(`${rescanPath}/rescan`, { maxRedirects: 0 })).status()).toBe(400);

  // Admin: basic auth, both audits listed, full pipeline log on the detail page
  const anonymous = await request.get("/admin");
  expect(anonymous.status()).toBe(401);
  expect(anonymous.headers()["www-authenticate"]).toBe('Basic realm="admin"');

  const admin = await browser.newContext({ httpCredentials: ADMIN_CREDENTIALS });
  const adminPage = await admin.newPage();
  await adminPage.goto("/admin");
  await expect(adminPage.getByRole("heading", { level: 1 })).toHaveText("Dashboard");
  await expect(adminPage.getByText("payments: mock")).toBeVisible();
  await expect(adminPage.locator("tr", { hasText: "buyer@example.com" })).toContainText("paid");
  await expect(adminPage.locator(`a[href="${reportPath}"]`).first()).toBeVisible();
  await expect(adminPage.locator(`a[href="${rescanPath}"]`).first()).toBeVisible();

  await adminPage.goto(`/admin/audits/${json.reportId}`);
  await expect(adminPage.getByRole("heading", { level: 1 })).toHaveText(siteUrl);
  const log = adminPage.locator("pre.admin-log");
  await expect(log).toContainText("audit started");
  await expect(log).toContainText("robots.txt loaded");
  await expect(log).toContainText("PDF written");
  await expect(log).toContainText("finished: report ready");
  // Emails to the buyer: one for the original report and one for the re-scan.
  await expect(adminPage.getByRole("link", { name: "Your accessibility audit is ready" })).toHaveCount(2);
  await expect(adminPage.getByRole("button", { name: "Re-run" })).toBeEnabled();
  await admin.close();
});

test("an unreachable start URL fails with a plain-English reason and no downloads", async ({ page, request }) => {
  test.setTimeout(300000);
  // A port that was just released: nothing listens there any more.
  const closed = await startFixtureServer();
  const deadUrl = `${closed.url}/`;
  await closed.close();

  const reportPath = await orderAndPay(page, { product: "single", url: deadUrl, email: "offline@example.com" });
  const token = tokenFromReportUrl(reportPath);
  const outcome = await waitForAudit(request, token, 120000);
  expect(outcome.status).toBe("failed");
  expect(outcome.ready).toBe(false);
  expect(outcome.error).toContain(`We couldn't load ${deadUrl}`);

  await page.goto(reportPath);
  const notice = page.getByTestId("failed-notice");
  await expect(notice).toContainText("This audit could not be completed.");
  await expect(notice).toContainText(`We couldn't load ${deadUrl}`);
  await expect(page.getByText("reply to your receipt email for a refund or re-run")).toBeVisible();
  expect(await page.getByRole("link", { name: "Download PDF" }).count()).toBe(0);
  expect((await request.get(`${reportPath}/pdf`)).status()).toBe(404);
  expect((await request.get(`${reportPath}/json`)).status()).toBe(404);
  expect((await request.get(`${reportPath}/record`)).status()).toBe(404);
  expect((await request.post(`${reportPath}/rescan`, { maxRedirects: 0 })).status()).toBe(400);
});

test("a Reviewed Audit is held for a human and released from admin", async ({ page, request, browser }) => {
  test.setTimeout(600000);
  const siteUrl = `${fixture.url}/`;

  const reportPath = await orderAndPay(page, { product: "reviewed", url: siteUrl, email: "reviewed@example.com" });
  const token = tokenFromReportUrl(reportPath);
  await expect(page.getByText(/a person checks your site by hand/)).toBeVisible();

  const outcome = await waitForAudit(request, token);
  expect(outcome).toMatchObject({ status: "held", ready: false, error: null });

  // Held: preview of the automated findings, no downloads yet
  await page.goto(reportPath);
  await expect(page.getByTestId("held-notice")).toContainText("Your Reviewed Audit is being checked by a human.");
  await expect(page.getByRole("heading", { name: "Automated findings (preview)" })).toBeVisible();
  expect(await page.locator("table tbody tr").count()).toBeGreaterThan(0);
  await expect(page.locator("table tbody")).toContainText("image-alt");
  expect(await page.getByRole("link", { name: "Download PDF" }).count()).toBe(0);
  expect((await request.get(`${reportPath}/pdf`)).status()).toBe(404);
  expect((await request.post(`${reportPath}/rescan`, { maxRedirects: 0 })).status()).toBe(400);

  await page.goto("/outbox");
  await expect(page.locator("tr", { hasText: "reviewed@example.com" }).filter({ hasText: "We're reviewing your audit by hand" })).toHaveCount(1);

  // Admin releases it
  const admin = await browser.newContext({ httpCredentials: ADMIN_CREDENTIALS });
  const adminPage = await admin.newPage();
  await adminPage.goto("/admin");
  const row = adminPage.locator("tr", { has: adminPage.locator(`a[href="${reportPath}"]`) });
  await expect(row).toContainText("Needs review");
  await row.locator('a[href^="/admin/audits/"]').click();
  await expect(adminPage.getByRole("heading", { level: 1 })).toHaveText(siteUrl);
  await expect(adminPage.getByText("Needs review").first()).toBeVisible();
  const release = adminPage.getByRole("button", { name: "Release" });
  await expect(release).toBeEnabled();
  await release.click();
  await expect(adminPage.locator(".alert-success")).toContainText("Released.");
  await expect(adminPage.getByRole("button", { name: "Release" })).toBeDisabled();
  await admin.close();

  // Ready for the buyer, with the report-ready email sent
  const released = await waitForAudit(request, token);
  expect(released).toMatchObject({ status: "ready", ready: true });
  await page.goto(reportPath);
  await expect(page.getByRole("link", { name: "Download PDF" })).toBeVisible();
  await expect(page.getByTestId("rescan-card")).toContainText("1 free re-scan available until");
  expect((await request.get(`${reportPath}/pdf`)).status()).toBe(200);
  await page.goto("/outbox");
  await expect(page.locator("tr", { hasText: "reviewed@example.com" }).filter({ hasText: "Your accessibility audit is ready" })).toHaveCount(1);
});
