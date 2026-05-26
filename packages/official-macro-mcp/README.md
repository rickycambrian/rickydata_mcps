# Official Macro MCP

Read-only MCP server for official macroeconomic inputs used in CFA research.

## Tools

- `macro_treasury_yield_curve` - U.S. Treasury daily par yield curve XML feed.
- `macro_bls_series` - BLS public API time series.
- `macro_fred_series` - FRED observations, requiring `FRED_API_KEY`.
- `macro_eia_petroleum_spot_price` - EIA petroleum spot price series, requiring `EIA_API_KEY`.
- `macro_snapshot_for_asset` - combined macro context for equity, FX, rates, commodity, or crypto research.

## Local

```bash
npm install
npm run test
npm run build
npm run smoke
```
