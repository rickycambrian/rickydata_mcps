// ============================================================================
// CONFIGURATION — environment variables
// ============================================================================

export const KFDB_API_URL =
  process.env.KFDB_API_URL || "http://34.60.37.158";

export const KFDB_API_KEY = process.env.KFDB_API_KEY || "";

/**
 * Whether an API key is configured. The call-graph tools (get_callers /
 * get_callees) hit the tenant-authenticated /api/v1/graph/ego endpoint and only
 * work with a key. When absent we omit them from tools/list entirely so an agent
 * is never offered a tool that can only error — keeps the bench treatment arm's
 * tool-usage signal clean.
 */
export const HAS_API_KEY = KFDB_API_KEY.length > 0;

/**
 * Bench mode scope. When set, the server runs in hardened bench mode:
 *  - only the five scoped code-navigation tools are registered
 *  - every upstream call is forced to repo_scope=[BENCH_REPO_SCOPE] + strict_scope=true
 *  - ego-graph seeds are restricted to node_ids previously returned in-session
 *  - responses are run through the gold-field sanitizer
 *
 * A valid value is a repo_id (UUID) of a pinned snapshot corpus.
 */
export const BENCH_REPO_SCOPE = (process.env.KFDB_BENCH_REPO_SCOPE || "").trim();

export const IS_BENCH_MODE = BENCH_REPO_SCOPE.length > 0;

/** Whole-response character cap. */
export const RESPONSE_MAX_LENGTH = parseInt(
  process.env.RESPONSE_MAX_LENGTH || "200000",
  10,
);

/**
 * Per-snippet character cap. Agents already have the repo checked out locally,
 * so these tools rank/locate rather than deliver file contents. Keeping
 * snippets short also shrinks the leak surface in bench mode.
 */
export const SNIPPET_MAX_LENGTH = parseInt(
  process.env.SNIPPET_MAX_LENGTH || "400",
  10,
);
