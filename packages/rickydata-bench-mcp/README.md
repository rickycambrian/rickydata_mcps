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
