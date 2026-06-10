// ============================================================================
// KFDB API CLIENT — kfdb-code-mcp (read-only code intelligence)
// ============================================================================

import {
  KFDB_API_URL,
  KFDB_API_KEY,
  BENCH_REPO_SCOPE,
  IS_BENCH_MODE,
} from "./config.js";

async function kfdbFetch(
  path: string,
  options?: RequestInit,
): Promise<Response> {
  const url = `${KFDB_API_URL}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(KFDB_API_KEY ? { Authorization: `Bearer ${KFDB_API_KEY}` } : {}),
    ...((options?.headers as Record<string, string>) || {}),
  };
  return fetch(url, { ...options, headers });
}

// ---------------------------------------------------------------------------
// Scope enforcement
// ---------------------------------------------------------------------------
//
// In bench mode we IGNORE any caller-supplied scope and force the request onto
// the single pinned-corpus repo_id with strict_scope. Outside bench mode the
// caller's optional scope is passed through unchanged. This is the only place
// scope is decided, so no tool handler can widen it.

/**
 * Pure scope-resolution. Exposed (with explicit bench params) so it can be
 * unit-tested without import-time env. Bench mode IGNORES the caller scope and
 * forces the single pinned corpus + strict_scope. The production wrapper below
 * binds the env-derived bench flag/scope.
 */
export function resolveScopePayload(
  base: Record<string, unknown>,
  callerScope: string[] | undefined,
  isBench: boolean,
  benchScope: string,
): Record<string, unknown> {
  if (isBench) {
    return { ...base, repo_scope: [benchScope], strict_scope: true };
  }
  if (callerScope && callerScope.length > 0) {
    return { ...base, repo_scope: callerScope };
  }
  return base;
}

export function scopedSearchPayload(
  base: Record<string, unknown>,
  callerScope?: string[],
): Record<string, unknown> {
  return resolveScopePayload(base, callerScope, IS_BENCH_MODE, BENCH_REPO_SCOPE);
}

// ---------------------------------------------------------------------------
// Code intelligence endpoints
// ---------------------------------------------------------------------------

export interface CodeSearchHit {
  node_id: string;
  label: string;
  file_path: string;
  name: string | null;
  score: number;
  stream_hits?: string[];
  content: string | null;
  start_line: number | null;
  end_line: number | null;
  properties?: Record<string, unknown>;
}

export interface CodeSearchResponse {
  results: CodeSearchHit[];
  total: number;
  retrieval_mode?: string;
  diagnostics?: Record<string, unknown>;
}

/** POST /api/v1/code-search — multi-stream (fts + dense + symbol + graph) RRF fusion. */
export async function codeSearch(args: {
  query: string;
  limit?: number;
  repo_scope?: string[];
  include_graph?: boolean;
  lambda_struct?: number;
}): Promise<CodeSearchResponse> {
  const base: Record<string, unknown> = {
    query: args.query,
    limit: args.limit ?? 10,
  };
  if (args.include_graph !== undefined) base.include_graph = args.include_graph;
  if (args.lambda_struct !== undefined) base.lambda_struct = args.lambda_struct;

  const payload = scopedSearchPayload(base, args.repo_scope);
  const res = await kfdbFetch("/api/v1/code-search", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`code-search failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as CodeSearchResponse;
}

export interface ContextBundleResponse {
  evidence_items?: Array<Record<string, unknown>>;
  [k: string]: unknown;
}

/** POST /api/v1/agent/context — orchestrated code search + graph + tests. */
export async function contextBundle(args: {
  query: string;
  repo_scope?: string[];
  token_budget?: number;
  evidence_limit?: number;
  include_tests?: boolean;
  include_graph?: boolean;
}): Promise<ContextBundleResponse> {
  const base: Record<string, unknown> = { query: args.query };
  if (args.token_budget !== undefined) base.token_budget = args.token_budget;
  if (args.evidence_limit !== undefined) base.evidence_limit = args.evidence_limit;
  if (args.include_tests !== undefined) base.include_tests = args.include_tests;
  if (args.include_graph !== undefined) base.include_graph = args.include_graph;

  const payload = scopedSearchPayload(base, args.repo_scope);
  const res = await kfdbFetch("/api/v1/agent/context", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`context-bundle failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as ContextBundleResponse;
}

export interface EgoGraphResponse {
  nodes?: Array<Record<string, unknown>>;
  edges?: Array<Record<string, unknown>>;
  [k: string]: unknown;
}

/**
 * POST /api/v1/graph/ego — k-hop subgraph around a node.
 * Requires a valid KFDB_API_KEY (tenant-scoped endpoint). The seed node_id
 * allowlist check is enforced by the caller (tool handler) in bench mode.
 */
export async function egoGraph(args: {
  node_id: string;
  depth?: number;
  edge_type?: string;
  max_nodes?: number;
  direction?: string;
}): Promise<EgoGraphResponse> {
  if (!KFDB_API_KEY) {
    throw new Error(
      "graph/ego requires KFDB_API_KEY (authenticated endpoint); call navigation tools without it disabled, or set the key.",
    );
  }
  const body: Record<string, unknown> = {
    node_id: args.node_id,
    depth: args.depth ?? 2,
    max_nodes: args.max_nodes ?? 200,
  };
  if (args.edge_type) body.edge_type = args.edge_type;
  if (args.direction) body.direction = args.direction;

  const res = await kfdbFetch("/api/v1/graph/ego", {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`graph/ego failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as EgoGraphResponse;
}

// ---------------------------------------------------------------------------
// Non-bench discovery endpoints (NOT registered in bench mode)
// ---------------------------------------------------------------------------

/** GET /api/v1/entities/Repository — repo listing (requires KFDB_API_KEY). */
export async function listRepositories(limit = 50): Promise<unknown> {
  const res = await kfdbFetch(`/api/v1/entities/Repository?limit=${limit}`);
  if (!res.ok) {
    throw new Error(`list repositories failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}
