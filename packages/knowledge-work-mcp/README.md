# @rickydata/knowledge-work-mcp

Voice-ready MCP for the `rickydata-knowledge-partner` agent. It exposes a small
second-brain tool surface over KFDB and rickydata_home:

- Tier-0/Tier-1 reads: `session_brief`, `knowledge_bundle`, `semantic_search`
- Wiki and provenance reads: `wiki_search`, `wiki_page`, `context_pack`, `code_context`, `trace`
- Growth writes: `capture_open_question`, `capture_idea`, `capture_decision`
- Interview/HITL loop: `next_questions`, `record_answer`, `review_pending`, `resolve_item`

## Configuration

| Env | Required | Purpose |
| --- | --- | --- |
| `KNOWLEDGE_MCP_PRIVATE_KEY` | Required for home tools and KFDB writes | Mints `scwt_` home auth tokens and sign-to-derive sessions. No key means home tools fail before network egress and capture tools refuse. |
| `HOME_API_URL` | Optional | rickydata_home base URL. Defaults to `https://rickydata-home-2dbp4scmrq-uc.a.run.app`. |
| `KFDB_API_URL` | Required for KFDB tools | KFDB API base URL. |
| `KFDB_API_KEY` | Required for KFDB tools | Bearer for KFDB API calls. |
| `KFDB_WALLET_ADDRESS` | Optional | Wallet tenant header when no private key is available. With `KNOWLEDGE_MCP_PRIVATE_KEY`, the S2D wallet address is used. |
| `RESPONSE_MAX_LENGTH` | Optional | Tool response cap, default `120000` chars. |

## Auth law

- Home-backed tools mint a fresh `scwt_` token per call. Without
  `KNOWLEDGE_MCP_PRIVATE_KEY`, they throw before fetch.
- KFDB read tools try S2D when possible. If S2D is absent or refresh fails, reads
  still call KFDB without derive headers so bundle diagnostics can honestly
  report `s2d_active:false` / `undecrypted_skipped`.
- KFDB capture tools require S2D and fail before fetch without it. They write
  only compiler-consumable atoms (`OpenQuestion`, `Discovery`) or route decisions
  through home HITL; they never write `WikiPage` or `WikiClaim`.

## Tools

The package intentionally exposes exactly 15 tools:

1. `session_brief`
2. `knowledge_bundle`
3. `semantic_search`
4. `wiki_search`
5. `wiki_page`
6. `context_pack`
7. `code_context`
8. `trace`
9. `capture_open_question`
10. `capture_idea`
11. `capture_decision`
12. `next_questions`
13. `record_answer`
14. `review_pending`
15. `resolve_item`

## Development

```bash
npm run build --workspace @rickydata/knowledge-work-mcp
npm run test --workspace @rickydata/knowledge-work-mcp
```
