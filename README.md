# AccessAudit

AccessAudit sells whole-site automated WCAG audits as a one-time purchase. A buyer pastes a URL, pays, and about ten minutes later has a permanent report page with a branded PDF, JSON/CSV exports, a dated remediation record and one free re-scan. Free single-page teaser scans feed the funnel; agencies buy a 5-Pack of white-label audits. Automated checks find roughly 30-40% of WCAG issues. This is an automated audit plus a manual checklist, not a legal opinion or a compliance certification.

## Run locally in 2 commands

```bash
npm install
npm run dev
```

Open http://localhost:3000. With no `.env` file everything runs in test mode: checkout is simulated (no card is charged), narratives come from the built-in rule dictionary, and emails land in the local outbox at `/outbox`. The whole product works this way; the keys below only swap the mocked pieces for the real services.

To try a full audit against the bundled demo store (private addresses are blocked by default, so the flag is needed):

```bash
npx tsx fixtures/serve.ts 4100          # Northwind Candles, a fixture store with seeded issues
ALLOW_PRIVATE_TARGETS=1 npm run dev     # then order an audit of http://127.0.0.1:4100/
```

## Modes

The three integrations are independent. The server prints one line per mode at startup (`payments: mock|stripe`, `llm: mock|<model>`, `email: outbox|resend`) and `/healthz` reports the same flags.

| Key set | What changes |
|---|---|
| none | `payments: mock`, `llm: mock`, `email: outbox`. Checkout goes to `/mock/checkout/:orderId`, narratives come from the rule dictionary, emails are stored in the `emails_outbox` table and shown at `/outbox`. The footer shows a TEST MODE chip. |
| `STRIPE_SECRET_KEY` + price ids | Real Stripe Checkout. `/success` confirms the payment by retrieving the Checkout Session, so orders complete even before the webhook arrives; the webhook (`/api/stripe/webhook`) is the backup and handles refunds. |
| `ANTHROPIC_API_KEY` | Claude (`ANTHROPIC_MODEL`, default `claude-opus-5`) writes the plain-English narrative. Any failure falls back to the dictionary silently for the buyer and is logged in the audit log for the admin. Free teaser scans never call Claude. |
| `RESEND_API_KEY` | Emails are sent through Resend from `EMAIL_FROM`; `/outbox` answers 404. A Resend failure is logged and the message is kept as an outbox row. |
| `ADMIN_PASSWORD` | Required in production (`/admin` answers 503 until it is set). Outside production `/admin` accepts `admin` / `admin`. |

## Environment variables

Copy `.env.example` to `.env`; `npm run dev` and `npm start` load it when it exists, and the app also runs with no `.env` at all.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `BASE_URL` | `http://localhost:$PORT` | Public URL used in emails, Stripe redirects, the sitemap, the embed snippet and the "Scanned with" link in reports |
| `DATA_DIR` | `./data` | SQLite database (`app.db`), reports and screenshots (`audits/<id>/`), uploaded logos (`logos/`) |
| `NODE_ENV` | `development` | `production` enables template caching and requires `ADMIN_PASSWORD` |
| `STRIPE_SECRET_KEY` | unset | Stripe secret key; unset means mock payments |
| `STRIPE_WEBHOOK_SECRET` | unset | Signing secret for `/api/stripe/webhook` |
| `STRIPE_PRICE_SINGLE`, `STRIPE_PRICE_REVIEWED`, `STRIPE_PRICE_PACK5` | unset | Price ids printed by `npm run stripe:setup` |
| `STRIPE_COUPON_FOUNDING` | unset | Coupon id for FOUNDING50 (also printed by the setup script) |
| `ANTHROPIC_API_KEY` | unset | Enables Claude narratives |
| `ANTHROPIC_MODEL` | `claude-opus-5` | Model id for narratives |
| `RESEND_API_KEY` | unset | Enables outbound email |
| `EMAIL_FROM` | `AccessAudit <reports@example.com>` | From address (domain verified in Resend) |
| `ADMIN_PASSWORD` | `admin` outside production | Basic-auth password for `/admin` (user `admin`) |
| `ALLOW_PRIVATE_TARGETS` | `0` | `1` lets the scanner reach loopback/private addresses (fixtures and tests only; never in production) |
| `PAGE_LIMIT_SINGLE` | `15` | Page cap for Site Audit and Reviewed Audit |
| `PAGE_LIMIT_PACK` | `30` | Page cap per site for Agency 5-Pack audits |
| `AUDIT_TIMEOUT_MS` | `720000` | Hard limit for one audit (12 minutes) |
| `TEASER_RATE_LIMIT` | `5` | Free teaser scans per IP per hour |

## Stripe setup

1. Put a **test** secret key in `.env` (`STRIPE_SECRET_KEY=sk_test_...`).
2. Run `npm run stripe:setup`. It creates the three products with one-time USD prices ($49 Site Audit, $199 Reviewed Audit, $149 Agency 5-Pack), the `FOUNDING50` coupon ($50 off, 20 redemptions) and its promotion code, and prints four lines to paste into `.env`:
   `STRIPE_PRICE_SINGLE=...`, `STRIPE_PRICE_REVIEWED=...`, `STRIPE_PRICE_PACK5=...`, `STRIPE_COUPON_FOUNDING=...`. The script is idempotent: it looks up existing products by name first.
3. Forward webhooks locally: `stripe listen --forward-to localhost:3000/api/stripe/webhook`, then copy the printed `whsec_...` into `STRIPE_WEBHOOK_SECRET`.
4. Restart the server and order an audit. `POST /order` now redirects to a real `checkout.stripe.com` page. Pay with the test card `4242 4242 4242 4242`, any future expiry, any CVC. The success page confirms the payment by retrieving the Checkout Session, so the audit starts even if the webhook is late or missing.
5. `stripe trigger checkout.session.completed` sends an event without our metadata; the handler logs `no order_id in metadata, ignoring` and returns 200, which is the expected result.
6. Going live: swap in the **live** secret key, run `npm run stripe:setup` once more against the live account and paste the new ids, then add a webhook endpoint in the Stripe dashboard for `https://<your domain>/api/stripe/webhook` with the events `checkout.session.completed`, `checkout.session.async_payment_succeeded` and `charge.refunded`, and set its signing secret as `STRIPE_WEBHOOK_SECRET`.

Refunds issued in the Stripe dashboard mark the order `refunded`; the audit and report stay available. If a price id is missing while a Stripe key is set, `POST /order` shows "Stripe is configured but STRIPE_PRICE_X is missing; run npm run stripe:setup".

## Anthropic setup

Set `ANTHROPIC_API_KEY` (and optionally `ANTHROPIC_MODEL`). Narratives are requested with structured output (`messages.parse` with a zod schema), a 120-second timeout and a copy guard: if the model's text claims that a site meets a standard or is protected from lawsuits, or uses the restricted wording anywhere outside the one permitted disclaimer phrase, the response is discarded and the dictionary narrative is used. The audit log records `narrative: claude ok (...)` or `narrative: claude failed (<reason>), using dictionary`. Findings beyond the top 25 always use dictionary entries, and free teaser scans never call Claude.

## Resend setup

Verify your sending domain in Resend, set `RESEND_API_KEY` and `EMAIL_FROM` (for example `AccessAudit <reports@yourdomain.com>`). Four emails exist: report ready, in review (Reviewed Audit), Agency 5-Pack code, and the re-scan reminder sent 25 days after purchase when the free re-scan is unused. Email failures never fail an audit: the message is kept as an outbox row and the audit log says so.

## Admin

- `/admin`: basic auth, user `admin`, password `ADMIN_PASSWORD` (defaults to `admin` outside production; in production the page answers 503 until the variable is set). Shows which keys are missing, the queue, 30-day funnel counters (`teaser_scan`, `checkout_start`, `paid`, `report_ready`, `rescan`), the last 100 orders and audits, and highlights held audits with "Needs review".
- `/admin/audits/:id`: status, timing, the full pipeline log, pages, findings, the narrative editor and the emails sent to the buyer.
  - **Re-run** clears pages, findings, narrative and files and queues the audit again (refused while a job for it is running or already queued).
  - **Save narrative** validates the JSON against the narrative schema, stores it and rebuilds the PDF, JSON and CSV synchronously ("Saved and re-rendered").
  - **Release** turns a held Reviewed Audit into a ready one and sends the report-ready email. Edit and save the narrative first; Release does not re-render.
- **Mark paid** on a pending order (bank transfer, Fiverr, invoice) does exactly what a Stripe payment does: creates the audit or the 5-Pack code and sends the email.
- `/outbox`: only when no `RESEND_API_KEY` is set. Open in development, basic auth in production. Lists the last 50 emails and shows each in a sandboxed frame with its links.

## Tests

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest unit tests (SSRF, URLs, robots, ranking, delta, narrative, exports, email, orders, credits, runner, report routes)
npm run test:e2e    # Playwright end-to-end run against a fresh server on port 3101 with the fixture site
```

The end-to-end run wipes `.e2e-data` before the server starts and strips every third-party key (`E2E=1`), so it never touches Stripe, Anthropic or Resend. `tests/e2e/audit-flow.spec.ts` covers the landing page, the free scan, a Site Audit from order to ready report with all exports, the free re-scan with its before/after section, a failed audit, a Reviewed Audit released from admin, and the admin pages. `tests/e2e/pack-flow.spec.ts` covers the Agency 5-Pack with a logo and FOUNDING50, the code email, redeeming a credit for a white-label audit, form validation, a cancelled checkout and Mark paid. A full run takes about five minutes because it runs real audits.

## Sample PDF

`npm run sample` starts the fixture site, creates a synthetic audit (six pages, token `sample`) in a temporary data directory, forces the dictionary narrative, runs the real pipeline and writes `public/sample-report.pdf`, then exits. It finishes in well under three minutes. The landing page embeds that file as "See a real report"; until it exists, `/sample-report.pdf` answers 404 with "Run npm run sample". The Dockerfile runs it at build time. Set `BASE_URL` when running it so the "Scanned with AccessAudit" link in the PDF points at your real address.

## Deploy

The `Dockerfile` builds on `mcr.microsoft.com/playwright:v1.56.1-noble`, which ships the exact Chromium that `playwright@1.56.1` expects, so no browser is downloaded. `tsx` and `typescript` are regular dependencies because TypeScript runs directly in production, so the image installs with `npm ci --omit=dev`. `.dockerignore` keeps `node_modules`, data directories and `.env` out of the build context.

### Fly.io

```bash
fly launch --no-deploy --copy-config            # keeps the bundled fly.toml
fly volumes create accessaudit_data --size 3 --region iad
fly secrets set ADMIN_PASSWORD=change-me BASE_URL=https://accessaudit.fly.dev
# optional: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_*, STRIPE_COUPON_FOUNDING, ANTHROPIC_API_KEY, RESEND_API_KEY, EMAIL_FROM
fly deploy
curl https://accessaudit.fly.dev/healthz        # mockPayments should be false once Stripe is configured
```

`fly.toml` mounts the volume at `/data`, keeps exactly one machine running (the queue and the database are in-process) and checks `/healthz`. A 2 GB machine comfortably runs one audit at a time.

### Render

`render.yaml` describes a Docker web service with `/healthz` as the health check. The free plan has no persistent disk, so every restart loses the database and reports; use a paid plan and uncomment the `disk` block for real use. Set `BASE_URL`, `ADMIN_PASSWORD` and the optional keys in the dashboard (they are declared with `sync: false`).

## Operations

- **Backups**: copy `$DATA_DIR/app.db` (plus `app.db-wal` if present) and `$DATA_DIR/audits`. Uploaded logos live in `$DATA_DIR/logos`.
- **Failed audits**: open the audit in `/admin`, read the log, fix the cause (usually an unreachable start URL) and click Re-run. Buyers see "reply to your receipt email for a refund or re-run" on the report page.
- **Restarts**: a job interrupted by a restart is queued again on boot; one interrupted twice is marked failed with the error `crashed twice`. A graceful shutdown (SIGTERM) stops picking up new jobs first.
- **Memory**: one audit runs at a time, pages are scanned one browser context at a time, each page scan is capped at 45 seconds, the crawl at 3 minutes, the screenshot phase at 2 minutes and the whole audit at `AUDIT_TIMEOUT_MS`. The shared Chromium is closed after every audit.
- **Health**: `/healthz` returns the modes, whether Chromium is running and the queue depth.
- **Logs**: the server prints one line per email (`EMAIL (outbox|resend) to=... subject=...`) and per failed audit; each audit keeps its own timestamped log in the database, shown on its admin page.
- **Reminders**: once an hour the runner emails buyers whose free re-scan is still unused 25 days after purchase.

## Launch playbook

1. Day 0 (2 hours): deploy to Fly.io, run npm run stripe:setup with LIVE keys, set secrets, register the webhook, verify /healthz shows mockPayments=false. Buy a $49 Site Audit of your own site with a real card, watch the job finish, download the PDF, then refund yourself in the Stripe dashboard. This proves the whole path.
2. Day 0: run the free scan on 5 well-known Shopify stores and 5 designer portfolios; keep the two most impressive PDFs as sales samples. Record a 40-second screen capture: paste URL -> teaser -> pay -> report page filling in -> PDF.
3. Day 1: create a Fiverr gig "I will audit your website for WCAG 2.2 AA accessibility and deliver a prioritized fix report" (Basic $49: 15-page automated report; Standard $99: + re-scan and 15-minute call; Premium $199: reviewed audit with manual keyboard/screen-reader checks). Create the same as an Upwork project catalog listing. Fulfil each order with the tool in 10 minutes plus a hand read of the narrative. New sellers rank slowly, so run the next steps in parallel.
4. Day 1-2: submit AccessAudit to AlternativeTo, SaaSHub, Capterra and G2 as an accessiBe / UserWay / WAVE alternative ("not an overlay"), and to Uneed and BetaList. Link the free scanner.
5. Week 1 (concierge outreach, 30 min/day): each day pick 10 small e-commerce sites or freelance designers. Run the free scan, email the owner or listed designer their top 3 real issues with a screenshot, one sentence on the 2025 lawsuit wave, and the $49 link (or the $149 5-Pack for designers). 50 emails/week; expect 1-3 sales.
6. Week 1-2: reply in r/shopify, Shopify Community, r/smallbusiness, r/Entrepreneur and r/web_design threads about ADA demand letters or "is my site accessible" with genuinely useful guidance and the free scan link. Follow each community's self-promotion rules.
7. Week 2: Show HN and Product Hunt launch of the FREE single-page scanner, with the sample PDF. Mention FOUNDING50 once for agencies.
8. Week 2-4: the 6 SEO pages are live from day 0; add two long-form pages: "ADA website demand letter: what to do in the first 7 days" and "Shopify accessibility audit: what the free tools miss". Submit the sitemap to Google Search Console.
9. Ongoing: every paid buyer gets a testimonial ask in the report-ready email and the day-25 re-scan reminder; agencies who used all 5 credits get a one-line offer for another pack. Recruit 5 referral partners (Shopify/WordPress freelancers, hosting resellers) with a free 5-Pack in exchange for referrals.
10. Month 2: once 10 single audits or 3 packs have sold, add the $29/mo monthly re-scan monitoring (Stripe subscription + cron re-run of existing audits) as the recurring upsell.

## Legal notes

AccessAudit is an automated testing tool. It is not a law firm and does not provide legal advice. Reports document automated checks plus a manual checklist; they are not a legal opinion and they do not protect anyone from claims. Automated checks find roughly 30-40% of WCAG issues. This is an automated audit plus a manual checklist, not a legal opinion or a compliance certification. Refunds: a full refund within 7 days if the report is unusable; reply to the receipt email. The terms and privacy pages live at `/legal/terms` and `/legal/privacy`.

## License

MIT. See [LICENSE](LICENSE).
