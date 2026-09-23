# AccessAudit

AccessAudit sells whole-site automated WCAG audits as a one-time purchase. A buyer pastes a URL, pays, and about ten minutes later has a permanent report page with a branded PDF, JSON/CSV exports, a dated remediation record and one free re-scan. Free single-page teaser scans feed the funnel. Automated checks find roughly 30-40% of WCAG issues. This is an automated audit plus a manual checklist, not a legal opinion or a compliance certification.

## Run locally in 2 commands

```bash
npm install
npm run dev
```

Open http://localhost:3000. With no `.env` file everything runs in test mode: checkout is simulated (no card is charged), narratives come from the built-in dictionary, and emails land in the local outbox at `/outbox`.
