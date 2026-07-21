---
name: knowledge-work-mcp
description: Use when changing or deploying the Voice Knowledge Partner MCP, especially recent activity, bundle limits, claim verification, KFDB-backed tools, or source-refresh production checks.
allowed-tools: Bash(npm:*), Bash(gh:*), Bash(curl:*), Bash(node:*)
---

# Knowledge Work MCP

## Purpose

Test and deploy `@rickydata/knowledge-work-mcp` without weakening its voice latency, payload, or provenance contracts.

## Verified

2026-07-21

## Setup/Prerequisites

- Work from the `rickydata_mcps` repository on `main`.
- Use the repository's installed workspace dependencies.
- GitHub CLI must be authenticated for source-refresh dispatches.
- Production registration is server `3883e5df-de92-5c4d-9c09-f4f79a62e22d`.
- The admin-hidden public benchmark registration is server `f09f1acc-990a-4305-97a6-8e92c196aa97`.

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

The workflow's blocking `Verify production source commit` step requires the private registration to expose the dispatched Git SHA with exactly 16 tools and the admin-hidden public benchmark registration to expose the same SHA with exactly four tools through authenticated admin metadata. Treat a green workflow as the production receipt; do not infer success from the registry write alone. Verified 2026-07-21 by workflow run `29860535816`, attempt 2, against commit `8b32c06f673cbed877a856264cfecd82aca7fb8a`.

Check the non-secret production registration fields:

```bash
curl -sS https://mcp.rickydata.org/api/servers/3883e5df-de92-5c4d-9c09-f4f79a62e22d \
  | jq '{id,name,version,status,toolsCount,lastEnrichedCommitSha}'
```

If a source refresh overlaps a normal MCP Gateway deployment, wait for that deployment to reach its own terminal result, then rerun only the failed publication jobs:

```bash
gh run rerun 29860535816 --failed
gh run view 29860535816 --json status,conclusion,attempt,jobs,url
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
- Every private graph read obeys the KFDB law:
  `MATCH (n:Label) RETURN n.* LIMIT k` with `{scope:'private'}`. Pass opaque
  pagination cursors out of band, then apply timestamps, ids, joins, and filters
  in application code. Do not replace `n.*` with a field projection.
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
- Run those independent private scans through the deterministic four-worker
  queue. Preserve registry order in the result and never restore an unbounded
  `Promise.all` fan-out.
- `RickydataGitCommit` uses the exact
  `MATCH (n:RickydataGitCommit) RETURN n.* LIMIT 100000` query, 500-row opaque
  cursor pages, and a strict page bound. Normalize each page immediately and
  release the raw rows while retaining the full scanned row count. A 20,000-row
  ceiling is insufficient for the tracked repository fleet.
- `as_of` is an optional ISO-8601 projection clock. Use it when comparing
  `recent_activity` with another read model so both windows have identical
  `from` and `to` values; do not widen count tolerance to hide clock drift.
- Individual source failures remain explicit in `sources` and `omissions`; `complete:false` means missing counts are unknown, never zero.
- Use `trace` or `code_context` to deepen the exact receipts returned by `recent_activity`.
- An exact `evidence:<id>` trace reads `EvidenceRecord` privately and returns an
  honest EvidenceRecord plus `CommitReference` linked by
  `EvidenceRecord.commit_sha`. Do not synthesize a `GitCommit` node that was not
  read from the graph.
- Verified locally on 2026-07-15 with 72 package tests and TypeScript build, and
  in production by source-refresh workflow `29440929663` at exact commit
  `0c907c2d6a04d61543e3e705586c076e321708d6`, with 16 tools and a successful
  wallet-private `recent_activity` call through the paid Knowledge Partner.
- Verified again on 2026-07-20 with 78 package tests, TypeScript build, source
  deployment workflow `29714084955` at commit `e1ce4426cf9576073da161f115a06ae1b4d3baa7`,
  and the exact Learn production verifier. The private Git scan read 20,735
  rows, all 20 sources were complete, the pinned 24-hour window matched Pulse,
  and every DEV/PROOF/KNOWLEDGE/LEARN/MEDIA delta was zero. Receipt:
  `/tmp/rickydata-learn-partner-authority-proof.json`.

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
- Every route-unavailable trace exposes a plain `answer`, `fallback_status`, and categorical `home_error_category` / `fallback_error_category` diagnostics. Never return raw Home/KFDB error strings, status bodies, tokens, or authorization text. Preserve an exact answer already supplied by best-effort evidence.
- `semantic_search` requests `include_entities:true`, then immediately safe-projects each encrypted result. Every readable hit carries first-class `title`, `summary` (whitespace-normalized, at most 200 characters), and `slug`; never return the hydrated entity or full wiki body.
- Bound `title` to 160 characters and return `title_truncated:true` when the safe source label exceeded that limit. A safe projection must stay voice-sized even when legacy encrypted nodes stored claim text in `entity_label`.
- Preserve the distinction between the hydrated node `_id` and the semantic result's embedding id. Return them as `node_id` and `embedding_id`; do not overwrite the stable node identity with the embedding identity.
- Verified in production on 2026-07-15 at exact source commit `731ac694b7ab2de9e1c1e6ff021ff0ac332ce858`, package `0.1.15`: the canonical-wallet agent probe returned hydrated semantic hits with `title`, `summary`, and `slug`, observed bounded truncation, and completed a missing-page trace through the structured KFDB fallback without killing the MCP. Receipt: `/private/tmp/knowledge-partner-canonical-probe-2026-07-15T21-03-36.852Z.json`.
- Verified in production on 2026-07-16 at exact source commit `99b36a86cb3eec7717a0e290fc8b1b55ea585fae`, package `0.1.16`, workflow `29515611481`: a missing-page trace returned the safe exact `answer`, `authorization_unavailable` / `not_found` categories, independently revalidated requester-private authority, and no raw 401/404 or token text. Receipt: `/private/tmp/knowledge-partner-canonical-probe-2026-07-16T16-31-15.704Z.json`.

## Gotchas

### The public benchmark registration returns 404 after a successful reload

- **Symptom:** the public benchmark stop/reload succeeds, but
  `GET /api/servers/f09f1acc-990a-4305-97a6-8e92c196aa97` returns 404 and a
  public source-SHA poll can never observe its four tools.
- **Cause:** the benchmark registration is intentionally `admin_hidden`; public
  server accessors exclude it even though the gateway loaded it.
- **Fix:** keep the registration hidden. Verify its exact source SHA through
  authenticated `/api/admin/servers/:id/erc8004/status` and its tool count
  through authenticated `/api/admin/servers/hidden`. Verified 2026-07-21 by
  workflow `29860535816`, attempt 2: exact SHA `8b32c06f...`, 16 private tools,
  and four public benchmark tools.

### Source refresh overlaps a blue-green gateway cutover

- **Symptom:** package tests, build, and KFDB writes pass, then the authenticated
  private stop/reload exits through `curl -f` before the source proof runs.
- **Cause:** the refresh reached the gateway during its CI/CD blue-green
  cutover; the runtime endpoint was transiently unavailable.
- **Fix:** let the gateway deployment succeed or fail naturally, then use
  `gh run rerun <run-id> --failed`. Do not weaken the reload or source-SHA
  checks. Verified 2026-07-21: workflow `29860535816` attempt 1 failed at the
  reload during registry deployment `29860462754`; attempt 2 passed after that
  deployment completed successfully.

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

### Trace survives but exposes raw route failures to the model

- **Symptom:** `trace` returns successfully, but its payload includes raw Home
  authorization text or a KFDB not-found exception that the model may repeat.
- **Cause:** the fallback envelope preserved exception messages instead of the
  same categorical redaction already used by ranked-question fallback.
- **Fix:** expose only error categories, `fallback_status`, and a plain `answer`;
  preserve structured status, subject, best-effort evidence, and independently
  verified authority. Verified 2026-07-16 in production at package `0.1.16`,
  source commit `99b36a8`, workflow `29515611481`.

### Semantic search is hydrated but leaks private body fields

- **Symptom:** adding `include_entities:true` fixes hollow hits but exposes encrypted wiki bodies or replaces the stable node id with the embedding id.
- **Cause:** the raw semantic response is returned directly instead of being projected at the MCP boundary.
- **Fix:** safe-project immediately after hydration, emit only the compact fields above, and test that `body_md` and the raw `entity` object are absent.

### Semantic titles consume the voice context budget

- **Symptom:** semantic hits have all required fields, but a legacy `WikiClaim`
  label places an entire claim in `title`, inflating the model prompt and spoken
  answer.
- **Cause:** the safe projection bounded `summary` but treated every safe label
  as an already compact title.
- **Fix:** bound titles to 160 characters at the MCP boundary and expose
  `title_truncated` so callers can distinguish a complete title from a compact
  projection. Verified 2026-07-15 by the production canonical-wallet probe at
  source commit `731ac694b7ab2de9e1c1e6ff021ff0ac332ce858`.

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

### Recent activity misses repository-fleet commits

- **Symptom:** `recent_activity` is complete but reports far fewer DEV events
  than Pulse after the wallet tracks enough repositories.
- **Cause:** the 20,000-row Git ceiling selected only a subset of a private
  graph that had already grown beyond 20,000 rows.
- **Fix:** retain the deterministic four-worker queue, scan the strict `n.*`
  query to 100,000 through 500-row cursor pages, normalize per page, and release
  raw Git rows. Production on 2026-07-20 scanned 20,735 rows and matched Pulse
  exactly at 7,141 DEV events for the pinned window.

### Rolling counts drift during a long verifier run

- **Symptom:** both projections are healthy but DEV differs by a small moving
  number while new commits arrive.
- **Cause:** Pulse and the Partner evaluated “now” several minutes apart.
- **Fix:** read Pulse first and pass its exact rolling-window `to` value as
  `recent_activity.as_of`; assert both window endpoints before comparing counts.
  The exact production verifier observed zero deltas across every category on
  2026-07-20.

## Quick Reference

| Check | Required result |
|---|---|
| Package tests | All tests pass |
| Package build | TypeScript build passes |
| Private tool count | 16 |
| Public benchmark tool count | 4 through authenticated hidden-server metadata |
| Production source | Exact dispatched Git SHA on both registrations |
| Private authority | Requester wallet, wallet-private tenant, private scope |
| Session brief cap | 8 pages, 20 claims, 12 questions |
| Broad voice bundle | 2500 tokens, 15 pages, 30 claims |
| Evidence trace | Exact EvidenceRecord plus commit_sha CommitReference |
| Recent-activity scan concurrency | At most 4 |
| Complete Git scan | `RETURN n.* LIMIT 100000`, 500 rows/page |
| Cross-projection comparison | Exact Pulse `to` passed as `as_of` |
| Production source refresh | Workflow `29440929663`, exact SHA `0c907c2d...` |
| Semantic hit | title <= 160 chars, summary <= 200 chars, slug present |
| Missing trace route | Structured `route_unavailable`/`kfdb_trace`; MCP stays alive |
| Missing trace speech | Plain `answer`; categorical diagnostics; no raw route text |
