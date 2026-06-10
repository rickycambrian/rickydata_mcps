// ============================================================================
// TOOL DEFINITIONS + HANDLERS — kfdb-code-mcp
// ============================================================================

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  codeSearch,
  contextBundle,
  egoGraph,
  listRepositories,
  type CodeSearchHit,
} from "./kfdb.js";
import { sanitizeGoldFields } from "./sanitize.js";
import { rememberNodeIds, isNodeIdAllowed } from "./session.js";
import { IS_BENCH_MODE, SNIPPET_MAX_LENGTH } from "./config.js";

// The five tools available under bench mode (read-only code navigation only).
export const SCOPED_TOOL_NAMES = [
  "search_code",
  "find_symbol",
  "get_callers",
  "get_callees",
  "get_context_bundle",
] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncateSnippet(text: string | null | undefined): string | null {
  if (text == null) return null;
  if (text.length <= SNIPPET_MAX_LENGTH) return text;
  return text.slice(0, SNIPPET_MAX_LENGTH) + " …(truncated)";
}

/** Project a code-search hit into a compact, snippet-capped result. */
function projectHit(hit: CodeSearchHit): Record<string, unknown> {
  return {
    node_id: hit.node_id || null,
    label: hit.label,
    file_path: hit.file_path,
    name: hit.name,
    start_line: hit.start_line,
    end_line: hit.end_line,
    score: hit.score,
    stream_hits: hit.stream_hits,
    snippet: truncateSnippet(hit.content),
  };
}

/** Record node_ids from hits so they can later seed ego graphs (bench allowlist). */
function rememberHits(hits: CodeSearchHit[]): void {
  rememberNodeIds(hits.map((h) => h.node_id).filter(Boolean));
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOL_DEFS: Tool[] = [
  {
    name: "search_code",
    description:
      "Search code across the indexed corpus by meaning and keyword (multi-stream: semantic + full-text + symbol + call-graph, RRF-fused). " +
      "Returns ranked file/function hits with short snippets and line ranges. Use this to locate where a concept, function, or behavior lives.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural-language or keyword query." },
        limit: { type: "number", description: "Max results (default 10, max 30)." },
        repo_scope: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional list of repo_ids to restrict to. Ignored in bench mode (scope is forced).",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "find_symbol",
    description:
      "Locate a specific named symbol (function, type, test) by name. Returns the best-matching definitions with file paths and line ranges. " +
      "Use when you know the identifier and want its definition site.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Symbol name to find (function/type/identifier)." },
        limit: { type: "number", description: "Max results (default 10, max 30)." },
        repo_scope: {
          type: "array",
          items: { type: "string" },
          description: "Optional repo_id scope. Ignored in bench mode.",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "get_callers",
    description:
      "Find functions that CALL a given node (incoming call edges, k-hop). " +
      "The node_id must come from a prior search_code / find_symbol / get_context_bundle result. " +
      "Requires the server to be configured with a KFDB API key.",
    inputSchema: {
      type: "object",
      properties: {
        node_id: { type: "string", description: "node_id of the target symbol (from a prior search result)." },
        depth: { type: "number", description: "Hops to traverse (default 1, max 2)." },
        max_nodes: { type: "number", description: "Max nodes to return (default 100)." },
      },
      required: ["node_id"],
    },
  },
  {
    name: "get_callees",
    description:
      "Find functions CALLED BY a given node (outgoing call edges, k-hop). " +
      "The node_id must come from a prior search_code / find_symbol / get_context_bundle result. " +
      "Requires the server to be configured with a KFDB API key.",
    inputSchema: {
      type: "object",
      properties: {
        node_id: { type: "string", description: "node_id of the source symbol (from a prior search result)." },
        depth: { type: "number", description: "Hops to traverse (default 1, max 2)." },
        max_nodes: { type: "number", description: "Max nodes to return (default 100)." },
      },
      required: ["node_id"],
    },
  },
  {
    name: "get_context_bundle",
    description:
      "Assemble a ranked evidence bundle for a task or question: relevant code locations plus optional related tests and graph context. " +
      "Use at the start of a task to orient yourself before diving into files.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The task or question to gather context for." },
        evidence_limit: { type: "number", description: "Max evidence items (default 10)." },
        token_budget: { type: "number", description: "Soft token budget for the bundle (default 4000)." },
        include_tests: { type: "boolean", description: "Include related test candidates (default true)." },
        repo_scope: {
          type: "array",
          items: { type: "string" },
          description: "Optional repo_id scope. Ignored in bench mode.",
        },
      },
      required: ["query"],
    },
  },
  // ── Discovery tools (NOT available in bench mode) ──────────────────────────
  {
    name: "list_repos",
    description:
      "List indexed repositories with their repo_ids. Use to discover what corpora are available. Not available in bench mode.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max repos (default 50)." },
      },
    },
  },
  {
    name: "repo_overview",
    description:
      "High-level overview of a repository: a context bundle seeded with the repo's purpose. Not available in bench mode.",
    inputSchema: {
      type: "object",
      properties: {
        repo_id: { type: "string", description: "repo_id to summarize." },
        query: { type: "string", description: "Optional focus for the overview." },
      },
      required: ["repo_id"],
    },
  },
];

// ---------------------------------------------------------------------------
// Tool list (filtered by mode)
// ---------------------------------------------------------------------------

/** The tools to expose given the current mode. Bench mode → only scoped 5. */
export function buildToolList(): Tool[] {
  if (IS_BENCH_MODE) {
    const allowed = new Set<string>(SCOPED_TOOL_NAMES);
    return TOOL_DEFS.filter((t) => allowed.has(t.name));
  }
  return TOOL_DEFS;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function clampLimit(v: unknown, def: number, max: number): number {
  const n = typeof v === "number" ? v : def;
  return Math.min(Math.max(1, Math.floor(n)), max);
}

async function handleSearchCode(args: Record<string, unknown>): Promise<unknown> {
  const query = args.query as string;
  if (!query) return { error: "query is required" };
  const res = await codeSearch({
    query,
    limit: clampLimit(args.limit, 10, 30),
    repo_scope: args.repo_scope as string[] | undefined,
  });
  rememberHits(res.results);
  return {
    query,
    total: res.total,
    retrieval_mode: res.retrieval_mode,
    dense_method: (res.diagnostics as Record<string, unknown> | undefined)?.dense_method,
    results: res.results.map(projectHit),
  };
}

async function handleFindSymbol(args: Record<string, unknown>): Promise<unknown> {
  const name = args.name as string;
  if (!name) return { error: "name is required" };
  // Symbol lookup rides the same multi-stream endpoint; the symbol stream
  // matches identifier names. Querying the bare name biases toward definitions.
  const res = await codeSearch({
    query: name,
    limit: clampLimit(args.limit, 10, 30),
    repo_scope: args.repo_scope as string[] | undefined,
  });
  rememberHits(res.results);
  const symbols = res.results
    .filter((h) => h.name || h.label === "Function" || h.label === "TypeDefinition")
    .map(projectHit);
  return { name, total: symbols.length, symbols };
}

async function handleEgo(
  args: Record<string, unknown>,
  direction: "incoming" | "outgoing",
): Promise<unknown> {
  // Strict string guard: a non-string node_id (array/object) must never reach
  // the allowlist check or the upstream request. Reject anything but a string.
  if (typeof args.node_id !== "string" || args.node_id.length === 0) {
    return { error: "node_id is required and must be a string" };
  }
  const nodeId = args.node_id;

  // Bench-mode seed allowlist: only ids previously returned by a scoped call.
  if (IS_BENCH_MODE && !isNodeIdAllowed(nodeId)) {
    return {
      error:
        "node_id not permitted: ego-graph seeds must come from a prior search_code / find_symbol / get_context_bundle result in this session.",
    };
  }

  const res = await egoGraph({
    node_id: nodeId,
    depth: clampLimit(args.depth, 1, 2),
    max_nodes: clampLimit(args.max_nodes, 100, 500),
    edge_type: "CALLS",
    direction,
  });
  // Remember any newly surfaced node_ids so the agent can chain navigation.
  const ids: string[] = [];
  for (const n of res.nodes ?? []) {
    const id = (n as Record<string, unknown>).node_id ?? (n as Record<string, unknown>).id;
    if (typeof id === "string") ids.push(id);
  }
  rememberNodeIds(ids);
  return res;
}

async function handleContextBundle(args: Record<string, unknown>): Promise<unknown> {
  const query = args.query as string;
  if (!query) return { error: "query is required" };
  const res = await contextBundle({
    query,
    evidence_limit: clampLimit(args.evidence_limit, 10, 30),
    token_budget: typeof args.token_budget === "number" ? args.token_budget : 4000,
    include_tests: args.include_tests as boolean | undefined,
    repo_scope: args.repo_scope as string[] | undefined,
  });
  // Cap snippets + remember evidence node_ids.
  const items = (res.evidence_items ?? []).map((it) => {
    const m = it as Record<string, unknown>;
    const id = m.node_id;
    if (typeof id === "string" && id) rememberNodeIds([id]);
    return { ...m, content: truncateSnippet(m.content as string | null | undefined) };
  });
  return { ...res, evidence_items: items };
}

async function handleListRepos(args: Record<string, unknown>): Promise<unknown> {
  const limit = clampLimit(args.limit, 50, 500);
  return listRepositories(limit);
}

async function handleRepoOverview(args: Record<string, unknown>): Promise<unknown> {
  const repoId = args.repo_id as string;
  if (!repoId) return { error: "repo_id is required" };
  const query = (args.query as string) || "overview: purpose, entry points, and main modules";
  return contextBundle({ query, repo_scope: [repoId], evidence_limit: 12 });
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  // Hard gate: in bench mode, only scoped tools may execute, even if a client
  // somehow asks for a discovery tool that was filtered from tools/list.
  if (IS_BENCH_MODE && !SCOPED_TOOL_NAMES.includes(name as (typeof SCOPED_TOOL_NAMES)[number])) {
    return { error: `tool "${name}" is not available in bench mode` };
  }

  let result: unknown;
  switch (name) {
    case "search_code":
      result = await handleSearchCode(args);
      break;
    case "find_symbol":
      result = await handleFindSymbol(args);
      break;
    case "get_callers":
      result = await handleEgo(args, "incoming");
      break;
    case "get_callees":
      result = await handleEgo(args, "outgoing");
      break;
    case "get_context_bundle":
      result = await handleContextBundle(args);
      break;
    case "list_repos":
      result = await handleListRepos(args);
      break;
    case "repo_overview":
      result = await handleRepoOverview(args);
      break;
    default:
      return { error: `Unknown tool: ${name}` };
  }

  // Final independent sanitizer pass: drop any gold-field keys that slipped
  // through, regardless of server-side redaction state.
  return sanitizeGoldFields(result);
}
