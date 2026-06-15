# @rickydata/notebooklm-mcp

A robust, deployable MCP server for **NotebookLM** — create notebooks, add
sources, generate + download **Audio Overviews** (the NotebookLM podcast) — driven
by NotebookLM's internal **`batchexecute` RPC API** instead of DOM scraping.

## Why RPC, not a browser

The popular `notebooklm-mcp` engines automate a headed Chrome and scrape the UI.
That breaks every time NotebookLM reshuffles its layout, and a stealth-browser-
per-wallet is neither robust nor deployable on shared infra. This server instead
calls the same authenticated RPC endpoint the web app uses:

```
POST notebooklm.google.com/_/LabsTailwindUi/data/batchexecute?rpcids=<ID>&bl=<build>&f.sid=<sid>…
  f.req = [[[ "<rpcid>", "<JSON payload>", null, "generic" ]]]
  at    = <XSRF token>
```

Runtime is **pure `fetch`** — no browser, no DOM selectors, no page-load waits
(NotebookLM's persistent SSE means `networkidle` never fires; irrelevant here).
A browser is needed **only once**, for login (the `connect` helper).

## Auth model (per-wallet, encrypted)

Each user's Google session is captured once and stored **encrypted per-wallet** in
the gateway vault (secret `NOTEBOOKLM_STATE_B64`, sharing policy `isolated`,
AES-256-GCM). The gateway injects it into that wallet's container at runtime. This
is the **same secret** the `rickydata notebook-studio connect` CLI already
uploads, so this server is a **drop-in replacement** for the DOM-scraping engine:
a wallet that already connected is authenticated with no re-login.

Auth source priority at runtime:
`NOTEBOOKLM_COOKIES` (raw JSON) → `NOTEBOOKLM_STATE_B64` (base64 JSON, vault) →
local `state.json` → `not_connected` error.

On every request the client sends the 9 critical Google cookies **plus** a
`SAPISIDHASH` `Authorization` header, `Origin`, and `X-Same-Domain: 1` (cookie-
only Google requests 401). Three more tokens (`at`, `bl`, `f.sid`) live in the
page's `WIZ_global_data` bootstrap, not in cookies, and are fetched once + cached.

## Tools

Only actions whose rpcid + payload have been **captured + verified** against
live NotebookLM are exposed in `tools/list` (so an agent is never offered a tool
that can only error). Verified live on `bl=…_20260609.22_p0` (2026-06-15):

| Tool | Status | rpcid |
|---|---|---|
| `add_source` (text) | ✅ verified | `izAoDd` |
| `generate_audio` | ✅ verified | `R7cb6c` |
| `get_audio_status` | ✅ verified | `gArtLc` |
| `download_audio` (authorize) | ✅ verified | `HpN0Ub` |
| `create_notebook`, `list_notebooks`, `ask_question` | ⏳ `TODO_CAPTURE` | — |

Agent flow: `add_source` (returns `source_id`) → `generate_audio` with those
`source_ids` (returns `artifact_id`) → poll `get_audio_status` → `download_audio`
with the `artifact_id` (no server-side long-poll).

**Note on `download_audio`:** `HpN0Ub` is the download-*authorize* call — it keys
on the audio **artifact id** and returns an empty frame. NotebookLM then streams
the bytes via a browser download navigation whose signed URL is not exposed to
page JS. That URL is captured via Playwright's `download` event (see
`capture.ts` → `fixtures/download_audio.media.json`); wiring it into the runtime
is the one remaining step for headless byte retrieval.

## Usage

```bash
# One-time login (opens a browser):
npx @rickydata/notebooklm-mcp connect            # local → state.json
npx @rickydata/notebooklm-mcp connect --deploy   # + upload to the wallet vault

# Run the server:
npx @rickydata/notebooklm-mcp                    # stdio (default)
TRANSPORT=http PORT=8080 npx @rickydata/notebooklm-mcp   # HTTP + /health
```

`GET /health?probe=1` makes one authenticated request to confirm the session is
live **server-side** (cookies can look valid locally while Google has revoked
them) and reports `auth`, `contract_version`, `captured_bl`, and the live `bl`.

## Keeping the RPC contract current

NotebookLM can change rpcids or the build (`bl`) silently. This package treats
that as a first-class concern:

- **`src/notebooklm/rpc.ts`** is the versioned single source of truth (rpcid +
  encode/decode per action).
- **`npm run capture -- --action=<name>`** opens a browser with your session,
  records every `batchexecute` call you trigger into committable, redacted
  fixtures (`fixtures/<rpcid>.{request,response}.txt` + `rpc.capture.json`).
  `--parse-har=<file>` extracts the same from a DevTools HAR.
- **`npm run capture -- --verify`** is a canary: it replays the known rpcids
  against live NotebookLM and fails on contract drift, reporting the live `bl`.
- A broken contract raises `ContractBrokenError` naming the action, rpcid, live
  `bl`, and the exact repair command.

## Limits & safety

A per-process **daily generation ceiling** (`NOTEBOOKLM_DAILY_LIMIT`, default 50)
guards against account flags. When a signed media URL is available, `inline=true`
(under `NOTEBOOKLM_MAX_INLINE_BYTES`) returns the audio as base64.

This uses an unofficial API; the design surfaces breakage clearly and the
own-pipeline path remains a fallback.

## Development

```bash
npm run build   # tsc (excludes src/dev — Playwright is dev-only, never in prod)
npm run test    # vitest: envelope/parse/codec/auth vs committed fixtures
```

See `.env.example` for all configuration.
