# @rickydata/rickydata-bench-mcp

Read-only **analysis MCP** for the [rickydata_bench](https://benchmarks.rickydata.org)
agentic-coding benchmark. Inspect benchmark runs, trace summaries, config
leaderboards, per-task comparisons, and the (gold-redacted) task catalog.

> **This server is an analysis tool and is NEVER wired into a benchmark run.**
> It reads only the public, gold-redacted bench API. As defense-in-depth it also
> strips any `gold_* / fix_commit / pr_merge` keys from every response.

## Tools

| Tool | Source endpoint |
|---|---|
| `list_runs` | `GET /api/benchmarks/live` |
| `get_run` | `GET /api/benchmarks/live` (filtered by run_id) |
| `leaderboard` | `GET /api/benchmarks/recommendations` (config coverage) |
| `compare_configs` | `GET /api/benchmarks/compare?repo&issue_number` |
| `get_trace_summary` | `GET /api/benchmarks/live` (run's `trace_kg_summary`) |
| `search_tasks` | `GET /api/benchmarks/candidates?repo` (gold-redacted) |

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `BENCH_API_URL` | `https://benchmarks.rickydata.org` | Public bench API base URL |
| `RESPONSE_MAX_LENGTH` | `200000` | Whole-response character cap |
| `TRANSPORT` / `PORT` | `stdio` | `http` to run a Streamable-HTTP server |

## Public consumer boundary

This is the domain-specific public MCP for `rickydata_bench`, not an admin KFDB
MCP. It should remain safe for normal consumers behind RickyData Gateway
sign-to-derive / wallet-token auth:

- no admin KFDB API key is required by the package;
- tools are workflow-oriented and read from public benchmark APIs;
- gold answers, fix commits, and PR merge metadata are stripped in depth;
- benchmark execution never imports or depends on this MCP;
- gateway/user-specific auth should be enforced outside the package by the
  RickyData MCP Gateway.

Use this server as the reference pattern for Product Copilot and future
application-specific MCP servers: start narrow, validate real questions, then
promote repeated successful tool sequences into skills.

## Usage

```bash
npx -y @rickydata/rickydata-bench-mcp
```

```json
{
  "mcpServers": {
    "rickydata-bench": {
      "command": "npx",
      "args": ["-y", "@rickydata/rickydata-bench-mcp"]
    }
  }
}
```

## Development

```bash
npm install
npm run build --workspace @rickydata/rickydata-bench-mcp
npm run test  --workspace @rickydata/rickydata-bench-mcp
```
