# @rickydata/siyuan-mcp

MCP server for driving a deployed [SiYuan](https://siyuan.rickydata.org) instance.

Exposes HTTP tools (notebooks, docs, SQL, KFDB sync/backlinks) and a
WebSocket-driven RDM cell runner (create / run / read output) so Claude can
author and execute Python / R / API / KF / AI cells end-to-end.

## Auth

Token resolution priority:

1. `SIYUAN_KFDB_TOKEN` env — raw KFDB API key, used as `?kfdb_token=<value>`.
2. `SIYUAN_KFDB_JWT` env — KnowledgeFlow Google-OAuth JWT, exchanged once via
   `POST /api/auth/kfdb/token`. Derived key is **in-memory only** — never
   persisted to disk.
3. `~/.siyuan-mcp/credentials.json` — paste-back token from `siyuan-mcp login`.
   Stored with `0600` permissions, atomic write. Token format is
   `siymcp_v1_<kfdb_api_key>`; the prefix is stripped before use.

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
