---
name: knowledge-work-mcp
description: Use when changing or deploying the Voice Knowledge Partner MCP, especially recent activity, bundle limits, claim verification, KFDB-backed tools, or source-refresh production checks.
allowed-tools: Bash(npm:*), Bash(gh:*), Bash(curl:*), Bash(node:*)
---

# Knowledge Work MCP

## Purpose

Test and deploy `@rickydata/knowledge-work-mcp` without weakening its voice latency, payload, or provenance contracts.

## Verified

2026-07-13

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

The workflow's blocking `Verify production source commit` step polls the public MCP registration until its source commit equals the dispatched Git SHA and the server exposes exactly 16 tools. Treat a green workflow as the production receipt; do not infer success from the registry write alone.

## Recent Activity Contract

- `recent_activity` is the chronological path for questions such as “what happened recently?”; do not substitute semantic-search relevance for its rolling time window.
- It scans append-stable PRIVATE graph receipts and returns separate DEV, PROOF, KNOWLEDGE, LEARN, and MEDIA counts, exact source ids/versions, active content jobs, current quality-passed recommendations, curriculum coverage, and `reproducibility_hash`.
- Individual source failures remain explicit in `sources` and `omissions`; `complete:false` means missing counts are unknown, never zero.
- Use `trace` or `code_context` to deepen the exact receipts returned by `recent_activity`.
- Verified locally on 2026-07-13 with 55 package tests, TypeScript build, and a real stdio `tools/list` handshake returning 16 tools.

## Voice Contracts

- `knowledge_bundle` is Tier 2 and voice-capped in both its public schema and runtime: `token_budget <= 4000`, `page_limit <= 20`, and `claim_limit <= 40`.
- The recommended broad-walkthrough call is `token_budget: 2500`, `page_limit: 15`, and `claim_limit: 30`.
- Never open `.rickydata_cli/tool-results` to work around a large MCP result. Reduce the MCP request instead.
- `trace` verifies an exact claim from an exact-claim-text bundle. A page-slug bundle can omit the target claim and must not be used to infer that the claim is unverified.
- `trace` must never reject the MCP tool call because the Home trace route is slow or unavailable. Bound the Home request and return `status:"route_unavailable"`, `fallback:"kfdb_trace"`, the subject, and any best-effort KFDB payload as a successful tool result.
- `semantic_search` requests `include_entities:true`, then immediately safe-projects each encrypted result. Every readable hit carries first-class `title`, `summary` (whitespace-normalized, at most 200 characters), and `slug`; never return the hydrated entity or full wiki body.
- Preserve the distinction between the hydrated node `_id` and the semantic result's embedding id. Return them as `node_id` and `embedding_id`; do not overwrite the stable node identity with the embedding identity.

## Gotchas

### Source write succeeds but production remains stale

- **Symptom:** the KFDB registration write succeeds, `POST /api/servers/<id>/stop` returns `{"status":"stopped"}`, but the single-server reload returns HTTP 401 `Invalid or expired session`; the public MCP record stays on the previous source commit.
- **Cause:** the stored `OPERATOR_WALLET_TOKEN` can expire even though the stop route accepts it. The authenticated `/health/reload/<id>` route requires a current gateway session.
- **Fix:** do not rotate the wallet or the stored secret. Mint a fresh short-lived session through the existing `/api/auth/challenge` → wallet `signMessage` → `/api/auth/verify` flow, call the single-server reload as the authenticated admin, and let the already-running workflow's blocking production-SHA poll prove convergence. Verified 2026-07-12: reload returned `status:"updated"`, 15 tools, and workflow run `29190873565` passed against commit `b4248ac32f4b866066ecd5128c77e52fffa6d9b1`.

### Semantic search is hydrated but leaks private body fields

- **Symptom:** adding `include_entities:true` fixes hollow hits but exposes encrypted wiki bodies or replaces the stable node id with the embedding id.
- **Cause:** the raw semantic response is returned directly instead of being projected at the MCP boundary.
- **Fix:** safe-project immediately after hydration, emit only the compact fields above, and test that `body_md` and the raw `entity` object are absent.

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
| Public tool count | 16 |
| Production source | Exact dispatched Git SHA |
| Broad voice bundle | 2500 tokens, 15 pages, 30 claims |
| Trace verification | Exact claim ID and exact-claim result |
