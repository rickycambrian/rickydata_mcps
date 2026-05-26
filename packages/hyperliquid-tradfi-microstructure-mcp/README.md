# Hyperliquid TradFi Microstructure MCP

Read-only MCP server for Hyperliquid HIP-3 and traditional-style perps.

It prefers local ClickHouse data from `hyperliquid_data` and falls back to official Hyperliquid info API calls for live discovery, context, and L2 book slippage.

## Tools

- `hl_discover_tradfi_markets`
- `hl_get_market_context`
- `hl_get_local_depth`
- `hl_estimate_slippage`
- `hl_get_local_validation_status`
- `hl_export_capstone_pack`

## Configuration

```bash
export HL_CLICKHOUSE_CONTAINER=hyperliquid-clickhouse
```

## Local

```bash
npm install
npm run test
npm run build
npm run smoke
```
