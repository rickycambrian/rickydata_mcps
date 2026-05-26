---
name: cfa-capstone-mcps
description: Use when building or validating the CFA capstone MCP servers for SEC, official macro, tradfi market data, Hyperliquid tradfi microstructure, and evidence bundles.
allowed-tools: Bash(npm:*), Bash(node:*)
---

# CFA Capstone MCPs

## Purpose

Validate the local MCP servers that support the Ricky CFA capstone research stack:

- `rickydata-sec-edgar-mcp`
- `rickydata-official-macro-mcp`
- `rickydata-tradfi-market-data-mcp`
- `rickydata-hyperliquid-tradfi-microstructure-mcp`
- `rickydata-capstone-evidence-mcp`

## Verified

2026-05-26 from `/Users/riccardoesclapon/Documents/github/rickydata_mcps`.

## Setup / Prerequisites

- Node.js `v22.9.0` and npm `10.8.3` were used during verification.
- Local ClickHouse container `hyperliquid-clickhouse` was running for Hyperliquid local smoke tests.
- Set an identifiable SEC user agent for live SEC smoke tests:

```bash
export SEC_USER_AGENT="rickydata_mcps local research contact@rickydata.org"
```

Optional provider keys:

```bash
export FRED_API_KEY=...
export EIA_API_KEY=...
export FMP_API_KEY=...
export ALPHAVANTAGE_API_KEY=...
export POLYGON_API_KEY=...
```

## Commands

Install/update workspace dependencies:

```bash
npm install
```

Observed result: install completed, adding the five new workspaces to `package-lock.json`.

Run package-local tests:

```bash
npm run test --workspace rickydata-sec-edgar-mcp
npm run test --workspace rickydata-official-macro-mcp
npm run test --workspace rickydata-tradfi-market-data-mcp
npm run test --workspace rickydata-hyperliquid-tradfi-microstructure-mcp
npm run test --workspace rickydata-capstone-evidence-mcp
```

Observed result:

```text
sec-edgar-mcp: 4 passed
official-macro-mcp: 4 passed
tradfi-market-data-mcp: 4 passed
hyperliquid-tradfi-microstructure-mcp: 4 passed
capstone-evidence-mcp: 3 passed
```

Run TypeScript builds:

```bash
npm run build --workspace rickydata-sec-edgar-mcp
npm run build --workspace rickydata-official-macro-mcp
npm run build --workspace rickydata-tradfi-market-data-mcp
npm run build --workspace rickydata-hyperliquid-tradfi-microstructure-mcp
npm run build --workspace rickydata-capstone-evidence-mcp
```

Observed result: all five package builds completed with `tsc`.

Run live/local smoke checks:

```bash
SEC_USER_AGENT='rickydata_mcps local research contact@rickydata.org' npm run smoke --workspace rickydata-sec-edgar-mcp
npm run smoke --workspace rickydata-official-macro-mcp
npm run smoke --workspace rickydata-tradfi-market-data-mcp
npm run smoke --workspace rickydata-hyperliquid-tradfi-microstructure-mcp
npm run smoke --workspace rickydata-capstone-evidence-mcp
```

Observed result:

```text
SEC smoke: NVDA resolved to CIK 0001045810, 3 filings, Revenues/NetIncomeLoss/Assets facts.
Macro smoke: Treasury rows returned latestTreasuryDate 2026-05-26; BLS status REQUEST_SUCCEEDED.
TradFi smoke: Nasdaq public NVDA returned 5 rows, latest close 215.33 as of 2026-05-22.
Hyperliquid smoke: local ClickHouse discovery/context/slippage succeeded for xyz:NVDA.
Evidence smoke: local artifact bundle wrote 1 artifact and 1 claim.
```

Run MCP stdio protocol smoke after builds:

```bash
node --input-type=module <<'NODE'
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const servers = [
  {
    name: 'sec-edgar-mcp',
    command: 'node',
    args: ['packages/sec-edgar-mcp/dist/index.js'],
    call: ['sec_search_company', { query: 'NVDA', limit: 1 }],
    env: { SEC_USER_AGENT: 'rickydata_mcps local research contact@rickydata.org' },
  },
  {
    name: 'official-macro-mcp',
    command: 'node',
    args: ['packages/official-macro-mcp/dist/index.js'],
    call: ['macro_treasury_yield_curve', { year: 2026, limit: 1 }],
  },
  {
    name: 'tradfi-market-data-mcp',
    command: 'node',
    args: ['packages/tradfi-market-data-mcp/dist/index.js'],
    call: ['market_data_provider_status', {}],
  },
  {
    name: 'hyperliquid-tradfi-microstructure-mcp',
    command: 'node',
    args: ['packages/hyperliquid-tradfi-microstructure-mcp/dist/index.js'],
    call: ['hl_discover_tradfi_markets', { source: 'local_clickhouse', assetClass: 'equity', limit: 1 }],
  },
  {
    name: 'capstone-evidence-mcp',
    command: 'node',
    args: ['packages/capstone-evidence-mcp/dist/index.js'],
    call: ['evidence_list_artifacts', {}],
    env: { CAPSTONE_EVIDENCE_DIR: '/tmp/rickydata-capstone-evidence-mcp-protocol-smoke' },
  },
];

for (const server of servers) {
  const client = new Client({ name: `${server.name}-smoke`, version: '0.1.0' });
  const transport = new StdioClientTransport({
    command: server.command,
    args: server.args,
    env: { ...process.env, ...(server.env || {}) },
  });
  await client.connect(transport);
  const listed = await client.listTools();
  const result = await client.callTool({ name: server.call[0], arguments: server.call[1] });
  const text = result.content?.[0]?.text || '';
  console.log(JSON.stringify({ name: server.name, tools: listed.tools.length, call: server.call[0], resultChars: text.length }));
  await client.close();
}
NODE
```

Observed result: all five built stdio servers listed tools and returned a successful `callTool` response.

Check publish package contents:

```bash
npm pack --dry-run --workspace rickydata-sec-edgar-mcp
npm pack --dry-run --workspace rickydata-official-macro-mcp
npm pack --dry-run --workspace rickydata-tradfi-market-data-mcp
npm pack --dry-run --workspace rickydata-hyperliquid-tradfi-microstructure-mcp
npm pack --dry-run --workspace rickydata-capstone-evidence-mcp
```

Observed result: each tarball included `README.md`, `package.json`, and compiled `dist/**` files only after adding `files: ["dist", "README.md"]` to each package manifest.

## Gotchas

| Symptom | Cause | Fix |
|---|---|---|
| `npm install` warns about `vite@7.3.1` engine support | Existing workspace dependency expects Node `^20.19.0 || >=22.12.0`; verification used Node `22.9.0` | Warning did not block these MCP package tests/builds; use a supported Node when running full monorepo verification |
| `npm install` reports audit issues | Broader monorepo dependencies have existing moderate/high advisories | Do not run breaking `npm audit fix --force` while working on scoped MCP packages unless explicitly requested |
| Stooq CSV returns an API-key message | Stooq now requires an API key for direct CSV downloads | The local tradfi smoke uses Nasdaq public quote history for no-secret development |
| FRED/EIA tools return `configured:false` | API keys are optional and were not configured in the verified run | Provide `FRED_API_KEY` or `EIA_API_KEY` for those tools; Treasury and BLS smoke without keys |
| Hyperliquid taxonomy says `not_validated` for tradfi rows even after docs mention validation | ClickHouse may not have all latest validation rows loaded | Treat local `hl_get_local_validation_status` as the source of loaded proof state; do not overclaim beyond loaded rows |

## Quick Reference

```bash
npm run test --workspace rickydata-sec-edgar-mcp
npm run build --workspace rickydata-sec-edgar-mcp
SEC_USER_AGENT='rickydata_mcps local research contact@rickydata.org' npm run smoke --workspace rickydata-sec-edgar-mcp

npm run test --workspace rickydata-official-macro-mcp
npm run build --workspace rickydata-official-macro-mcp
npm run smoke --workspace rickydata-official-macro-mcp

npm run test --workspace rickydata-tradfi-market-data-mcp
npm run build --workspace rickydata-tradfi-market-data-mcp
npm run smoke --workspace rickydata-tradfi-market-data-mcp

npm run test --workspace rickydata-hyperliquid-tradfi-microstructure-mcp
npm run build --workspace rickydata-hyperliquid-tradfi-microstructure-mcp
npm run smoke --workspace rickydata-hyperliquid-tradfi-microstructure-mcp

npm run test --workspace rickydata-capstone-evidence-mcp
npm run build --workspace rickydata-capstone-evidence-mcp
npm run smoke --workspace rickydata-capstone-evidence-mcp
```
