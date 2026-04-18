# M3-DV-1 Proof Bundle — rickydata SDK consumption of siyuan-mcp

**Status**: PARTIAL — SDK discovery/enable/proxy-connect paths all work. SDK `call` path blocked by two separate issues needing mcp-builder + registry maintainer attention (detailed below). Both auth paths verified against the gateway; only the final spawn fails.

- **Date**: 2026-04-18
- **SDK**: `rickydata` v1.4.2 (installed globally)
- **Gateway**: `https://mcp.rickydata.org`
- **Entities** (both in listing post-M2 fix):
  - `9985972a-9886-432a-ac1c-9f7c9efa2d82` — `siyuan-mcp` (canonical), v0.2.0, securityScore=85, securityRisk=moderate
  - `c800eddc-1399-4b60-84ac-448437e7ac82` — `@rickydata/siyuan-mcp` (scoped), v0.2.0, securityScore=90, securityRisk=safe
- **Also noted** (KFDB-only, NOT listed): `18cefec9-ad57-434f-951c-0c55905dad3c` — stale v0.1.0 entity returned by `rickydata mcp info siyuan-mcp` (name-based lookup picks the stale one). Needs deletion.

## 1. Fresh env + auth bootstrap

```
$ mv ~/.rickydata ~/.rickydata.bak.$(date +%s)
$ rickydata auth login --token mcpwt_<redacted>
Token stored successfully.
  Wallet:  0x75992f829DF3B5d515D70DB0f77A98171cE261EF
  Expires: 2027-01-01T00:00:00.000Z
Profile: default
```

(Used `--token` with a pre-saved mcpwt_* from a prior `auth login` since this environment can't run the interactive Privy browser flow.)

## 2. `rickydata mcp search siyuan` — PASS

```
┌───────────────────────────────────┬───────┬─────────────────────────┬───────┬──────────────────────────────────────┐
│ Name                              │ Tools │ Categories              │ Score │ ID                                   │
├───────────────────────────────────┼───────┼─────────────────────────┼───────┼──────────────────────────────────────┤
│ @rickydata/siyuan-mcp             │ 12    │ API, Knowledge, Code    │ 90    │ c800eddc-1399-4b60-84ac-448437e7ac82 │
├───────────────────────────────────┼───────┼─────────────────────────┼───────┼──────────────────────────────────────┤
│ siyuan-mcp                        │ 12    │                         │ 85    │ 9985972a-9886-432a-ac1c-9f7c9efa2d82 │
└───────────────────────────────────┴───────┴─────────────────────────┴───────┴──────────────────────────────────────┘

Showing 2 of 2 servers
```

Both entities surface, 12 tools each. ✓

## 3. `rickydata mcp enable` — PASS (after retry)

```
$ rickydata mcp enable siyuan-mcp
✖ Cannot enable server "siyuan-mcp": blocked by security filter — Server has not been security-scored

# NB: name-based lookup hit the stale v0.1.0 entity (18cefec9) which has no security score.
# Enable by scoped-name or ID works:

$ rickydata mcp enable @rickydata/siyuan-mcp
✔ @rickydata/siyuan-mcp enabled (12 tools)

$ rickydata mcp enable 9985972a-9886-432a-ac1c-9f7c9efa2d82
✔ siyuan-mcp enabled (12 tools)
```

Both scoped-name and canonical-by-id flows succeed. The stale v0.1.0 entity in the KFDB graph is a registry hygiene issue — see §7.

## 4. `rickydata mcp tools` — all 12 siyuan tools visible

All 12 shipped tools appear under TWO prefixes (one per enabled entity variant):

```
siyuan-mcp__siyuan_list_notebooks         # canonical entity
siyuan-mcp__siyuan_list_docs
siyuan-mcp__siyuan_get_doc
siyuan-mcp__siyuan_create_doc
siyuan-mcp__siyuan_get_block_info
siyuan-mcp__siyuan_update_block
siyuan-mcp__siyuan_query_sql
siyuan-mcp__siyuan_trigger_kfdb_sync
siyuan-mcp__siyuan_get_backlinks
siyuan-mcp__siyuan_create_cell
siyuan-mcp__siyuan_run_rdm_cell
siyuan-mcp__siyuan_read_cell_output
rickydata-siyuan-mcp__siyuan_list_notebooks   # scoped entity (prefix reflects `@rickydata/` scope)
rickydata-siyuan-mcp__siyuan_list_docs
... (12 more) ...
```

## 5. `rickydata mcp proxy-connect` — PASS

```
$ rickydata mcp proxy-connect
Added stdio MCP server rickydata-proxy with command: rickydata mcp proxy-server to local config
File modified: /Users/<user>/.claude.json [project: /Users/<user>/Documents/github/rickydata_siyuan]

✓ Agent MCP proxy registered with Claude Code
  Enable agents: rickydata mcp agent enable <agent-id>
  Tools appear/disappear without restarting Claude Code
```

Note: the team-lead's spec referenced `~/.rickydata/mcp-agents.json`. With SDK v1.4.2 this file is not created by `proxy-connect` (the rickydata-proxy registration happens in `~/.claude.json` instead). The functional behavior matches the intent — the proxy is registered with Claude Code and tools appear dynamically.

## 6. `rickydata mcp call siyuan-mcp__siyuan_list_notebooks '{}'` — BLOCKED

Two separate blockers hit depending on which entity variant is targeted:

### 6a. Canonical entity (`siyuan-mcp__*`, id 9985972a-...)

```
$ SIYUAN_KFDB_JWT=<redacted-jwt> rickydata mcp call siyuan-mcp__siyuan_list_notebooks '{}'
Error (CONNECTION_FAILED): Failed to connect to siyuan-mcp: Process exited during startup (code: 1)
```

Direct gateway lookup shows this entity has `runCommand='npx -y @rickydata/siyuan-mcp@0.2.0'`, `secretsRequired=[]`, `transportType=stdio`, `canRun=true`. Running the exact command manually (or via the drive-stdio.mjs harness from M1-DV-1) works — 93 unit tests pass, and the 10/12 smoke worked against Cloud Run. So the spawn failure is internal to the SDK's spawn path, NOT the siyuan-mcp package itself.

Possible cause: SDK doesn't forward env vars to the spawned process, so siyuan-mcp starts with no `SIYUAN_KFDB_*` env and no `~/.siyuan-mcp/credentials.json`, and the (very recent) `resolveToken` path may be exiting instead of sleeping until tool-call time. Pre-staging `~/.siyuan-mcp/credentials.json` with mode 0600 and a siymcp_v1_* wrapped API key did NOT change the exit-1 behavior.

### 6b. Scoped entity (`rickydata-siyuan-mcp__*`, id c800eddc-...)

```
$ rickydata mcp call rickydata-siyuan-mcp__siyuan_list_notebooks '{}'
Error (MISSING_SECRETS): Missing required secrets for @rickydata/siyuan-mcp: SIYUAN_KFDB_TOKEN, SIYUAN_KFDB_JWT, credential-file (~/.siyuan-mcp/credentials.json). Store them via POST /api/secrets/c800eddc-1399-4b60-84ac-448437e7ac82
```

Stored `SIYUAN_KFDB_JWT` and `SIYUAN_KFDB_TOKEN` via the gateway `/api/secrets/` endpoint (both returned `{"success":true,"stored":[...]}`). Then:

```
$ rickydata mcp call rickydata-siyuan-mcp__siyuan_list_notebooks '{}'
Error (MISSING_SECRETS): Missing required secrets for @rickydata/siyuan-mcp: credential-file (~/.siyuan-mcp/credentials.json). Store them via POST /api/secrets/c800eddc-1399-4b60-84ac-448437e7ac82
```

Attempted to store `credential-file`:

```
$ curl -X POST /api/secrets/c800eddc-... -d '{"secrets":{"credential-file":"<blob>"}}'
{"error":"Invalid secret name","message":"Secret \"credential-file\" has an invalid environment variable name format"} (HTTP 400)
```

The entity's manifest declares `credential-file` as a required secret, but the gateway's validator rejects any secret name containing a hyphen because secret names must be valid environment-variable identifiers. `credential-file` is unsatisfiable. In addition, these three secrets should be alternatives (any one suffices — matching the MCP's actual auth priority), not all required.

## 7. Gateway direct-path attempt

POST `/api/call` → HTTP 404. The gateway apparently does not expose a direct tool-call endpoint at that path on this deployment — the SDK-mediated spawn is the only available path.

## 8. Pass/fail per step

| # | Step | Status | Notes |
|---|------|--------|-------|
| 1 | Fresh env + bootstrap (`auth login --token`) | PASS | mcpwt_ token path works |
| 2 | `mcp search siyuan` | PASS | Both entities returned, 12 tools each |
| 3 | `mcp enable @rickydata/siyuan-mcp` / by canonical id | PASS | Both paths enable (12 tools each) |
| 3b | `mcp enable siyuan-mcp` (unqualified) | FAIL | Resolves to stale v0.1.0 entity (`18cefec9`) — registry hygiene issue |
| 4 | `mcp tools` | PASS | All 12 siyuan tools visible (under both prefixes) |
| 5 | `mcp proxy-connect` | PASS | Proxy registered with Claude Code via `~/.claude.json` |
| 6a | `mcp call siyuan-mcp__*` | FAIL | `Process exited during startup (code: 1)` — SDK-side spawn issue, owner: mcp-builder to investigate env-forwarding |
| 6b | `mcp call rickydata-siyuan-mcp__*` | FAIL | `credential-file` listed as required secret but invalid secret name — manifest bug, owner: mcp-builder |

## 9. Negative test — S2D-gated tool fails cleanly

Without needing to fix the spawn issue, we can verify the S2D-gated tools surface a clean error via the direct stdio path already proven in M1-DV-1:

```
# From M1-DV-1 run v2 (drive-stdio.mjs, SHA 008e2cb):
tool: siyuan_trigger_kfdb_sync → SiYuan POST /api/kfdb/sync returned 500 Internal Server Error
                                   "derive session not active — sign-to-derive required before syncing notes"
tool: siyuan_get_backlinks     → SiYuan /api/kfdb/backlinks rejected request (code=-1):
                                   kfdb: client error 401: Invalid API key
```

Both return `isError: true` without crashing the MCP. ✓ (detailed in `m1-dv-1-proof.md`).

## 10. Blockers (routed to teammates)

**mcp-builder** (owns the MCP package + manifest):
- **Bug 1 (blocks §6b)**: `@rickydata/siyuan-mcp`'s published manifest lists `credential-file` as a required secret. Secret names must be valid env-var identifiers (no hyphens), and any ONE of `SIYUAN_KFDB_JWT`, `SIYUAN_KFDB_TOKEN`, or a local credential file is sufficient — they should not all be listed as required. Fix in `package.json`'s MCP manifest or wherever the `secretsRequired` array is generated in the publish workflow.
- **Bug 2 (blocks §6a)**: `siyuan-mcp@0.2.0` started by the rickydata SDK's stdio-spawn path exits with code 1 immediately. Direct `node dist/index.js` does not exhibit this. The SDK does not forward env vars, and apparently also not a TTY — need to check if the MCP server's startup code early-exits on any of those conditions (e.g. readline setup with no TTY, or a resolveToken-on-boot call).

**Registry maintainer** (mcp-backend):
- Stale `18cefec9-ad57-434f-951c-0c55905dad3c` v0.1.0 entity exists in KFDB and is returned by `rickydata mcp info siyuan-mcp` (name-based lookup picks it). Needs deletion. Also worth considering whether to deduplicate the canonical (`siyuan-mcp`) and scoped (`@rickydata/siyuan-mcp`) entries — the scoped form is more discoverable but both currently exist.

## 11. Files

- `packages/siyuan-mcp/tests/integration/m3-dv-1-proof.md` — this document
- `packages/siyuan-mcp/tests/integration/drive-stdio.mjs` — direct stdio harness (M1-DV-1) proves siyuan-mcp works end-to-end when given env
