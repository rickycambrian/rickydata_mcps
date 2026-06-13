# @rickydata/product-copilot-mcp

Private-only MCP for **rickydata Product Copilot** roadmap, release-readiness, screenshot gates, and human-in-loop priority review data.

This MCP is the product-specific complement to local/admin KFDB tooling. It is intentionally narrow, but it is not a public/shared feed: production runtimes must be mounted behind RickyData Gateway or another private operator surface that injects the active logged-in wallet context. Missing wallet context fails closed instead of falling back to embedded/public data.

## Tools

| Tool | Purpose |
|---|---|
| `setup_private_product_copilot` | Idempotently initialize/verify the active wallet private tenant schema. Safe to rerun; creates deterministic merge records only if missing. |
| `list_priority_items` | Read top HIL roadmap/feed items from the Product Copilot PM feed. |
| `get_priority_item` | Fetch one item by repo + issue number or URL. |
| `get_release_readiness` | Summarize Product Copilot release readiness, blockers, and source/public repo pairing. |
| `get_quality_gates` | Return the required tests, screenshot proof, changelog, leak gate, and HIL approval gates. |
| `get_top_priority_item` | Return the highest-priority item for a scope, with explanation. |
| `get_mom_test_evidence_gaps` | Group missing Mom Test / discovery evidence by evidence type. |
| `get_human_approval_blockers` | List items that need human review, evidence, or approval before automation/release work proceeds. |

## Auth and data source model

The logged-in wallet is the auth boundary. Product Copilot does **not** require users to store `PRODUCT_COPILOT_KFDB_API_KEY`, derive keys, or Product Copilot env vars through `/api/secrets`.

Runtime context is split into two layers:

| Layer | Examples | Owner |
|---|---|---|
| Platform wallet context | `RICKYDATA_AUTH_WALLET_ADDRESS`, `PRODUCT_COPILOT_WALLET_ADDRESS`, optional `RICKYDATA_AUTH_TOKEN` | RickyData Gateway, derived from the authenticated wallet/session |
| Operator feed/config | `PRODUCT_COPILOT_PM_REPORT_URL`, optional `PRODUCT_COPILOT_PM_REPORT_PATH`, `RICKYDATA_KFDB_URL` | RickyData deployment/operator config |

The URL fetch path sends `X-Wallet-Address` and, when available, an auth token supplied by the gateway. If the source or wallet context is missing, read tools return structured setup guidance instead of throwing a generic MCP internal error.

`setup_private_product_copilot` plans/writes deterministic `mode: "merge"` KFDB operations for `WalletTenant`, `AppSchemaVersion`, and `SchemaBootstrap`, so rerunning it after the schema already exists is safe. If wallet-auth KFDB write capability is not exposed to the runtime yet, the setup tool returns `wallet_auth_write_unavailable` with the planned idempotent operations rather than requesting an API key.

## Usage

```bash
npx -y @rickydata/product-copilot-mcp
```

Gateway-style config should inject wallet context automatically. A local/operator-only development example can use:

```json
{
  "mcpServers": {
    "product-copilot": {
      "command": "npx",
      "args": ["-y", "@rickydata/product-copilot-mcp"],
      "env": {
        "PRODUCT_COPILOT_PM_REPORT_URL": "https://<private-deployment>/api/roadmap/hil-feed",
        "PRODUCT_COPILOT_WALLET_ADDRESS": "${RICKYDATA_AUTH_WALLET_ADDRESS}"
      }
    }
  }
}
```

Do not commit real wallet tokens, bearer tokens, API keys, derive keys, or private feed URLs.

## Development

```bash
npm install
npm run build --workspace @rickydata/product-copilot-mcp
npm run test  --workspace @rickydata/product-copilot-mcp
```
