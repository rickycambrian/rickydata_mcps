# @rickydata/product-copilot-mcp

Private-only MCP for **rickydata Product Copilot** roadmap, release-readiness, screenshot gates, and human-in-loop priority review data.

This MCP is the product-specific complement to the local/admin KFDB tooling. It is intentionally narrow, but it is not a public/shared feed: every runtime must be mounted behind RickyData Gateway or another private operator surface that injects the active wallet's sign-to-derive material. Missing wallet-derived headers fail closed instead of falling back to embedded/public data.

## Tools

| Tool | Purpose |
|---|---|
| `list_priority_items` | Read top HIL roadmap/feed items from the Product Copilot PM feed. |
| `get_priority_item` | Fetch one item by repo + issue number or URL. |
| `get_release_readiness` | Summarize Product Copilot release readiness, blockers, and source/public repo pairing. |
| `get_quality_gates` | Return the required tests, screenshot proof, changelog, leak gate, and HIL approval gates. |
| `get_top_priority_item` | Return the highest-priority item for a scope, with explanation. |
| `get_mom_test_evidence_gaps` | Group missing Mom Test / discovery evidence by evidence type. |
| `get_human_approval_blockers` | List items that need human review, evidence, or approval before automation/release work proceeds. |

## Data source

Required private configuration:

| Env var | Purpose |
|---|---|
| `PRODUCT_COPILOT_PM_REPORT_URL` or `PRODUCT_COPILOT_PM_REPORT_PATH` | Private HIL feed source. No embedded/public fallback exists. |
| `PRODUCT_COPILOT_WALLET_ADDRESS` or `RICKYDATA_KFDB_WALLET_ADDRESS` | Active wallet owner for the private tenant. |
| `PRODUCT_COPILOT_KFDB_DERIVE_SESSION_ID` or `RICKYDATA_KFDB_DERIVE_SESSION_ID` | Active sign-to-derive session id. |
| `PRODUCT_COPILOT_KFDB_DERIVE_KEY` or `RICKYDATA_KFDB_DERIVE_KEY` | Active wallet-derived key. |
| `PRODUCT_COPILOT_PM_REPORT_BEARER_TOKEN` / `RICKYDATA_KFDB_API_KEY` / `KFDB_API_KEY` | Optional service bearer for the private feed endpoint. |

The URL fetch path sends `X-Wallet-Address`, `X-Derive-Session-Id`, and `X-Derive-Key` headers. If the source or derive material is missing, the MCP refuses to start/read rather than serving shared data.

## Usage

```bash
npx -y @rickydata/product-copilot-mcp
```

Hermes/Claude Desktop style config must be supplied by a private operator/gateway context. Do not put raw values in checked-in config:

```json
{
  "mcpServers": {
    "product-copilot": {
      "command": "npx",
      "args": ["-y", "@rickydata/product-copilot-mcp"],
      "env": {
        "PRODUCT_COPILOT_PM_REPORT_URL": "https://<private-deployment>/api/roadmap/hil-feed",
        "PRODUCT_COPILOT_WALLET_ADDRESS": "${RICKYDATA_KFDB_WALLET_ADDRESS}",
        "PRODUCT_COPILOT_KFDB_DERIVE_SESSION_ID": "${RICKYDATA_KFDB_DERIVE_SESSION_ID}",
        "PRODUCT_COPILOT_KFDB_DERIVE_KEY": "${RICKYDATA_KFDB_DERIVE_KEY}"
      }
    }
  }
}
```

## Auth model

The MCP itself does not use an admin KFDB-only path or a shared embedded feed. Production calls must be routed through RickyData Gateway or a private operator surface that injects the active wallet and sign-to-derive session for the same private tenant used by `rickydata_notes`. This preserves cross-system graph joins across notes, rickydata_git, Hermes sessions, Product Copilot, and Sales Coach without leaking the graph into a public/shared keyspace.

## Development

```bash
npm install
npm run build --workspace @rickydata/product-copilot-mcp
npm run test  --workspace @rickydata/product-copilot-mcp
```
