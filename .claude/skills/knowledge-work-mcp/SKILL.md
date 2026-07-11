---
name: knowledge-work-mcp
description: Use when changing or deploying the Voice Knowledge Partner MCP, especially bundle limits, claim verification, KFDB-backed tools, or source-refresh production checks.
allowed-tools: Bash(npm:*), Bash(gh:*), Bash(curl:*)
---

# Knowledge Work MCP

## Purpose

Test and deploy `@rickydata/knowledge-work-mcp` without weakening its voice latency, payload, or provenance contracts.

## Verified

2026-07-11

## Setup/Prerequisites

- Work from the `rickydata_mcps` repository on `main`.
- Use the repository's installed workspace dependencies.
- GitHub CLI must be authenticated for source-refresh dispatches.
- Production registration is server `3883e5df-de92-5c4d-9c09-f4f79a62e22d`.

## Commands

Run the package tests and build from the repository root:

```bash
npm run test --workspace @rickydata/knowledge-work-mcp
npm run build --workspace @rickydata/knowledge-work-mcp
```

Refresh the source-backed production registration after a tested commit:

```bash
gh workflow run publish-knowledge-work-mcp.yml \
  --ref main \
  -f refresh_source=true \
  -f skip_version_bump=true
```

The workflow's blocking `Verify production source commit` step polls the public MCP registration until its source commit equals the dispatched Git SHA and the server exposes exactly 15 tools. Treat a green workflow as the production receipt; do not infer success from the registry write alone.

## Voice Contracts

- `knowledge_bundle` is Tier 2 and voice-capped in both its public schema and runtime: `token_budget <= 4000`, `page_limit <= 20`, and `claim_limit <= 40`.
- The recommended broad-walkthrough call is `token_budget: 2500`, `page_limit: 15`, and `claim_limit: 30`.
- Never open `.rickydata_cli/tool-results` to work around a large MCP result. Reduce the MCP request instead.
- `trace` verifies an exact claim from an exact-claim-text bundle. A page-slug bundle can omit the target claim and must not be used to infer that the claim is unverified.

## Gotchas

### Source write succeeds but production remains stale

- **Symptom:** the KFDB registration write succeeds while the public MCP record still reports the previous source commit.
- **Cause:** a cached or expired operator credential can prevent the gateway reload after the write.
- **Fix:** require the workflow's blocking `Verify production source commit` step to pass. The step polls the public record and fails after 15 minutes instead of reporting a false-green refresh.

### Trace reports a known verified claim as unverified

- **Symptom:** `knowledge_bundle` reports a claim as verified but `trace` reports the same claim as unverified.
- **Cause:** verification was inferred from a query-filtered page bundle that omitted the exact claim.
- **Fix:** fetch by the exact claim text, match the exact claim ID, and derive the flag from that result.

### Broad voice answers spill into local result files

- **Symptom:** the agent reads an engine result file after `knowledge_bundle`, increasing latency and spoken length.
- **Cause:** the requested bundle exceeded the useful voice payload.
- **Fix:** preserve schema and runtime caps, use the recommended 2500/15/30 request, and keep the proof harness requirement of exactly one first-turn knowledge read.

## Quick Reference

| Check | Required result |
|---|---|
| Package tests | All tests pass |
| Package build | TypeScript build passes |
| Public tool count | 15 |
| Production source | Exact dispatched Git SHA |
| Broad voice bundle | 2500 tokens, 15 pages, 30 claims |
| Trace verification | Exact claim ID and exact-claim result |
