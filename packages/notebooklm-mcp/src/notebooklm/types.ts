// ============================================================================
// SHARED TYPES — notebooklm-mcp RPC layer
// ============================================================================

/** A single cookie as stored in a Playwright storageState file. */
export interface StoredCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  /** Unix seconds; -1 (or absent) means a session cookie. */
  expires?: number;
}

/** The minimal shape we read out of a Playwright storageState JSON. */
export interface StorageState {
  cookies?: StoredCookie[];
  [k: string]: unknown;
}

/**
 * Tokens that live in the NotebookLM HTML bootstrap (WIZ_global_data), NOT in
 * cookies. Required on every batchexecute call.
 */
export interface BootstrapTokens {
  /** SNlM0e — the per-session XSRF token, sent as the `at` form field. */
  at: string;
  /** cfb2h — the app build label, sent as the `bl` query param. */
  bl: string;
  /** FdrFJe — the session id, sent as the `f.sid` query param. */
  fsid: string;
}

/** Auth material assembled from cookies, ready to attach to a request. */
export interface AuthHeaders {
  Cookie: string;
  Authorization: string;
  Origin: string;
  "X-Same-Domain": string;
}

/** Result of a single batchexecute RPC: the decoded JSON payload of its frame. */
export interface RpcResult {
  /** The parsed inner payload (the JSON string inside the wrb.fr frame). */
  data: unknown;
  /** The live build label observed on this call (from tokens). */
  bl: string;
}
