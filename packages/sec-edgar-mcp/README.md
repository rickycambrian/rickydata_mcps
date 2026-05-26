# SEC EDGAR MCP

Local MCP server for CFA-style equity research using SEC EDGAR primary sources.

## Tools

- `sec_search_company` - search SEC company ticker metadata by ticker, CIK, or company name.
- `sec_get_submissions` - fetch recent filings for a company.
- `sec_get_companyfacts` - fetch and summarize XBRL company facts.
- `sec_extract_filing_sections` - fetch the latest filing document and extract common 10-K sections.
- `sec_export_equity_research_pack` - assemble a compact company profile, recent filings, and fundamentals pack.

## Configuration

Set an identifiable SEC user agent before live use:

```bash
export SEC_USER_AGENT="rickydata_mcps research contact@example.com"
```

## Local

```bash
npm install
npm run test
npm run build
npm run smoke
```
