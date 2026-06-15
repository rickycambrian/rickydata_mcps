# Two-stage build. Runtime is pure `fetch` — Playwright is a dev-only dependency
# (connect + capture helpers) and is NEVER installed in the final image. The
# tsconfig excludes src/dev, so the compiled dist contains no Playwright imports.
FROM node:20-alpine AS builder
WORKDIR /app
# Skip Playwright's browser download in CI/Docker — we only need tsc here.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package*.json tsconfig.json ./
RUN npm install
COPY src ./src
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
# --omit=dev drops Playwright (and all dev tooling) from the production image.
RUN npm install --omit=dev
COPY --from=builder /app/dist ./dist

ENV NODE_ENV=production
ENV TRANSPORT=http
ENV PORT=8080

RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001
USER nodejs

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:8080/health', (r) => {r.statusCode === 200 ? process.exit(0) : process.exit(1)})"

CMD ["node", "dist/index.js"]
