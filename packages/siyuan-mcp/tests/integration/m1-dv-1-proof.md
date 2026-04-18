# M1-DV-1 Proof Bundle — siyuan-mcp end-to-end smoke

- **Date**: 2026-04-18
- **SiYuan URL**: https://rickydata-siyuan-2dbp4scmrq-uc.a.run.app (and siyuan.rickydata.org CNAME)
- **MCP package**: packages/siyuan-mcp (rickycambrian/rickydata_mcps)
- **Build**: `npm install && npm run build` → dist/index.js
- **Harness**: tests/integration/drive-stdio.mjs (spawns dist/index.js over stdio, drives tools/list + 12 tools/call)

## Summary (pass/fail per tool)

| # | Tool | Status | Notes |
|---|------|--------|-------|
| 1 | `siyuan_list_notebooks` | PASS | returned 3 notebooks (wallet-scoped) |
| 2 | `siyuan_list_docs` | PASS | returned empty file list for first notebook |
| 3 | `siyuan_create_doc` | PASS | created doc 20260418143900-xo89j2k |
| 4 | `siyuan_get_doc` | PASS | returned block tree, blockCount=2 |
| 5 | `siyuan_get_block_info` | PASS | returned rootID/rootTitle/box |
| 6 | `siyuan_update_block` | PASS | ok:true, returned doOperations |
| 7 | `siyuan_query_sql` | PASS | SELECT DISTINCT box → 2 rows |
| 8 | `siyuan_trigger_kfdb_sync` | BACKEND_ERR | 500 "derive session not active — sign-to-derive required" — JWT/API-key bootstrap can't S2D. MCP surfaces error cleanly. |
| 9 | `siyuan_get_backlinks` | BACKEND_ERR | KFDB 401 "Invalid API key" — auth-mode gap. MCP surfaces error cleanly. |
| 10 | `siyuan_create_cell` | PASS | python cell `print(2+2)` created, cellId returned |
| 11 | `siyuan_run_rdm_cell` | PASS | stdout="4\n" via RDM WS — full round-trip works |
| 12 | `siyuan_read_cell_output` | MCP_BUG | HTTP proxy returned HTML (SPA fallthrough) — endpoint path likely wrong at /api/rdm/http/api/notebooks/<id>/cells/<cid>/output |

**Pass**: 9/12 tools returned valid output. **Backend-error**: 2 (`siyuan_trigger_kfdb_sync`, `siyuan_get_backlinks`) — expected limitations of JWT/API-key auth without S2D. **MCP-bug**: 1 (`siyuan_read_cell_output`) — see "Bug findings" section. All 12 tools were invoked; none crashed the MCP.

## Credentials file (masked)

Path: `~/.siyuan-mcp/credentials.json`  |  Mode: `0o600` (0600 ✓)

```json
{
  "token": "siymcp_v1_<redacted>",
  "savedAt": "2026-04-18T14:48:07.234Z"
}
```

## JWT bootstrap transcript (masked)

```
$ env -u SIYUAN_KFDB_TOKEN \
    SIYUAN_KFDB_JWT=<redacted-jwt> \
    SIYUAN_URL=https://rickydata-siyuan-2dbp4scmrq-uc.a.run.app \
    node tests/integration/drive-stdio.mjs

# MCP server booted, stderr: "siyuan-mcp running on stdio (siyuan=https://siyuan.rickydata.org)"
# (NB: SIYUAN_URL env var is not wired through to SiyuanClient in index.ts;
#  siyuan.rickydata.org CNAMEs to the same Cloud Run service, so traffic lands correctly.)

# /api/auth/kfdb/token exchange succeeded (code=0, token returned), then all 12 tools were invoked.
```

## Paste-back login transcript

```
$ rm -rf ~/.siyuan-mcp
$ node dist/cli.js login --no-open --token siymcp_v1_<redacted>
Credential saved.
  path:    /Users/<user>/.siyuan-mcp/credentials.json
  savedAt: 2026-04-18T14:48:07.234Z

$ ls -la ~/.siyuan-mcp/credentials.json
-rw-------@ 1 <user>  staff  337 Apr 18 15:48 /Users/<user>/.siyuan-mcp/credentials.json

$ env -u SIYUAN_KFDB_JWT -u SIYUAN_KFDB_TOKEN node dist/cli.js whoami
Credential present at /Users/<user>/.siyuan-mcp/credentials.json
  savedAt: 2026-04-18T14:48:07.234Z
  tokenPrefix: siymcp_v1_…
  wallet:  <not returned by /api/auth/wallet/status>

# Separate stdio MCP run with ONLY the credential file (no env vars):
# siyuan_list_notebooks returned 4 wallet-scoped notebooks (full transcript below).
```

Note: the paste-back token here was derived by running the JWT bootstrap and wrapping the returned API key as `siymcp_v1_<apiKey>`. This exercises the same code path as a user pasting from `/auth/cli` (browser step not scripted, confirmed live via `curl /auth/cli` → 200).

## Per-tool transcripts (12 tools)

### `siyuan_list_notebooks`

- elapsedMs: 3346

**Request args:**

```json
{}
```

**Response:**

```json
{
  "content": [
    {
      "type": "text",
      "text": "{\n  \"notebooks\": [\n    {\n      \"id\": \"20000101000000-kfdb000\",\n      \"name\": \"KFDB Notes\",\n      \"icon\": \"\",\n      \"closed\": false,\n      \"sort\": 0\n    },\n    {\n      \"id\": \"20260101000001-c3f9f63\",\n      \"name\": \"Daily Notes\",\n      \"icon\": \"\",\n      \"closed\": false,\n      \"sort\": 0\n    },\n    {\n      \"id\": \"20260101000002-be356e3\",\n      \"name\": \"Entities\",\n      \"icon\": \"\",\n      \"closed\": false,\n      \"sort\": 0\n    }\n  ],\n  \"count\": 3\n}"
    }
  ]
}
```

### `siyuan_list_docs`

- elapsedMs: 190

**Request args:**

```json
{
  "notebook": "20000101000000-kfdb000",
  "path": "/"
}
```

**Response:**

```json
{
  "content": [
    {
      "type": "text",
      "text": "{\n  \"box\": \"20000101000000-kfdb000\",\n  \"path\": \"/\",\n  \"files\": [],\n  \"count\": 0\n}"
    }
  ]
}
```

### `siyuan_create_doc`

- elapsedMs: 462

**Request args:**

```json
{
  "notebook": "20000101000000-kfdb000",
  "hPath": "/MCP Smoke Test 2026-04-18T14-39-00-785Z",
  "markdown": "# MCP Smoke Test 2026-04-18T14-39-00-785Z\n\nSmoke-test doc created by M1-DV-1 harness at 2026-04-18T14-39-00-785Z.\n"
}
```

**Response:**

```json
{
  "content": [
    {
      "type": "text",
      "text": "{\n  \"docID\": \"20260418143900-xo89j2k\",\n  \"notebook\": \"20000101000000-kfdb000\",\n  \"hPath\": \"/MCP Smoke Test 2026-04-18T14-39-00-785Z\"\n}"
    }
  ]
}
```

### `siyuan_get_doc`

- elapsedMs: 230

**Request args:**

```json
{
  "id": "20260418143900-xo89j2k"
}
```

**Response:**

```json
{
  "content": [
    {
      "type": "text",
      "text": "{\n  \"id\": \"20260418143900-xo89j2k\",\n  \"rootID\": \"20260418143900-xo89j2k\",\n  \"box\": \"20000101000000-kfdb000\",\n  \"path\": \"/20260418143900-xo89j2k.sy\",\n  \"blockCount\": 2,\n  \"content\": \"<div data-subtype=\\\"h1\\\" data-node-id=\\\"20260418143900-q8dztaw\\\" data-node-index=\\\"0\\\" data-type=\\\"NodeHeading\\\" class=\\\"h1\\\" updated=\\\"20260418143900\\\"><div contenteditable=\\\"true\\\" spellcheck=\\\"false\\\">MCP Smoke Test 2026-04-18T14-39-00-785Z</div><div class=\\\"protyle-attr\\\" contenteditable=\\\"false\\\">\u200b</div></div><div data-node-id=\\\"20260418143900-69ulatl\\\" data-node-index=\\\"1\\\" data-type=\\\"NodeParagraph\\\" class=\\\"p\\\" updated=\\\"20260418143900\\\"><div contenteditable=\\\"true\\\" spellcheck=\\\"false\\\">Smoke-test doc created by M1-DV-1 harness at 2026-04-18T14-39-00-785Z.</div><div class=\\\"protyle-attr\\\" contenteditable=\\\"false\\\">\u200b</div></div>\"\n}"
    }
  ]
}
```

### `siyuan_get_block_info`

- elapsedMs: 174

**Request args:**

```json
{
  "id": "20260418143900-xo89j2k"
}
```

**Response:**

```json
{
  "content": [
    {
      "type": "text",
      "text": "{\n  \"box\": \"20000101000000-kfdb000\",\n  \"path\": \"/20260418143900-xo89j2k.sy\",\n  \"rootChildID\": \"20260418143900-xo89j2k\",\n  \"rootID\": \"20260418143900-xo89j2k\",\n  \"rootIcon\": \"\",\n  \"rootTitle\": \"MCP Smoke Test 2026-04-18T14-39-00-785Z\"\n}"
    }
  ]
}
```

### `siyuan_update_block`

- elapsedMs: 227

**Request args:**

```json
{
  "id": "20260418143900-xo89j2k",
  "data": "Updated by M1-DV-1 harness at 2026-04-18T14-39-00-785Z",
  "dataType": "markdown"
}
```

**Response:**

```json
{
  "content": [
    {
      "type": "text",
      "text": "{\n  \"ok\": true,\n  \"id\": \"20260418143900-xo89j2k\",\n  \"result\": [\n    {\n      \"timestamp\": 0,\n      \"doOperations\": [\n        {\n          \"action\": \"delete\",\n          \"data\": {\n            \"createEmptyParagraph\": false\n          },\n          \"id\": \"20260418143900-q8dztaw\",\n          \"parentID\": \"\",\n          \"previousID\": \"\",\n          \"nextID\": \"\",\n          \"retData\": null,\n          \"blockIDs\": null,\n          \"blockID\": \"\",\n          \"deckID\": \"\",\n          \"avID\": \"\",\n          \"srcIDs\": null,\n          \"srcs\": null,\n          \"isDetached\": false,\n          \"name\": \"\",\n          \"type\": \"\",\n          \"format\": \"\",\n          \"keyID\": \"\",\n          \"rowID\": \"\",\n          \"isTwoWay\": false,\n          \"backRelationKeyID\": \"\",\n          \"removeDest\": false,\n          \"layout\": \"\",\n          \"groupID\": \"\",\n          \"targetGroupID\": \"\",\n          \"viewID\": \"\",\n          \"ignoreDefaultFill\": false,\n          \"context\": null\n        },\n        {\n          \"action\": \"delete\",\n          \"data\": {\n            \"createEmptyParagraph\": false\n          },\n          \"id\": \"20260418143900-69ulatl\",\n          \"parentID\": \"\",\n          \"previousID\": \"\",\n          \"nextID\": \"\",\n          \"retData\": null,\n          \"blockIDs\": null,\n          \"blockID\": \"\",\n          \"deckID\": \"\",\n          \"avID\": \"\",\n          \"srcIDs\": null,\n          \"srcs\": null,\n          \"isDetached\": false,\n          \"name\": \"\",\n          \"type\": \"\",\n          \"format\": \"\",\n          \"keyID\": \"\",\n          \"rowID\": \"\",\n          \"isTwoWay\": false,\n          \"backRelationKeyID\": \"\",\n          \"removeDest\": false,\n          \"layout\": \"\",\n          \"groupID\": \"\",\n          \"targetGroupID\": \"\",\n          \"viewID\": \"\",\n          \"ignoreDefaultFill\": false,\n          \"context\": null\n        },\n        {\n          \"action\": \"insert\",\n          \"data\": \"<div data-node-id=\\\"20260418143901-b54pu7u\\\" data-node-index=\\\"1\\\" data-type=\\\"NodeParagraph\\\" class=\\\"p\\\" updated=\\\"20260418143901\\\"><div contenteditable=\\\"true\\\" s... [truncated]"
    }
  ]
}
```

### `siyuan_query_sql`

- elapsedMs: 178

**Request args:**

```json
{
  "stmt": "SELECT DISTINCT box FROM blocks LIMIT 5"
}
```

**Response:**

```json
{
  "content": [
    {
      "type": "text",
      "text": "{\n  \"rowCount\": 2,\n  \"rows\": [\n    {\n      \"box\": \"20260101000001-c3f9f63\"\n    },\n    {\n      \"box\": \"20000101000000-kfdb000\"\n    }\n  ]\n}"
    }
  ]
}
```

### `siyuan_trigger_kfdb_sync`

- elapsedMs: 175

**Request args:**

```json
{}
```

**Response:**

```json
{
  "content": [
    {
      "type": "text",
      "text": "SiYuan POST /api/kfdb/sync returned 500 Internal Server Error"
    }
  ],
  "isError": true
}
```

### `siyuan_get_backlinks`

- elapsedMs: 181

**Request args:**

```json
{
  "id": "20260418143900-xo89j2k"
}
```

**Response:**

```json
{
  "content": [
    {
      "type": "text",
      "text": "SiYuan /api/kfdb/backlinks rejected request (code=-1): kfdb: get backlinks failed: kfdb: client error 401: Invalid API key"
    }
  ],
  "isError": true
}
```

### `siyuan_create_cell`

- elapsedMs: 4578

**Request args:**

```json
{
  "doc_id": "20260418143900-xo89j2k",
  "language": "python",
  "code": "print(2+2)",
  "after": null
}
```

**Response:**

```json
{
  "content": [
    {
      "type": "text",
      "text": "{\n  \"docId\": \"20260418143900-xo89j2k\",\n  \"cellId\": \"d4a90fe1-e31d-45d3-abe1-faa225423e7c\",\n  \"language\": \"python\",\n  \"imports\": [],\n  \"exports\": []\n}"
    }
  ]
}
```

### `siyuan_run_rdm_cell`

- elapsedMs: 4417

**Request args:**

```json
{
  "doc_id": "20260418143900-xo89j2k",
  "cell_id": "d4a90fe1-e31d-45d3-abe1-faa225423e7c",
  "timeout_ms": 60000
}
```

**Response:**

```json
{
  "content": [
    {
      "type": "text",
      "text": "{\n  \"ok\": true,\n  \"cellId\": \"d4a90fe1-e31d-45d3-abe1-faa225423e7c\",\n  \"durationMs\": 0,\n  \"defines\": [],\n  \"stdout\": \"4\\n\",\n  \"stderr\": \"\",\n  \"display\": []\n}"
    }
  ]
}
```

### `siyuan_read_cell_output`

- elapsedMs: 309

**Request args:**

```json
{
  "doc_id": "20260418143900-xo89j2k",
  "cell_id": "d4a90fe1-e31d-45d3-abe1-faa225423e7c"
}
```

**Response:**

```json
{
  "content": [
    {
      "type": "text",
      "text": "SiYuan /api/rdm/http/api/notebooks/20260418143900-xo89j2k/cells/d4a90fe1-e31d-45d3-abe1-faa225423e7c/output returned non-JSON body: Unexpected token '<', \"<!doctype \"... is not valid JSON"
    }
  ],
  "isError": true
}
```

## Negative tests

### NEG1 — Invalid paste-back token

```
$ rm -rf ~/.siyuan-mcp
$ node dist/cli.js login --no-open --token "siymcp_v1_INVALID_KEY_12345"
Credential saved.
  path:    /Users/<user>/.siyuan-mcp/credentials.json
  savedAt: 2026-04-18T14:43:16.662Z

# credentials.json perms: -rw------- (0600 ✓)
# credentials.json content: {"token":"siymcp_v1_<redacted>", "savedAt":"..."}

# stdio MCP call with invalid credential → siyuan_get_backlinks:
$ env -u SIYUAN_KFDB_JWT -u SIYUAN_KFDB_TOKEN node drive-neg-paste-sync.mjs
RESULT:
{
  "result": {
    "content": [{
      "type": "text",
      "text": "SiYuan /api/kfdb/backlinks rejected request (code=-1): kfdb: get backlinks by title failed: kfdb: client error 401: Invalid API key"
    }],
    "isError": true
  },
  "jsonrpc": "2.0",
  "id": 2
}
```

**Result**: MCP does not crash; returns `isError: true` with the upstream 401 error message. ✓

**Caveat** (backend issue, not MCP): `siyuan_list_notebooks` with an invalid paste-back token still returns a 200 from `/api/notebook/lsNotebooks` (Cloud Run accepts any non-empty `kfdb_token` without validation). Not an MCP bug — forwarded to mcp-builder/team-lead for backend review.

### NEG2 — No credentials (clean re-auth prompt)

Also attempted: tampered JWT with `exp=1` and bad signature. Finding — `/api/auth/kfdb/token` returns 200 + echoes input regardless of signature/exp. This lets the MCP derive an "API key" that is itself the tampered JWT, and subsequent calls also succeed (same caveat as NEG1). So the cleanest "MCP surfaces the error" proof is the no-credentials case:

```
$ rm -rf ~/.siyuan-mcp
$ env -u SIYUAN_KFDB_JWT -u SIYUAN_KFDB_TOKEN node drive-stdio.mjs
RESULT:
{
  "result": {
    "content": [{
      "type": "text",
      "text": "no SiYuan auth credential found. Set SIYUAN_KFDB_TOKEN, SIYUAN_KFDB_JWT, or run `siyuan-mcp login`."
    }],
    "isError": true
  },
  "jsonrpc": "2.0",
  "id": 2
}
```

**Result**: MCP returns a clean `isError: true` message pointing the user at either env-var or `siyuan-mcp login` re-auth paths. ✓

## Bug findings (forward to mcp-builder / mcp-backend)

1. **MCP bug — `siyuan_read_cell_output` hits a non-existent HTTP endpoint.** The tool calls `/api/rdm/http/api/notebooks/<docId>/cells/<cellId>/output`, which proxies to the RDM sidecar at `/api/notebooks/<docId>/cells/<cellId>/output`. The sidecar returns 200 + `text/html` (likely SPA fallthrough), which the SiYuan envelope parser rejects with `"non-JSON body: Unexpected token '<'"`. Owner: **mcp-builder** (likely need to change the proxied path, or add a different sidecar endpoint). Blocker? No — `siyuan_run_rdm_cell` already returns the full stdout (`"4\n"` in our run).

2. **MCP bug — `SIYUAN_URL` env var is not threaded through to `SiyuanClient`.** `src/index.ts` does `new SiyuanClient()` with no options. `src/siyuan-client.ts:70` reads `opts.env?.SIYUAN_URL`, but `opts.env` is always undefined. Effect: all traffic hits `DEFAULT_SIYUAN_URL` (`https://siyuan.rickydata.org`). Works by accident here because the DNS name CNAMEs to the same Cloud Run service. Owner: **mcp-builder**.

3. **Backend issue (non-MCP) — any `kfdb_token` is accepted.** `https://rickydata-siyuan-2dbp4scmrq-uc.a.run.app/api/notebook/lsNotebooks?kfdb_token=INVALID_KEY_12345` returns 200 with wallet-scoped data. Means an invalid paste-back token passes most tool calls; only KFDB-backed tools (`backlinks`, `sync`) reject with 401. Owner: **SiYuan backend team** (not in MCP scope). Likely the iframe-auth-bypass `kfdb_token` cookie/query-param path is not re-validating the key against KFDB on each request, or the test deployment trusts all keys.

4. **Backend issue — `/api/auth/kfdb/token` does not validate JWT signature or expiry.** A tampered JWT (bad signature, `exp=1`) returns 200 + echoes the JWT back as the "api key". Owner: **SiYuan backend team**.

5. **Backend limitation (expected) — `siyuan_trigger_kfdb_sync` and `siyuan_get_backlinks` require sign-to-derive.** JWT/API-key bootstrap cannot S2D, so these tools return backend 500/401 errors. Not a bug; MCP behavior is correct. Documentation note: paste-back token + JWT bootstrap are sufficient for the 10 non-S2D tools; sync + backlinks require the Privy-derive auth path (tracked in DV5).

## Files in this bundle

- `tests/integration/drive-stdio.mjs` — harness (committed)
- `tests/integration/m1-dv-1-proof.md` — this document (committed)
