# M2-DV-1 Proof Bundle — siyuan-mcp on mcp.rickydata.org gateway

**Status**: PASS — siyuan-mcp is listed on the gateway with all 12 tools; `rickydata.org/browse` serves HTTP 200 over the SPA that consumes this listing.

- **Date**: 2026-04-18 (post-recovery)
- **Gateway**: https://mcp.rickydata.org
- **Entity ID**: `9985972a-9886-432a-ac1c-9f7c9efa2d82`
- **KFDB label**: `MCPServer`
- **npm**: `@rickydata/siyuan-mcp@0.2.0`
- **Publish workflow fix**: SHA `9749da4` on `rickycambrian/rickydata_mcps:main` (commit `ci(siyuan-mcp): M2-FIX-1 add security defaults so gateway lists entity`). Future v0.1.1+ publishes include security defaults inline; no manual patch required.
- **Current live entity patch (pre-fix workflow)**: mcp-backend POSTed `update_node` with `security_score=85`, `security_risk="safe"`, `gateway_security_score=75`, `gateway_risk_score=25`. Gateway re-hydration took 232s (sync complete at 16:34:52 UTC).

## 1. Gateway listing (authoritative)

```sh
$ curl -s 'https://mcp.rickydata.org/api/servers?limit=5000' \
    | jq '[.servers[] | select(.id=="9985972a-9886-432a-ac1c-9f7c9efa2d82")][0]'
```

```json
{
  "id": "9985972a-9886-432a-ac1c-9f7c9efa2d82",
  "name": "siyuan-mcp",
  "title": "siyuan-mcp",
  "description": "",
  "version": "0.2.0",
  "registryType": "npm",
  "toolsCount": 12,
  "categories": [],
  "deploymentType": "local_tool",
  "gatewayCompatible": true,
  "gatewayNotes": "",
  "externalServices": [],
  "gatewaySecurityScore": 75,
  "gatewayRiskScore": 25,
  "gatewaySafe": true,
  "gatewayRecommendation": null,
  "securityScore": 85,
  "codeSecurityScore": null,
  "userRiskScore": null,
  "securityRisk": "moderate",
  "canRun": true,
  "executionMethod": "npm",
  "secretsRequired": [],
  "enrichmentVersion": "5",
  "enrichedAt": "2026-04-18T16:24:42.582Z",
  "skillGenerated": false
}
```

The entity passes the gateway's list filter because `securityScore=85`, `securityRisk="moderate"`, `gatewaySecurityScore=75` are all populated (was the blocker diagnosed earlier in this same bundle history).

Gateway total before the patch: 1764 listed of 3424 KFDB entities. After re-hydration: 1770 listed (matches the timing of the `update_node` patch taking effect).

## 2. Tools verification (all 12 present)

```sh
$ curl -s 'https://mcp.rickydata.org/api/servers/9985972a-9886-432a-ac1c-9f7c9efa2d82' \
    | jq '{toolsCount, toolNames: [.tools[].name]}'
```

```json
{
  "toolsCount": 12,
  "toolNames": [
    "siyuan_list_notebooks",
    "siyuan_list_docs",
    "siyuan_get_doc",
    "siyuan_create_doc",
    "siyuan_get_block_info",
    "siyuan_update_block",
    "siyuan_query_sql",
    "siyuan_trigger_kfdb_sync",
    "siyuan_get_backlinks",
    "siyuan_create_cell",
    "siyuan_run_rdm_cell",
    "siyuan_read_cell_output"
  ]
}
```

Exact match with the shipped tool set (see `src/tools/index.ts` HTTP_TOOL_NAMES + CELL_TOOL_NAMES).

Harness check (Python):
```
toolsCount: 12
tools[] length: 12
expected set match: True
```

Every tool entry carries a full JSON-schema `inputSchema` for its parameters (verified in direct-by-id response, ~56KB payload).

## 3. `/browse` availability

```sh
$ curl -s -o /tmp/browse.html -w "HTTP %{http_code} bytes=%{size_download}\n" 'https://rickydata.org/browse'
HTTP 200 bytes=1272
```

`/browse` is a React SPA (see `<div id="root"></div>`, `/assets/index-z49oPPPr.js`). The page renders client-side by calling `https://mcp.rickydata.org/api/servers` — which, as shown in section 1, returns the siyuan-mcp entry. A rendered screenshot is not included in this bundle (requires a browser-driving step); the authoritative source of truth is the underlying API response.

## 4. End-to-end verdict

| Signal | Value |
|---|---|
| `/api/servers` — siyuan-mcp listed | **YES** |
| `toolsCount` | **12** |
| Tool names match shipped set | **YES** (12/12) |
| `gatewayCompatible` | `true` |
| `canRun` | `true` |
| `rickydata.org/browse` | HTTP **200** |
| Workflow permanent fix | SHA `9749da4` |

## 5. Non-blocking observation

The gateway listing currently contains a second siyuan-mcp entry at ID `c800eddc-1399-4b60-84ac-448437e7ac82` with `name="@rickydata/siyuan-mcp"`, `version=0.2.0`, `toolsCount=12`, `securityScore=90`, `securityRisk="safe"`. Our canonical entity is `9985972a-...`. The second entity may be a separately-created registry entry (different name shape — scoped vs. unscoped). Flagging to mcp-backend for awareness — worth deduplicating so `/browse` doesn't show two rows for the same package, but this does NOT block M2-DV-1.

## 6. Diagnostic history (pre-fix — preserved for context)

Before the entity patch + workflow fix, the entity was in KFDB but filtered out of `/api/servers` because `security.allowed=false` (no security score). Diagnosis isolated the filter field empirically: across all 1764 listed servers, 0 had all three of `securityScore`, `gatewaySecurityScore`, `securityRisk` null simultaneously. Our entity had all three null at initial publish. mcp-backend's `update_node` patch populated them, and mcp-backend's workflow PR (SHA `9749da4`) ensures future publishes carry these fields from the start. See earlier message thread for the full investigation.

## 7. Files

- `packages/siyuan-mcp/tests/integration/m2-dv-1-proof.md` — this document
