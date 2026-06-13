# @rickydata/product-copilot-mcp

Read-only MCP for **rickydata Product Copilot** roadmap, release-readiness, screenshot gates, and human-in-loop priority review data.

This is the public-consumer-facing complement to the local/admin KFDB MCP tooling. The admin `kfdb-rickydata` MCP can write/query broad KFDB surfaces with privileged API-key context. This package is intentionally narrower: it exposes product-specific, review-safe tools that can be mounted behind RickyData Gateway sign-to-derive / wallet-token auth for normal users.

## Tools

| Tool | Purpose |
|---|---|
| `list_priority_items` | Read top HIL roadmap/feed items from the Product Copilot PM feed. |
| `get_priority_item` | Fetch one item by repo + issue number or URL. |
| `get_release_readiness` | Summarize Product Copilot release readiness, blockers, and source/public repo pairing. |
| `get_quality_gates` | Return the required tests, screenshot proof, changelog, leak gate, and HIL approval gates. |

## Data source

Set exactly one of:

| Env var | Purpose |
|---|---|
| `PRODUCT_COPILOT_PM_REPORT_PATH` | Local/internal path to `human-in-loop-roadmap-feed.json`. |
| `PRODUCT_COPILOT_PM_REPORT_URL` | Public/API URL returning the same JSON shape. |

If neither is set, local development falls back to Ricky's internal default path under `/root/projects/rickycambrian/rickydata_sales_coach` when present.

## Usage

```bash
npx -y @rickydata/product-copilot-mcp
```

Hermes/Claude Desktop style config:

```json
{
  "mcpServers": {
    "product-copilot": {
      "command": "npx",
      "args": ["-y", "@rickydata/product-copilot-mcp"],
      "env": {
        "PRODUCT_COPILOT_PM_REPORT_URL": "https://<deployment>/api/roadmap/hil-feed"
      }
    }
  }
}
```

## Auth model

The MCP itself does not require an admin KFDB API key. In production it should run behind the RickyData MCP Gateway. The website/user flow should authenticate with wallet sign-to-derive or a gateway wallet token (`mcpwt_...`), then the gateway can route calls to this server with user-scoped context.

## Development

```bash
npm install
npm run build --workspace @rickydata/product-copilot-mcp
npm run test  --workspace @rickydata/product-copilot-mcp
```
