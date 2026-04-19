# @rickydata/siyuan-mcp

MCP server for driving a deployed [SiYuan](https://siyuan.rickydata.org) instance.

Exposes HTTP tools (notebooks, docs, SQL, KFDB sync/backlinks) and a
WebSocket-driven RDM cell runner (create / run / read output) so Claude can
author and execute Python / R / API / KF / AI cells end-to-end.

## Auth

All three auth sources below are **alternatives** — any one suffices. The MCP
server boots without requiring any of them; auth is resolved lazily on the
first tool call. Token resolution priority:

1. `SIYUAN_KFDB_TOKEN` env — raw KFDB API key, used as `?kfdb_token=<value>`.
2. `SIYUAN_KFDB_JWT` env — KnowledgeFlow Google-OAuth JWT, exchanged once via
   `POST /api/auth/kfdb/token`. Derived key is **in-memory only** — never
   persisted to disk.
3. Local credential at `~/.siyuan-mcp/credentials.json` — paste-back token
   from `siyuan-mcp login`. Stored with `0600` permissions, atomic write.
   Token format is `siymcp_v1_<kfdb_api_key>`; the prefix is stripped before
   use. **This is a local disk fallback, not a gateway-managed secret** — it
   does not appear in any `secrets_required` manifest.

Default base URL is `https://siyuan.rickydata.org` (override with `SIYUAN_URL`).

## Development

```bash
npm install
npm run dev
```

## Build + test

```bash
npm run build
npm test
```

## CLI

```bash
npx siyuan-mcp login            # opens browser paste-back flow
npx siyuan-mcp login --token <siymcp_v1_...>
npx siyuan-mcp whoami
npx siyuan-mcp logout
```

## Docker

```bash
docker build -t siyuan-mcp .
docker run -p 8080:8080 -e SIYUAN_KFDB_TOKEN=... siyuan-mcp
```

## Changelog

### 0.2.3 (2026-04-19)

- **Fix (FU-3)**: `siyuan_create_cell` now persists the cell as a real SiYuan block via `POST /api/block/appendBlock` immediately after the WS `AddCell` handshake. Previously the cell only existed in the rdm-engine sidecar's ephemeral in-memory notebook session, so the doc's `block_count` never increased and the cell was lost on sidecar restart. The response now includes `persisted: true` to confirm the HTTP write succeeded.

### 0.2.2

- `siyuan_create_cell` forwards `options` for ai/mcp/api cells via `AddCell.options` on the WS wire.

### 0.2.1

- CLI `login`/`logout`/`whoami`. Credential file atomicity. `emit-tools` script.

### 0.2.0

- Initial public release: 12 tools (9 HTTP + 3 WS cell tools). Dual-transport (stdio/HTTP). JWT-exchange auth.
