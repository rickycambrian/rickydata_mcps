// ============================================================================
// TOOL DEFINITIONS + HANDLERS — rickydata-bench-mcp
// ============================================================================

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  fetchRuns,
  fetchRecommendations,
  fetchCompare,
  fetchCandidates,
  type BenchRunRow,
} from "./bench.js";
import { sanitizeGoldFields } from "./sanitize.js";

export const TOOL_NAMES = [
  "list_runs",
  "get_run",
  "leaderboard",
  "compare_configs",
  "get_trace_summary",
  "search_tasks",
] as const;

// ---------------------------------------------------------------------------
// Pure helpers (unit-testable, no network)
// ---------------------------------------------------------------------------

export interface LeaderboardEntry {
  config: string;
  displayName?: string;
  observedRows: number;
  scoreableRows: number;
  successes: number;
  successRate: number;
}

/**
 * Build a leaderboard from the recommendations endpoint's observedConfigCoverage.
 * Sorted by successRate desc, then scoreableRows desc.
 */
export function buildLeaderboard(
  recommendations: Record<string, unknown>,
  limit: number,
): LeaderboardEntry[] {
  const coverage = (recommendations.observedConfigCoverage as
    | Array<Record<string, unknown>>
    | undefined) ?? [];
  const entries: LeaderboardEntry[] = coverage.map((c) => {
    const scoreable = Number(c.scoreableRows ?? 0);
    const successes = Number(c.successes ?? 0);
    return {
      config: String(c.config ?? ""),
      displayName: c.displayName as string | undefined,
      observedRows: Number(c.observedRows ?? 0),
      scoreableRows: scoreable,
      successes,
      successRate: scoreable > 0 ? successes / scoreable : 0,
    };
  });
  entries.sort(
    (a, b) =>
      b.successRate - a.successRate || b.scoreableRows - a.scoreableRows,
  );
  return entries.slice(0, Math.max(1, limit));
}

/** Compact projection of a run row (drops verbose attestation/trace blobs). */
export function projectRun(r: BenchRunRow): Record<string, unknown> {
  return {
    run_id: r.run_id,
    repo: r.repo,
    task_id: r.task_id,
    provider: r.provider,
    model: r.model,
    config_name: r.config_name,
    execution_mode: r.execution_mode,
    execution_backend: r.execution_backend,
    quality_score: r.quality_score,
    success: r.success,
    test_passed: r.test_passed,
    verification_level: r.verification_level,
    proof_verified: r.proof_verified,
    duration_seconds: r.duration_seconds,
    actual_cost_usd: r.actual_cost_usd,
    failure_source: r.failure_source,
    failure_category: r.failure_category,
    created_at: r.created_at,
    error: r.error,
  };
}

function clampLimit(v: unknown, def: number, max: number): number {
  const n = typeof v === "number" ? v : def;
  return Math.min(Math.max(1, Math.floor(n)), max);
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const TOOL_DEFS: Tool[] = [
  {
    name: "list_runs",
    description:
      "List recent benchmark runs (newest first), optionally filtered by repository. " +
      "Each row has provider/model/config, quality_score, success, cost, and failure attribution.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Filter by repo, e.g. 'clap-rs/clap'." },
        limit: { type: "number", description: "Max runs (default 20, max 100)." },
        campaign_id: { type: "string", description: "Optional campaign id." },
      },
    },
  },
  {
    name: "get_run",
    description:
      "Fetch a single benchmark run by run_id (including its trace summary). " +
      "Provide the repo for a faster lookup when known.",
    inputSchema: {
      type: "object",
      properties: {
        run_id: { type: "string", description: "The run_id to fetch." },
        repo: { type: "string", description: "Optional repo hint to narrow the search." },
      },
      required: ["run_id"],
    },
  },
  {
    name: "leaderboard",
    description:
      "Rank benchmark configs (provider+model+engine) by observed success rate over scoreable runs. " +
      "Sourced from the public recommendations/coverage endpoint.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max configs (default 20, max 100)." },
        campaign_id: { type: "string", description: "Optional campaign id." },
      },
    },
  },
  {
    name: "compare_configs",
    description:
      "Compare how different configs performed on a single task (repo + issue_number).",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Repository, e.g. 'Textualize/rich'." },
        issue_number: { type: "number", description: "GitHub issue number of the task." },
        limit: { type: "number", description: "Max rows (default 50)." },
      },
      required: ["repo", "issue_number"],
    },
  },
  {
    name: "get_trace_summary",
    description:
      "Get the trace summary for a run (duration, token counts, files changed, verification level, failure attribution). " +
      "Looks the run up by run_id and returns its trace_kg_summary.",
    inputSchema: {
      type: "object",
      properties: {
        run_id: { type: "string", description: "The run_id whose trace summary to fetch." },
        repo: { type: "string", description: "Optional repo hint to narrow the search." },
      },
      required: ["run_id"],
    },
  },
  {
    name: "search_tasks",
    description:
      "List benchmark tasks / candidate issues for a repository (gold-redacted: no fix diff, no fix commit). " +
      "Returns titles, issue numbers, and readiness metadata.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Repository, e.g. 'clap-rs/clap'." },
        limit: { type: "number", description: "Max tasks (default 25, max 100)." },
      },
      required: ["repo"],
    },
  },
];

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function findRunById(
  runId: string,
  repo?: string,
): Promise<BenchRunRow | undefined> {
  // No single-run endpoint exists; scan recent runs (optionally repo-scoped).
  const rows = await fetchRuns({ limit: 200, repo });
  return rows.find((r) => r.run_id === runId);
}

async function handle(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "list_runs": {
      const rows = await fetchRuns({
        limit: clampLimit(args.limit, 20, 100),
        repo: args.repo as string | undefined,
        campaign_id: args.campaign_id as string | undefined,
      });
      return { count: rows.length, runs: rows.map(projectRun) };
    }
    case "get_run": {
      const runId = args.run_id as string;
      if (!runId) return { error: "run_id is required" };
      const run = await findRunById(runId, args.repo as string | undefined);
      if (!run) return { error: `run not found in recent history: ${runId}` };
      return run;
    }
    case "leaderboard": {
      const rec = await fetchRecommendations({
        campaign_id: args.campaign_id as string | undefined,
      });
      return {
        campaign_id: rec.campaignId,
        generated_at: rec.generatedAt,
        leaderboard: buildLeaderboard(rec, clampLimit(args.limit, 20, 100)),
      };
    }
    case "compare_configs": {
      const repo = args.repo as string;
      const issue = args.issue_number;
      if (!repo || typeof issue !== "number") {
        return { error: "repo and numeric issue_number are required" };
      }
      return fetchCompare({
        repo,
        issue_number: issue,
        limit: clampLimit(args.limit, 50, 200),
      });
    }
    case "get_trace_summary": {
      const runId = args.run_id as string;
      if (!runId) return { error: "run_id is required" };
      const run = await findRunById(runId, args.repo as string | undefined);
      if (!run) return { error: `run not found in recent history: ${runId}` };
      return {
        run_id: run.run_id,
        repo: run.repo,
        config_name: run.config_name,
        trace_kg_ref: run.trace_kg_ref,
        trace_summary: run.trace_kg_summary ?? null,
      };
    }
    case "search_tasks": {
      const repo = args.repo as string;
      if (!repo) return { error: "repo is required" };
      return fetchCandidates({ repo, limit: clampLimit(args.limit, 25, 100) });
    }
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

export async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  // Defense-in-depth: never forward a gold field even from a public endpoint.
  return sanitizeGoldFields(await handle(name, args));
}
