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
RUN ALLOW_PRIVATE_TARGETS=1 DATA_DIR=/tmp/sample-data npm run sample
ENV DATA_DIR=/data PORT=3000
EXPOSE 3000
CMD ["npm", "start"]
