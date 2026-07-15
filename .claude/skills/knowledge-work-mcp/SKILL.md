---
name: knowledge-work-mcp
description: Use when changing or deploying the Voice Knowledge Partner MCP, especially recent activity, bundle limits, claim verification, KFDB-backed tools, or source-refresh production checks.
allowed-tools: Bash(npm:*), Bash(gh:*), Bash(curl:*), Bash(node:*)
---

# Knowledge Work MCP

## Purpose

Test and deploy `@rickydata/knowledge-work-mcp` without weakening its voice latency, payload, or provenance contracts.

## Verified

2026-07-15

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
  --repo rickycambrian/rickydata_mcps \
  --ref main \
  -f refresh_source=true
```

The workflow's blocking `Verify production source commit` step polls the public MCP registration until its source commit equals the dispatched Git SHA and the server exposes exactly 16 tools. Treat a green workflow as the production receipt; do not infer success from the registry write alone. Verified 2026-07-14 by workflow run `29369870079` against commit `9464ba9a`.

Check the non-secret production registration fields:

```bash
curl -sS https://mcp.rickydata.org/api/servers/3883e5df-de92-5c4d-9c09-f4f79a62e22d \
  | jq '{id,name,version,status,toolsCount,lastEnrichedCommitSha}'
```

## Private Authority Contract

- Every private tool call must expose redacted authority metadata showing the
  effective wallet equals the requester wallet, `tenant:"wallet-private"`,
  `query_scope:"private"`, credential type `kfdb-s2d-session`, and the KFDB
  endpoint. Fingerprints and provenance are safe; raw JWTs, S2D sessions,
  wallet tokens, signatures, and ciphertext are not.
- Delegated authority must remain requester-scoped from the browser capability
  through the gateway session and attached MCP. Never substitute an operator or
  service wallet and never silently fall back to global scope.
- Private graph reads obey the KFDB law: `MATCH (n:Label) RETURN n.* LIMIT k`
  with `{scope:'private'}`. Apply timestamps, ids, joins, and filters after the
  whole-label read in application code.
- `session_brief` is payload-bounded to 8 pages, 20 claims, and 12 open
  questions while remaining non-empty for a populated wallet graph.
- Every `trace` outcome, including route-unavailable fallback branches, must
  carry independently revalidated KFDB authority metadata.

## Recent Activity Contract

- `recent_activity` is the chronological path for questions such as “what happened recently?”; do not substitute semantic-search relevance for its rolling time window.
- It scans append-stable PRIVATE graph receipts and returns separate DEV, PROOF, KNOWLEDGE, LEARN, and MEDIA counts, exact source ids/versions, active content jobs, current quality-passed recommendations, curriculum coverage, and `reproducibility_hash`.
- It uses the same 20-source registry and rolling-window semantics as Learn
  Pulse. The registry includes development, evidence, wiki, course, learning,
  media, feedback, candidate, and content-job labels; count or source drift is a
  verifier failure, not an intentional approximation.
- Individual source failures remain explicit in `sources` and `omissions`; `complete:false` means missing counts are unknown, never zero.
- Use `trace` or `code_context` to deepen the exact receipts returned by `recent_activity`.
- An exact `evidence:<id>` trace reads `EvidenceRecord` privately and returns an
  honest EvidenceRecord plus `CommitReference` linked by
  `EvidenceRecord.commit_sha`. Do not synthesize a `GitCommit` node that was not
  read from the graph.
- Verified locally on 2026-07-14 with 65 package tests and TypeScript build, and
  in production with 16 tools and wallet-private EvidenceRecord tracing.

## Code Context Contract

- A repository-scoped `code_context` call resolves the human repo name to the
  private imported-repository UUID before retrieval and sends both
  `include_graph:true` and `strict_scope:true` to KFDB.
- Keep direct evidence only when it carries at least one repo-provable stream:
  `fts`, `dense`, or `symbol`. Graph-only evidence remains excluded because it
  cannot independently prove repository scope.
- Preserve a graph neighborhood only after filtering every node on
  `properties.repo_id` against the resolved repo set. Preserve only edges whose
  endpoints both survived, and drop a neighborhood when its seed did not.
- Return the filtered neighborhood plus explicit dropped-node/dropped-edge
  diagnostics and the normal requester-matched private authority receipt.
- Verified 2026-07-15 against the real private `rickydata_code` corpus:
  `home_context.rs` and `mint_home_token` were retrieved through FTS, dense, and
  symbol streams; the file expanded through `DEFINES` into four repo-matching
  File/Function/Module nodes; no graph nodes or edges were filtered as foreign.

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

- **Symptom:** the KFDB registry write succeeds, but the single-server reload
  returns HTTP 401 and the public MCP record stays on the previous source
  commit.
- **Cause:** a legacy expiring value in the existing
  `OPERATOR_WALLET_TOKEN` GitHub Actions secret no longer authenticates the
  admin reload. A registry write alone does not invalidate already-running
  per-wallet MCP instances.
- **Fix:** rotate that existing secret through the normal wallet-auth flow to a
  long-lived self-verifying `mcpwt_` token, rerun the source-refresh workflow,
  and require both the authenticated reload and blocking public source-SHA
  check to pass. The reload must invalidate every wallet runtime instance and
  the workflow must fail closed if it does not. Verified 2026-07-14 by failed
  run `29364095971` followed by successful run `29369870079`.

### Trace fallback loses private authority

- **Symptom:** a successful private trace has authority metadata on its primary
  path but omits it when the Home route or both trace sources are unavailable.
- **Cause:** fallback results were returned before the KFDB session was
  independently revalidated.
- **Fix:** revalidate the delegated KFDB session before every fallback return,
  stamp the same redacted authority object, and fail closed on a wallet or scope
  mismatch.

### Semantic search is hydrated but leaks private body fields

- **Symptom:** adding `include_entities:true` fixes hollow hits but exposes encrypted wiki bodies or replaces the stable node id with the embedding id.
- **Cause:** the raw semantic response is returned directly instead of being projected at the MCP boundary.
- **Fix:** safe-project immediately after hydration, emit only the compact fields above, and test that `body_md` and the raw `entity` object are absent.

### A global next-question request returns an empty scoped queue

- **Symptom:** the model adds a topic to a global “highest-value” request, the
  scoped result is empty, and the fallback misleadingly reports
  `total_open:0` even though the private graph has open questions.
- **Cause:** the tool schema described `topic` only as optional and the fallback
  counted the post-filter rows as the whole queue.
- **Fix:** tell the model to omit `topic` unless the user explicitly names one.
  On a scoped miss, perform one unscoped queue projection, report
  `topic_matches` plus a no-topic retry hint, and distinguish a complete count
  from a lower bound with `queue_projection_complete` and
  `total_open_is_lower_bound`. Successful KFDB fallbacks expose only a safe
  Home error category, never raw authorization text. Verified 2026-07-15 in
  production at source commit `bb57194` (workflow run `29432454592`): a
  canonical-wallet global request omitted `topic` and returned 111 ranked
  rows; a nonexistent explicit topic returned zero matches, at least 111
  visible open questions, `total_open_is_lower_bound:true`, 8,899 pruned
  question rows, and no raw Home-token error.

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
| Private authority | Requester wallet, wallet-private tenant, private scope |
| Session brief cap | 8 pages, 20 claims, 12 questions |
| Broad voice bundle | 2500 tokens, 15 pages, 30 claims |
| Evidence trace | Exact EvidenceRecord plus commit_sha CommitReference |
