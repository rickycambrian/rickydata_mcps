---
name: research-papers-dev
description: Development workflow for the research-papers-mcp server. Use when building, running, or debugging the research-papers-mcp package — includes verified build commands, tool reference, ingestion pipeline flow, and key env vars.
---

# research-papers-mcp Development

Verified working as of task completion: `npm run build` succeeds with zero errors, `npm run dev` starts and reports "research-papers-mcp running on stdio (6 tools)".

## Build and Run

```bash
# From repo root — install workspace deps first
npm install

# Build only this package
cd packages/research-papers-mcp
npm run build        # compiles TypeScript → dist/

# Dev mode (stdio, no build required)
npm run dev          # runs src/index.ts via tsx

# HTTP mode (StreamableHTTP transport)
node dist/index.js --http    # listens on PORT (default 8080)
```

**Transport**: stdio is the default. Pass `--http` flag for HTTP mode (not a TRANSPORT env var). HTTP mode uses `StreamableHTTPServerTransport` with session management via `mcp-session-id` header. Endpoints: `POST /mcp`, `GET /mcp`, `DELETE /mcp`, `GET /health`.

## Source Structure

```
packages/research-papers-mcp/
  src/
    index.ts          # Server entry point, transport switching (--http flag)
    config.ts         # Env var exports
    arxiv.ts          # arXiv Atom feed client (rate-limited, max 50 results/query)
    parser.ts         # HTML (htmlparser2) + PDF (pdf-parse) section extraction
    kfdb.ts           # KFDB graph/semantic search API client
    store.ts          # Paper store facade (KFDB + local artifact cache)
    tools/
      index.ts        # Tool aggregation + dispatch router
      discovery.ts    # search_arxiv_papers
      ingestion.ts    # ingest_paper
      navigation.ts   # list_papers, get_paper_overview, get_paper_section
      search.ts       # search_paper_contents
```

## The 6 Tools

| Tool | Description |
|------|-------------|
| `search_arxiv_papers` | Search arXiv by keyword, category, date range. Returns metadata only — does not ingest. |
| `ingest_paper` | Fetch, parse, and store a paper by arXiv ID. HTML preferred, PDF fallback. Chunks for semantic search, stores in KFDB + local cache. |
| `list_papers` | List all ingested papers with optional keyword filter. |
| `get_paper_overview` | Navigation guide for a stored paper: section outline, key terms, recommended queries, abstract. |
| `get_paper_section` | Full text of a specific section, addressed by name or 1-based ordinal. |
| `search_paper_contents` | Semantic search across ingested paper chunks via KFDB vector embeddings. |

## Ingestion Pipeline Flow

```
search_arxiv_papers   →  discover candidates (metadata only)
ingest_paper          →  fetch HTML/PDF → parse sections → chunk (~2000 chars)
                          → store in KFDB + local artifact cache
get_paper_overview    →  read section outline and key terms before deep-diving
get_paper_section     →  fetch specific section text by name or ordinal
search_paper_contents →  semantic search across all stored chunks
```

## Key Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `KFDB_API_URL` | `http://34.60.37.158` | KFDB graph/embedding API base URL |
| `KFDB_API_KEY` | `` (empty) | Auth key for KFDB API |
| `ARTIFACT_DIR` | `~/.research-papers-mcp/artifacts/` | Local paper artifact cache directory |
| `RESPONSE_MAX_LENGTH` | `200000` | Max response chars before truncation |
| `ARXIV_RATE_LIMIT_MS` | `3000` | Delay between arXiv API calls (ms) |
| `PORT` | `8080` | HTTP server port (HTTP mode only) |

Copy `.env.example` to `.env` and fill in `KFDB_API_KEY` before running.

## URI Scheme

Papers in KFDB use the `ResearchPaper://` prefix (PascalCase):
- Graph node ID: `ResearchPaper://{arxivId}`
- Chunk embeddings: `ResearchPaper://{arxivId}/chunk-{ordinal}`

## Patterns Used

- **Tool organization**: tools split by domain into `discovery.ts`, `ingestion.ts`, `navigation.ts`, `search.ts` — aggregated in `tools/index.ts` with a name→handler dispatch map
- **Response capping**: `truncateResponse()` in `index.ts` caps at `RESPONSE_MAX_LENGTH` chars
- **Dual transport**: stdio default + HTTP via `--http` flag using `StreamableHTTPServerTransport`

See also: `.claude/skills/mcp-patterns/SKILL.md` for general MCP development patterns.
