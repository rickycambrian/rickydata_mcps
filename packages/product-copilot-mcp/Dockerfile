FROM node:20-slim AS build
WORKDIR /app
COPY package*.json ./
COPY tsconfig.base.json ./
COPY packages/product-copilot-mcp/package*.json ./packages/product-copilot-mcp/
RUN npm ci --workspace @rickydata/product-copilot-mcp --include-workspace-root --no-audit --no-fund
COPY packages/product-copilot-mcp ./packages/product-copilot-mcp
RUN npm run build --workspace @rickydata/product-copilot-mcp

FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV TRANSPORT=http
ENV PORT=8080
COPY --from=build /app ./
EXPOSE 8080
CMD ["node", "packages/product-copilot-mcp/dist/index.js"]
