# Capstone Evidence MCP

Local evidence register for the CFA capstone workflow. The server stores compact JSON artifacts with source URLs, data hashes, claims, and limitations. KFDB publication can be added after local evidence shape stabilizes.

## Tools

- `evidence_write_artifact`
- `evidence_list_artifacts`
- `evidence_get_artifact`
- `evidence_build_claim_register`
- `evidence_export_capstone_bundle`

## Configuration

```bash
export CAPSTONE_EVIDENCE_DIR=/tmp/rickydata-capstone-evidence
```

## Local

```bash
npm install
npm run test
npm run build
npm run smoke
```
