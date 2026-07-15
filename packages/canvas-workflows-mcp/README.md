# canvas-workflows-mcp

A narrow, **wallet-scoped, fail-closed** MCP that lets agents drive
[rickydata_home](../../../rickydata_home) canvas workflows through home's
authenticated `/api/canvas/*` routes.

The MCP is a thin remote control: **rickydata_home owns** the `CanvasExecutor`
(remote/local), every `DecisionPack`, Levanto score receipt, durable KFDB run store,
and the HITL approval bridge. By going
through home's HTTP API instead of the gateway directly, the MCP and home's own UI
share **one** execution + persistence path. This server never talks to the Agent
Gateway or KFDB directly and never mints a competing pack or decision identity.

## Auth — the wallet is the boundary (fail closed)

Every request to home carries `Authorization: Bearer <scwt_…>`, an `scwt_` wallet
token minted exactly the way home's `/local-auth/token` does: the operator wallet
EIP-191 personal-signs home's canonical auth message (`buildAuthMessage`), and home's
`verifyWalletToken` recovers the signer. The message format in
[`src/wallet-token.ts`](src/wallet-token.ts) is a byte-compatible port of
`rickydata_home/src/auth/wallet-token.ts` — keep them in sync.

The signing key comes from `CANVAS_MCP_PRIVATE_KEY` and **never** leaves the process
or appears in any tool output. If no wallet/private-key context is present, the home
client is built with `signer: null` and **every tool fails closed** — it throws
`FailClosedError` *before any network egress* and returns an MCP error result. There
is no anonymous fallback.

## Env

| Var                      | Required | Default                 | Purpose                                            |
| ------------------------ | -------- | ----------------------- | -------------------------------------------------- |
| `HOME_API_URL`           | no       | `http://localhost:8788` | Base URL of rickydata_home.                        |
| `CANVAS_MCP_PRIVATE_KEY` | **yes**  | —                       | Operator wallet key; mints the `scwt_` bearer. Absent ⇒ fail closed. |
| `TRANSPORT` / `PORT`     | no       | stdio                   | `TRANSPORT=http` (or any `PORT`) runs HTTP/SSE.    |
| `RESPONSE_MAX_LENGTH`    | no       | `120000`                | Tool response text cap (chars).                    |

## Tools

| Tool               | Input                                                                              | Backed by                                                      |
| ------------------ | ---------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `list_workflows`   | `{}`                                                                                | `GET /api/canvas/workflows`                                   |
| `get_workflow`     | `{ workflowId }`                                                                    | `GET /api/canvas/workflows/:id`                              |
| `save_workflow`    | `{ name, nodes, connections, goal?, target?, localConfig?, remoteConfig? }`        | `POST /api/canvas/workflows`                                 |
| `run_workflow`     | `{ workflowId, target?, inputs? }`                                                  | `POST /api/canvas/runs` (consumes the SSE → compact summary) |
| `get_decision_intelligence` | `{ runId, approvalId }` | `GET /api/canvas/runs/:runId/approvals/:approvalId/intelligence` (compact identity, score, closure) |
| `expand_decision_pack` | `{ runId, approvalId }` | Same canonical Home read, returning the full immutable pack/dossier |
| `resolve_approval` | `{ runId, approvalId, decision, reason?, decisionPackHash?, decisionPackId?, levantoScoreId?, renderedContextHash?, scoreViewedAt?, sessionId?, incompleteContextOverride? }` | `POST /api/canvas/runs/:runId/approvals/:approvalId` |
| `get_run`          | `{ runId }`                                                                         | `GET /api/canvas/runs/:runId`                               |
| `list_runs`        | `{ workflowId? }`                                                                   | `GET /api/canvas/runs`                                       |

`nodes`, `connections`, and the config/inputs objects accept either already-parsed
JSON or a JSON string.

### run_workflow summary

`run_workflow` consumes home's SSE stream to completion and returns a compact
summary instead of the raw event firehose:

```jsonc
{
  "runId": "run-7",
  "status": "completed",              // final run status
  "nodes": [{ "nodeId": "n1", "status": "completed" }],
  "awaitingApprovals": [              // gates still needing a human decision
    { "approvalId": "a1", "nodeId": "n2", "state": "required", "prompt": "ok?" }
  ],
  "text": "…run narration…",
  "eventCount": 6
}
```

Before unblocking a gate, call `get_decision_intelligence` and, when more evidence
is needed, `expand_decision_pack`. Pass the exact observed `decisionPackHash` into
`resolve_approval`; Home rejects stale pack/score/render hashes, records the durable
human decision, and only then resumes the still-open run. If a required producer is
unavailable, resolution instead requires an explicit `incompleteContextOverride`
with a non-empty reason and the named missing sources. Missing both fails closed
before network egress.

## Develop / build / test

```bash
npm install              # from the monorepo root (workspaces)
cd packages/canvas-workflows-mcp
npm run dev              # stdio
TRANSPORT=http PORT=8080 npm run dev
npm run build
npm test                 # vitest unit tests (no running home required)
```

Tools inject `fetch` and the token minter, so the whole surface is unit-tested
without a live rickydata_home: each test asserts the right path/method/body/bearer,
fail-closed behavior when no wallet is present, and SSE-summary parsing from a canned
stream.
