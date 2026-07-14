# @rickydata/knowledge-work-mcp

Voice-ready MCP for the `rickydata-knowledge-partner` agent. It exposes a small
second-brain tool surface over KFDB and rickydata_home:

- Tier-0/Tier-1 reads: `session_brief`, `recent_activity`, `knowledge_bundle`, `semantic_search`
- Wiki and provenance reads: `wiki_search`, `wiki_page`, `context_pack`, `code_context`, `trace`
- Growth writes: `capture_open_question`, `capture_idea`, `capture_decision`
- Interview/HITL loop: `next_questions`, `record_answer`, `review_pending`, `resolve_item`

## Configuration

| Env | Required | Purpose |
| --- | --- | --- |
| `HOME_GATEWAY_JWT` | Preferred for home tools | Agent-gateway ES256 bearer for rickydata_home. Takes precedence over legacy `scwt_` minting. |
| `KNOWLEDGE_MCP_PRIVATE_KEY` | Legacy fallback | Mints `scwt_` home auth tokens and sign-to-derive sessions when injected delegated credentials are absent. |
| `HOME_API_URL` | Optional | rickydata_home base URL. Defaults to `https://rickydata-home-2dbp4scmrq-uc.a.run.app`. |
| `KFDB_API_URL` | Required for KFDB tools | KFDB API base URL. |
| `KFDB_API_KEY` | Required for KFDB tools | Bearer for KFDB API calls. |
| `S2D_SESSION_ID` / `S2D_DERIVED_KEY` | Preferred for private KFDB data | Pre-minted, revocable sign-to-derive session credentials. Requires `KFDB_WALLET_ADDRESS`. |
| `KFDB_WALLET_ADDRESS` | Optional | Wallet tenant header when no private key is available. With `KNOWLEDGE_MCP_PRIVATE_KEY`, the S2D wallet address is used. |
| `RESPONSE_MAX_LENGTH` | Optional | Tool response cap, default `120000` chars. |

## Auth law

- Home-backed tools prefer the injected `HOME_GATEWAY_JWT`. When it is absent,
  they preserve the legacy behavior and mint a fresh `scwt_` token per call.
  Without either credential, they throw before fetch.
- KFDB read tools try S2D when possible. If S2D is absent or refresh fails, reads
  still call KFDB without derive headers so bundle diagnostics can honestly
  report `s2d_active:false` / `undecrypted_skipped`.
- KFDB capture tools require S2D and fail before fetch without it. They write
  only compiler-consumable atoms (`OpenQuestion`, `Discovery`) or route decisions
  through home HITL; they never write `WikiPage` or `WikiClaim`.
- `recent_activity` treats Home's durable `RickydataCodeRun` rows as development
  receipts alongside rickydata_git change evidence. A completed run can carry
  its commit and canonical GitHub PR URL, but it remains DEV activity—not proof;
  only commit-pinned `EvidenceRecord` rows enter the PROOF category.

## Tools

The package intentionally exposes exactly 16 tools:

1. `session_brief`
2. `recent_activity`
3. `knowledge_bundle`
4. `semantic_search`
5. `wiki_search`
6. `wiki_page`
7. `context_pack`
8. `code_context`
9. `trace`
10. `capture_open_question`
11. `capture_idea`
12. `capture_decision`
13. `next_questions`
14. `record_answer`
15. `review_pending`
16. `resolve_item`

## Development

```bash
npm run build --workspace @rickydata/knowledge-work-mcp
npm run test --workspace @rickydata/knowledge-work-mcp
```
