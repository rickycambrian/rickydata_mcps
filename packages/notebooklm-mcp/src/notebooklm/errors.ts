// ============================================================================
// TYPED ERRORS — notebooklm-mcp
// ============================================================================
//
// Every failure mode the RPC client can hit is a distinct class so the tool
// layer can map it to an actionable message (and /health can reflect auth state)
// instead of leaking a raw 401/HTML blob to the agent.

/** Base class so callers can `instanceof NotebookLMError` to catch any of ours. */
export class NotebookLMError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * No usable Google session. Either NOTEBOOKLM_COOKIES / state.json is missing,
 * or it has no critical auth cookies. The fix is always "run connect".
 */
export class NotConnectedError extends NotebookLMError {
  constructor(
    message = "Not connected to NotebookLM. Run `npx @rickydata/notebooklm-mcp connect` to log in (deployed: re-run connect for this wallet).",
  ) {
    super(message);
  }
}

/**
 * The session WAS present but Google rejected it (401/403 or a login-page
 * redirect on an authenticated RPC). Distinct from NotConnectedError: cookies
 * exist locally but are revoked/expired server-side — only a live call reveals
 * this. The fix is to re-run connect.
 */
export class AuthExpiredError extends NotebookLMError {
  constructor(
    message = "NotebookLM session expired or was revoked by Google. Re-run `npx @rickydata/notebooklm-mcp connect` to refresh the session.",
  ) {
    super(message);
  }
}

/** Google returned 429 / a quota signal. */
export class RateLimitError extends NotebookLMError {
  constructor(message = "NotebookLM rate-limited the request (HTTP 429). Back off and retry later.") {
    super(message);
  }
}

/** Local hard ceiling (per-process daily generation cap) tripped before any call. */
export class DailyLimitError extends NotebookLMError {
  constructor(limit: number) {
    super(
      `Local daily NotebookLM generation ceiling reached (${limit}/day). This guards against account flags; raise NOTEBOOKLM_DAILY_LIMIT only if you understand the risk.`,
    );
  }
}

/**
 * The batchexecute envelope or the wrb.fr frame for an rpcid did not parse —
 * NotebookLM most likely changed the contract or the build (`bl`). Names the
 * action + rpcid + live `bl` and the one-line repair command.
 */
export class ContractBrokenError extends NotebookLMError {
  readonly action: string;
  readonly rpcid: string;
  readonly bl: string | null;
  constructor(action: string, rpcid: string, bl: string | null, detail: string) {
    super(
      `NotebookLM RPC contract broken for "${action}" (rpcid=${rpcid}, live bl=${bl ?? "unknown"}): ${detail}. ` +
        `Re-capture with: npm run capture -- --action=${action}`,
    );
    this.action = action;
    this.rpcid = rpcid;
    this.bl = bl;
  }
}

/** A tool was requested whose rpcid has not been captured yet (TODO_CAPTURE). */
export class NotCapturedError extends NotebookLMError {
  constructor(action: string) {
    super(
      `Action "${action}" is not available yet: its NotebookLM rpcid has not been captured. ` +
        `Capture it with: npm run capture -- --action=${action}`,
    );
  }
}
