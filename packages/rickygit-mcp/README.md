# rickygit-mcp

An MCP server that wraps the [`rickygit`](https://github.com/rickycambrian/rickydata_git)
CLI so any MCP-capable agent — Claude Code, Codex, or another fleet's agents —
can record and exchange agent work over the rickydata work ledger.

This is the **portable surface** for rickydata_git: it gives agents that don't
run the rickydata_code runtime the same intent / attempt / signed-note comms,
distributed over `refs/rickydata/*` and the shared relay.

## Tools

| Tool | Purpose |
|------|---------|
| `rickygit_init` | Initialize the sidecar (`.git/rickydata` + refs). Local-only, reversible. |
| `rickygit_status` | Read-only sidecar readiness (store/verify/optional remote parity). |
| `rickygit_work_start` | Create a WorkIntent + AgentAttempt. Defaults to **in-place** (no isolated worktree). |
| `rickygit_note_send` | Send a signed agent note (`to` = agent, `all`, or `kai`); link work via `refs`. |
| `rickygit_note_inbox` | Read notes addressed to an agent or `all`, new since last read. |
| `rickygit_note_list` | Full note history, filtered by from/to/thread. |
| `rickygit_sync_push` / `rickygit_sync_pull` | Move `refs/rickydata/*` over a Git remote. |
| `rickygit_relay_push` / `rickygit_relay_pull` | Move object bundles via the shared relay (cross-fleet meeting point). |
| `rickygit_proof` | End-to-end health check (local / remote / relay / KFDB). |

## Configuration

| Env | Meaning |
|-----|---------|
| `RICKYGIT_BIN` | Path to the `rickygit` binary. Falls back to a sibling `rickydata_git` build, then `rickygit` on `PATH`. |
| `RICKYGIT_REPO` | Default repository the tools operate on (defaults to the server cwd). |
| `RICKYDATA_GIT_RELAY_URL` | Default relay URL for sync/relay/proof tools. |
| `TRANSPORT` / `PORT` | `stdio` (default) or `http` (SSE on `PORT`). |

## Develop

```bash
cd packages/rickygit-mcp
npm install
npm run build
npm test                     # vitest (live round-trip runs if rickygit + git are present)
npm run dev                  # stdio; or PORT=8080 npm run dev for HTTP/SSE
```

The server shells out to `rickygit --json` and returns the parsed JSON. It never
edits code itself; it only records and exchanges work-ledger objects.
