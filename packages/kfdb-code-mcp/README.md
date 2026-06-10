# @rickydata/kfdb-code-mcp

Read-only **code-intelligence MCP** backed by [KnowledgeFlowDB](https://knowledgeflowdb.org).
Gives an agent semantic + full-text code search, symbol lookup, call-graph
navigation, and ranked context bundles over indexed repositories — without any
write or admin capability.

It also ships a hardened **bench mode** used by `rickydata_bench` to evaluate
agentic coding effectiveness without leaking benchmark solutions.

## Tools

| Tool | Endpoint | Bench mode | Needs API key |
|---|---|---|---|
| `search_code` | `POST /api/v1/code-search` | ✅ | — |
| `find_symbol` | `POST /api/v1/code-search` (symbol stream) | ✅ | — |
| `get_callers` | `POST /api/v1/graph/ego` (incoming `CALLS`) | ✅ | ✅ |
| `get_callees` | `POST /api/v1/graph/ego` (outgoing `CALLS`) | ✅ | ✅ |
| `get_context_bundle` | `POST /api/v1/agent/context` | ✅ | — |
| `list_repos` | `GET /api/v1/entities/Repository` | ❌ (not registered) | ✅ |
| `repo_overview` | `POST /api/v1/agent/context` | ❌ (not registered) | — |

Snippets are capped (~400 chars) — agents are expected to already have the repo
checked out locally; these tools locate and rank, they do not deliver files.

**API-key gating**: `get_callers`/`get_callees` hit the tenant-authenticated
ego-graph endpoint and only work with a key. When no key is available, those two
tools are **omitted from `tools/list` entirely** (not registered) so an agent is
never offered a tool that can only error. Crucially, the key that enables them is
**mode-dependent**:

- **Full mode** → `KFDB_API_KEY`.
- **Bench mode** → the explicit **`KFDB_BENCH_TOOLS_API_KEY` only**. The ambient
  `KFDB_API_KEY` is deliberately ignored in bench mode, so a runner that happens
  to have `KFDB_API_KEY` in its environment cannot silently promote the keyless
  3-tool surface to 5 tools (which would flip an experiment arm).

| Mode | Key that enables ego tools | With key | Without |
|---|---|---|---|
| Full | `KFDB_API_KEY` | 7 | 5 |
| Bench (`KFDB_BENCH_REPO_SCOPE` set) | `KFDB_BENCH_TOOLS_API_KEY` | 5 | 3 |

In bench mode the ambient `KFDB_API_KEY` is never sent on any request either —
the public search/context calls go out unauthenticated, and the ego call uses
`KFDB_BENCH_TOOLS_API_KEY`.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `KFDB_API_URL` | `http://34.60.37.158` | KFDB API base URL |
| `KFDB_API_KEY` | _(unset)_ | Bearer token. In **full mode** enables `get_callers`/`get_callees`. **Ignored in bench mode.** Search + context bundles are public. |
| `KFDB_BENCH_TOOLS_API_KEY` | _(unset)_ | **Bench mode only.** Explicit opt-in key that enables the 2 call-graph tools under bench mode. Absent ⇒ keyless 3-tool surface. |
| `KFDB_BENCH_REPO_SCOPE` | _(unset)_ | When set to a repo_id (UUID), enables bench mode (see below). |
| `RESPONSE_MAX_LENGTH` | `200000` | Whole-response character cap. |
| `SNIPPET_MAX_LENGTH` | `400` | Per-snippet character cap. |
| `TRANSPORT` / `PORT` | `stdio` | `http` to run a Streamable-HTTP server. |

## Bench mode (`KFDB_BENCH_REPO_SCOPE` set)

Designed so an agent under evaluation can navigate **only** a single pinned-commit
repo corpus and can never reach other repos, default-branch (HEAD) corpora, or
benchmark gold answers:

1. **Tool filtering** — only the 5 scoped tools above are registered; `tools/list`
   returns exactly those, and discovery tools are rejected even if called directly.
2. **Forced scope** — every upstream call forces `repo_scope=[KFDB_BENCH_REPO_SCOPE]`
   and `strict_scope=true`, **ignoring/overriding any caller-supplied scope**.
3. **Output sanitizer** — every response is recursively stripped of keys matching
   `^gold_ | fix_commit | pr_merge` (defense-in-depth on top of KFDB server-side
   redaction).
4. **Ego-graph seed allowlist** — `get_callers`/`get_callees` only accept a
   `node_id` previously returned by a scoped `search_code` / `find_symbol` /
   `get_context_bundle` call in the same session; arbitrary ids are rejected.

## Usage

```bash
# stdio (npx / MCP client)
npx -y @rickydata/kfdb-code-mcp

# bench mode against a pinned snapshot
KFDB_BENCH_REPO_SCOPE=<pinned-repo-uuid> npx -y @rickydata/kfdb-code-mcp
```

MCP client config (`.mcp.json`):

```json
{
  "mcpServers": {
    "kfdb-code": {
      "command": "npx",
      "args": ["-y", "@rickydata/kfdb-code-mcp"],
      "env": { "KFDB_API_URL": "http://34.60.37.158" }
    }
  }
}
```

## Development

```bash
npm install
npm run build --workspace @rickydata/kfdb-code-mcp
npm run test  --workspace @rickydata/kfdb-code-mcp
```
