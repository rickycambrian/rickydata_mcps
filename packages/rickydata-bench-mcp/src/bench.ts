// ============================================================================
// rickydata_bench public API CLIENT
// ============================================================================
//
// All endpoints here are the public, gold-redacted read endpoints served by
// rickydata_bench (server/benchApi.mjs). This MCP is an ANALYSIS tool and is
// NEVER wired into a benchmark run.

import { BENCH_API_URL } from "./config.js";

async function benchGet(
  path: string,
  params?: Record<string, string | number | undefined>,
): Promise<unknown> {
  const url = new URL(path, BENCH_API_URL);
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`bench API ${res.status}: non-JSON response from ${path}`);
  }
  if (!res.ok) {
    const msg =
      (body as { error?: string })?.error || `${res.status} ${res.statusText}`;
    throw new Error(`bench API error (${path}): ${msg}`);
  }
  return body;
}

export interface BenchRunRow {
  run_id: string;
  task_id?: string;
  repo?: string;
  provider?: string;
  model?: string;
  config_name?: string;
  campaign_id?: string;
  execution_mode?: string;
  execution_backend?: string;
  quality_score?: unknown;
  success?: boolean;
  test_passed?: boolean;
  verification_level?: string;
  duration_seconds?: number;
  actual_cost_usd?: number;
  proof_verified?: boolean;
  failure_source?: string;
  failure_category?: string;
  trace_kg_ref?: string;
  trace_kg_summary?: Record<string, unknown>;
  created_at?: string | number;
  error?: string;
  [k: string]: unknown;
}

/** GET /api/benchmarks/live — recent runs. */
export async function fetchRuns(params: {
  limit?: number;
  repo?: string;
  campaign_id?: string;
}): Promise<BenchRunRow[]> {
  const body = (await benchGet("/api/benchmarks/live", {
    limit: params.limit,
    repo: params.repo,
    campaign_id: params.campaign_id,
  })) as { rows?: BenchRunRow[] };
  return body.rows ?? [];
}

/** GET /api/benchmarks/recommendations — config coverage / leaderboard source. */
export async function fetchRecommendations(params: {
  campaign_id?: string;
}): Promise<Record<string, unknown>> {
  return benchGet("/api/benchmarks/recommendations", {
    campaign_id: params.campaign_id,
  }) as Promise<Record<string, unknown>>;
}

/** GET /api/benchmarks/compare — per-config comparison for one repo+issue. */
export async function fetchCompare(params: {
  repo: string;
  issue_number: number;
  limit?: number;
}): Promise<unknown> {
  return benchGet("/api/benchmarks/compare", {
    repo: params.repo,
    issue_number: params.issue_number,
    limit: params.limit,
  });
}

/** GET /api/benchmarks/candidates — tasks/candidate issues (gold-redacted). */
export async function fetchCandidates(params: {
  repo: string;
  limit?: number;
}): Promise<unknown> {
  return benchGet("/api/benchmarks/candidates", {
    repo: params.repo,
    limit: params.limit,
  });
}

/** GET /api/benchmarks/repositories — repo-level rollups. */
export async function fetchRepositories(): Promise<unknown> {
  return benchGet("/api/benchmarks/repositories");
}
