// ============================================================================
// CONFIGURATION — environment variables
// ============================================================================

export const KFDB_API_URL =
  process.env.KFDB_API_URL || "http://34.60.37.158";

export const KFDB_API_KEY = process.env.KFDB_API_KEY || "";

/**
 * Explicit, opt-in key for the call-graph tools in BENCH MODE. Bench mode never
 * trusts the ambient KFDB_API_KEY for tool registration or auth — a sloppy
 * runner with KFDB_API_KEY in its environment must NOT silently promote the
 * keyless 3-tool surface to 5 tools (that would flip the experiment arm). The
 * call-graph tools light up under bench mode ONLY when this explicit var is set.
 */
export const KFDB_BENCH_TOOLS_API_KEY =
  process.env.KFDB_BENCH_TOOLS_API_KEY || "";

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

/**
 * Whether the call-graph tools (get_callers / get_callees) are available. They
 * hit the tenant-authenticated /api/v1/graph/ego endpoint and need a key.
 *
 *  - BENCH MODE: gated SOLELY on the explicit KFDB_BENCH_TOOLS_API_KEY. The
 *    ambient KFDB_API_KEY is deliberately ignored so an env-leaked runner key
 *    cannot flip the 3-tool keyless arm into a 5-tool arm.
 *  - FULL MODE: gated on KFDB_API_KEY as before.
 *
 * When absent the two ego tools are omitted from tools/list entirely so an
 * agent is never offered a tool that can only error.
 */
export const EGO_TOOLS_ENABLED = IS_BENCH_MODE
  ? KFDB_BENCH_TOOLS_API_KEY.length > 0
  : KFDB_API_KEY.length > 0;

/**
 * The key the ego endpoint authenticates with. In bench mode this is the
 * explicit bench-tools key (never the ambient KFDB_API_KEY); in full mode it is
 * KFDB_API_KEY.
 */
export const EGO_API_KEY = IS_BENCH_MODE
  ? KFDB_BENCH_TOOLS_API_KEY
  : KFDB_API_KEY;

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
