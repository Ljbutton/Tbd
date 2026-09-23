# Why AccessAudit

This repo started from a single instruction: *make something that can make me money.* The product was chosen by a structured panel rather than by taste. Eight independent proposals were generated, one per angle, and four judges with different lenses scored every proposal on five criteria. This document records the outcome so the reasoning is auditable later.

## The eight candidates

| Product | Angle | Pitch | Pricing | Honest month-3 estimate |
|---|---|---|---|---|
| **Printshot** | dev-tools | A flat-priced hosted API that turns any URL or HTML into a screenshot, PDF, or OG image, for developers whose serverless apps (Vercel/Netlify/Cloudflare) cannot run headless Chrome themselves. | Free: 200 renders/month, API key on signup, no card, 5 req/min. Hobby: $9/month for 2,500 renders (screenshot, PDF, or HTML-to-image each count as 1 render; cache hits are free). | $0-$300/month. Realistic median for a solo person who actually does the launch and forum steps: 3-15 Hobby subscribers plus a couple of $10 top-ups, i.e. |
| **QuestionnaireDraft** | ai-niche | Upload a vendor security questionnaire (XLSX/CSV) plus your company's security profile and policy docs; get every row drafted by Claude with a Yes/No/Partial answer, confidence flag and cited source, exported back into the same spreadsheet, for $39 per… | One-time credits sold via Stripe Checkout (no subscription webhook complexity for MVP). Free: upload a questionnaire and get the first 10 rows drafted with no card, so quality is visible before… | $150-$900/month for a solo person who does the outreach steps (roughly 4-20 paid questionnaires a month at $39, plus an occasional 3-pack or $149 done-for-you… |
| **QuoteBox** | small-business | An embeddable instant-quote calculator for cleaners, pressure washers, lawn care and painters: set your pricing rules once, paste one line on any website, and every visitor gets a price on the spot and lands in your inbox as a lead. | Stripe Checkout subscriptions. Solo: $19/mo or $149/yr (1 quote page, unlimited leads, embed + hosted page, email notifications). | $50-$400/mo (about 3-20 paying customers at $12-19/mo) if the user does 100+ concierge outreach messages and community posts; $0 if they only deploy and wait. |
| **Closeout** | freelancer-creator | A one-link client page for the end of every freelance project: revision rounds are counted in front of the client, extra rounds are paid before they start, and the final files/links unlock only when the balance is paid. | Freemium SaaS billed through Stripe Checkout (subscriptions) plus a Stripe Connect application fee on client payments. | $50-$400/month, most likely around $150: e.g. 8-15 Founding lifetime sales ($79) spread over the first two months plus 5-15 Pro subscribers at $12, and… |
| **Calcfile** | digital-product-store | A no-code builder that generates a self-contained, brandable price-quote / estimate / ROI calculator as a single HTML file plus embed snippet for Squarespace, Wix, Webflow, Shopify or WordPress — bought once ($29), no subscription, no view limits, no "powered… | One-time purchases via Stripe Checkout: (1) Single calculator $29 — includes the generated HTML file, embed snippet, and a permanent order link that lets the buyer edit the config and re-download… | $100–$600/month (roughly 4–20 sales/month, mostly $29 singles with the occasional $99 pack) for a solo person who actually does the forum/Reddit replies and… |
| **CertChase** | boring-b2b | Flat-rate certificate-of-insurance (COI) tracker for small contractors and property managers: upload a vendor's ACORD 25 PDF, it extracts coverages and expiry dates, flags gaps against your minimum requirements, and automatically chases the vendor for… | Subscription via Stripe Checkout, 14-day free trial (no card): Starter $29/mo (up to 50 vendors), Growth $59/mo (up to 200 vendors), Unlimited $99/mo. Annual billing = 10 months ($290/$590/$990). | $0-$500/month (typical outcome for a solo founder who actually does the outreach is 3-10 paying accounts at $29-$59, i.e. roughly $100-$400 MRR; |
| **LocalSteps** | browser-extension | A Chrome/Edge extension that turns a click-through of any web app into a step-by-step guide with numbered, annotated screenshots, entirely on your machine: no account, no cloud upload, free tier plus a $29 one-time Pro license. | Free tier: unlimited recordings, up to 12 steps per guide, 5 saved guides, Markdown and HTML export with a small "Made with LocalSteps" footer. | $100-$800/month (roughly 4-28 Pro sales per month at $29, occasionally a $99 team pack). |
| **AccessAudit** | productized-service | Paste a URL, pay $49, and get a plain-English WCAG accessibility audit PDF of your whole site (up to 15 pages, desktop + mobile) in about 10 minutes, with issues ranked by lawsuit risk and copy-paste code fixes. | One-time purchases via Stripe Checkout Sessions, no subscription in the MVP. (a) Single Site Audit: $49 - crawl up to 15 same-origin pages at desktop and mobile viewports, PDF + JSON report, one free… | $150 - $1,200 per month. Realistic median for a solo founder who actually runs the Fiverr gig, the freelancer outreach and the forum replies is roughly… |

## Scores

Each judge scored 1-10 on five criteria (max total 50). Judges: a serial indie hacker, a staff engineer judging one-session buildability, a zero-audience growth marketer, and a skeptical buyer with a credit card.

| Product | Revenue realism | Buildability | Low setup burden | Differentiation | First-dollar path | Avg total | Judge wins |
|---|---|---|---|---|---|---|---|
| AccessAudit | 6.5 | 7.8 | 6.8 | 5.8 | 7.8 | 34.5 | 3 |
| QuestionnaireDraft | 6.0 | 6.8 | 6.0 | 6.2 | 7.0 | 32.0 | 1 |
| Calcfile | 4.0 | 8.8 | 8.8 | 3.5 | 5.8 | 30.8 | 0 |
| QuoteBox | 4.0 | 7.8 | 7.8 | 4.8 | 6.2 | 30.5 | 0 |
| CertChase | 5.0 | 4.8 | 4.0 | 3.8 | 5.0 | 22.5 | 0 |
| LocalSteps | 4.2 | 4.2 | 4.5 | 5.5 | 4.5 | 23.0 | 0 |
| Printshot | 3.0 | 7.0 | 6.0 | 2.2 | 4.5 | 22.8 | 0 |
| Closeout | 3.0 | 4.8 | 4.5 | 4.0 | 4.2 | 20.5 | 0 |

## Why AccessAudit won

- **The buyer already exists and already pays.** Fiverr and Upwork list "website accessibility audit" gigs at $30-150 today, so the first sale does not depend on an audience, SEO, or a launch landing. The tool turns a 10-minute automated run into a fulfilled order.
- **Demand is documented and fear-driven.** 4,928 ADA web-accessibility lawsuits were filed in the US in 2025 (up 37% year over year), roughly 70% against e-commerce sites, and demand letters typically settle for $5,000-15,000. The FTC's $1M order against accessiBe discredited overlay widgets, which is the product's main low-cost competitor.
- **Two personas, two prices.** Store owners holding a demand letter buy the $49 audit for a written fix list. Freelance designers and small agencies buy the $149 white-label 5-Pack as a sales tool for $500-2,000 remediation projects.
- **It is fully buildable and testable offline.** Playwright, axe-core, SQLite and Stripe Checkout are all in the toolchain; without an Anthropic key the report still ships complete, backed by a hand-written plain-English rule dictionary. The mock mode produces the real product, not filler.

## The risks the judges flagged, and what the build does about them

| Risk | Mitigation built in |
|---|---|
| A buyer who knows WAVE and Lighthouse are free, and that automated checks find only 30-40% of WCAG issues, will not pay for a reformatted axe dump | Whole-site crawl at two viewports, lawsuit-risk ranking, before/after code fixes built from the site's own markup, a client-ready PDF, a dated remediation record, and a free re-scan with a delta. Every finding is flagged `automated` or `needs manual check`. |
| One careless sentence about "compliance" recreates the FTC problem that sank the overlay vendors | The word appears only inside the fixed disclaimer. Every report, pricing card and email says it is an automated audit plus a manual checklist, not a certification or legal advice. |
| New Fiverr sellers rank slowly | The playbook runs concierge outreach (free scan, then a personal email with the top 3 issues), community replies to demand-letter threads, and directory listings in parallel from day 1. |
| Headless Chromium memory on a cheap host | One audit at a time, hard page cap, per-page and per-audit timeouts, the browser is closed after every audit. Deploys to a Playwright Docker image on Fly.io for roughly $3-5/month. |
| Crawling arbitrary URLs is an SSRF vector | DNS-resolved private-IP blocklist on every user-supplied URL and on every request the browser makes. |

## Ideas grafted from the losing proposals

- Redeemable license codes for the Agency 5-Pack instead of accounts (from the calculator proposal).
- The $199 human-reviewed tier and the per-finding confidence flag (from the questionnaire-drafting proposal).
- SSRF guard, route-level request blocking, per-IP rate limits and the `npm run stripe:setup` script (from the screenshot-API proposal).
- Six SEO landing pages generated from JSON, each with the free scanner embedded (from the calculator proposal).
- The dated remediation record framed as evidence of good-faith effort, and the referral-partner angle (from the certificate-monitoring proposal).
- The dev outbox page that shows every email the app would have sent (from the closeout proposal).

## Runners-up worth revisiting

- **QuestionnaireDraft**: Upload a vendor security questionnaire (XLSX/CSV) plus your company's security profile and policy docs; get every row drafted by Claude with a Yes/No/Partial answer, confidence flag and cited source, exported back into the same spreadsheet, for $39 per questionnaire instead of a $5k-80k/yr complianc
- **Calcfile**: A no-code builder that generates a self-contained, brandable price-quote / estimate / ROI calculator as a single HTML file plus embed snippet for Squarespace, Wix, Webflow, Shopify or WordPress — bought once ($29), no subscription, no view limits, no "powered by" badge.
- **QuoteBox**: An embeddable instant-quote calculator for cleaners, pressure washers, lawn care and painters: set your pricing rules once, paste one line on any website, and every visitor gets a price on the spot and lands in your inbox as a lead.
