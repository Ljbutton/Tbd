# AccessAudit: Express + Playwright on the official Playwright image, which ships
# the Chromium build that playwright@1.56.1 expects (no browser download).
FROM mcr.microsoft.com/playwright:v1.56.1-noble
WORKDIR /app
ENV NODE_ENV=production PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package*.json ./
# tsx and typescript live in "dependencies" because TypeScript runs directly in
# production, so devDependencies (types, vitest, @playwright/test) can be left out.
RUN npm ci --omit=dev
COPY . .
# Renders public/sample-report.pdf from the bundled fixture site (the landing page embeds it).
# BASE_URL is the address the PDF's "Scanned with AccessAudit" link points at; pass it with
# `--build-arg BASE_URL=https://<your domain>` (Render passes service env vars as build args).
# Left empty, scripts/sample.ts falls back to a placeholder domain.
ARG BASE_URL
RUN ALLOW_PRIVATE_TARGETS=1 DATA_DIR=/tmp/sample-data BASE_URL="$BASE_URL" npm run sample
ENV DATA_DIR=/data PORT=3000
EXPOSE 3000
# Run node directly (not `npm start`) so SIGTERM reaches the server and its graceful
# shutdown runs; npm would exit on the signal and leave node to be SIGKILLed.
# NODE_ENV=production is set above; .env is excluded by .dockerignore.
CMD ["node", "--env-file-if-exists=.env", "--import", "tsx", "src/server.ts"]
