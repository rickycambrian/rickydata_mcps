// ============================================================================
// CONFIGURATION — notebooklm-mcp
// ============================================================================

/**
 * Bumped whenever the captured RPC contract (rpcids / payload shapes) changes in
 * a way clients should notice. Surfaced in /health and the canary.
 */
export const CONTRACT_VERSION = "2026.06.1";

/** Origin of the NotebookLM web app (also the SAPISIDHASH origin). */
export const NOTEBOOKLM_ORIGIN = (
  process.env.NOTEBOOKLM_ORIGIN || "https://notebooklm.google.com"
).replace(/\/$/, "");

/** The batchexecute app segment: /_/<APP>/data/batchexecute. */
export const NOTEBOOKLM_APP = process.env.NOTEBOOKLM_APP || "LabsTailwindUi";

/** Vault-injected (per-wallet) Google session JSON. Empty in local dev. */
export const NOTEBOOKLM_COOKIES_ENV = process.env.NOTEBOOKLM_COOKIES || "";

/**
 * Base64-encoded storageState JSON — the secret the existing `rickydata
 * notebook-studio connect` flow uploads to the gateway vault (key
 * NOTEBOOKLM_STATE_B64). Reading it here makes this RPC server a DROP-IN
 * replacement for the DOM-scraping notebooklm-mcp: a wallet that already ran
 * connect is authenticated with no re-login.
 */
export const NOTEBOOKLM_STATE_B64_ENV = process.env.NOTEBOOKLM_STATE_B64 || "";

/** Explicit path to a Playwright storageState file (local dev override). */
export const NOTEBOOKLM_STATE_PATH = process.env.NOTEBOOKLM_STATE_PATH || "";

/**
 * Gateway vault identity for the per-wallet session secret. Defaults to the
 * established notebook-studio serverId so this server reuses sessions already
 * uploaded by `rickydata notebook-studio connect`. Override at deploy time if
 * this MCP is registered under its own MCPServer id.
 */
export const VAULT_SERVER_ID =
  process.env.NOTEBOOKLM_SERVER_ID || "1834da3e-8ba4-43b2-b8ea-b7207570f2e0";

/** The vault secret key carrying the base64 storageState. */
export const VAULT_SECRET_NAME = "NOTEBOOKLM_STATE_B64";

/**
 * The build label (`bl`) captured alongside the verified rpcids. Informational —
 * the live value is refreshed by bootstrapTokens() at runtime — but surfaced in
 * /health so contract drift against the captured baseline is visible.
 */
export const CAPTURED_BL = process.env.NOTEBOOKLM_BL || "boq_labs-tailwind-frontend_20260601.00_p0";

/** Hard per-process daily ceiling on generate calls (account-flag guard). */
export const DAILY_LIMIT = parseInt(process.env.NOTEBOOKLM_DAILY_LIMIT || "50", 10);

/** Max bytes to inline as base64 from download_audio before returning URL-only. */
export const MAX_INLINE_BYTES = parseInt(
  process.env.NOTEBOOKLM_MAX_INLINE_BYTES || String(20 * 1024 * 1024),
  10,
);

/** Whole-response character cap (mirrors kfdb-code-mcp). */
export const RESPONSE_MAX_LENGTH = parseInt(
  process.env.RESPONSE_MAX_LENGTH || "200000",
  10,
);

// ── Gateway vault (connect helper, deploy path) ─────────────────────────────
export const GATEWAY_URL = (process.env.GATEWAY_URL || "https://mcp.rickydata.org").replace(/\/$/, "");
export const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN || "";
