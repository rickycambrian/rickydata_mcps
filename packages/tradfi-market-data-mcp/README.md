# TradFi Market Data MCP

Read-only MCP server for traditional market prices and vendor adapter status.

The default local path uses Nasdaq's public quote history endpoint for U.S. equities so development can work without secrets. Paid vendors are exposed as configuration status and can be added behind the same tool contracts.

## Tools

- `market_data_provider_status`
- `market_get_daily_prices`
- `market_get_quote`
- `market_get_company_profile`
- `market_compare_perp_underlying`

## Optional Provider Keys

```bash
export ALPHAVANTAGE_API_KEY=...
export FMP_API_KEY=...
export POLYGON_API_KEY=...
```

## Local

```bash
npm install
npm run test
npm run build
npm run smoke
```
