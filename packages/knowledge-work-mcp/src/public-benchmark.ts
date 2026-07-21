import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { FailClosedError } from './errors.js';
import { fail, ok } from './response.js';

export type EpochClaim = {
  claim_id: string;
  claim_text: string;
  page_slug?: string | null;
  source_hash: string;
  source_ref: string;
  verification_sources?: Array<{ source_hash: string }>;
};

export type RuntimeEpoch = {
  schema_version: number;
  case_id: string;
  repo: string;
  issue_number: number;
  repository_head_sha: string;
  epoch: {
    epoch_id: string;
    root_hash: string;
    cutoff: string;
    policy_version: string;
    claims: EpochClaim[];
    pages?: Array<{ slug: string; page_hash: string; content_known_at?: string | null; markdown: string }>;
  };
};

type ClientOptions = {
  baseUrl: string;
  token: string;
  runtimeScopeId: string;
  fetchImpl?: typeof fetch;
};

export class EpochBenchClient {
  private cached: Promise<RuntimeEpoch> | null = null;

  constructor(private readonly options: ClientOptions) {
    if (!options.baseUrl || !options.token || !options.runtimeScopeId) {
      throw new FailClosedError('BENCH_API_URL, BENCH_EPOCH_RUNTIME_TOKEN, and RICKYDATA_RUNTIME_SCOPE_ID are required in public benchmark mode.');
    }
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): EpochBenchClient {
    return new EpochBenchClient({
      baseUrl: env.BENCH_API_URL?.trim() || 'https://bench.rickydata.org',
      token: env.BENCH_EPOCH_RUNTIME_TOKEN?.trim() || '',
      runtimeScopeId: env.RICKYDATA_RUNTIME_SCOPE_ID?.trim() || '',
    });
  }

  runtimeEpoch(): Promise<RuntimeEpoch> {
    if (!this.cached) {
      this.cached = this.fetchRuntimeEpoch().catch((error) => {
        this.cached = null;
        throw error;
      });
    }
    return this.cached;
  }

  private async fetchRuntimeEpoch(): Promise<RuntimeEpoch> {
    const url = new URL('/api/internal/benchmarks/prospective/runtime-epoch', this.options.baseUrl).toString();
    const response = await (this.options.fetchImpl ?? fetch)(url, {
      headers: {
        accept: 'application/json',
        'x-internal-epoch-runtime-token': this.options.token,
        'x-rickydata-runtime-scope-id': this.options.runtimeScopeId,
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new FailClosedError(`runtime epoch unavailable (HTTP ${response.status})`);
    const value = await response.json() as RuntimeEpoch;
    if (!value?.case_id || !value?.epoch?.root_hash || !Array.isArray(value.epoch.claims)) {
      throw new FailClosedError('runtime epoch response is incomplete');
    }
    return value;
  }
}

function tokens(value: string): string[] {
  return [...new Set(value.toLowerCase().match(/[a-z0-9_]{2,}/g) ?? [])];
}

export function searchEpochClaims(claims: EpochClaim[], query: string, limit = 5): EpochClaim[] {
  const terms = tokens(query);
  return claims.map((claim) => {
    const haystack = `${claim.claim_text} ${claim.page_slug ?? ''}`.toLowerCase();
    return { claim, score: terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0) };
  }).filter(({ score }) => terms.length === 0 || score > 0)
    .sort((left, right) => right.score - left.score || left.claim.claim_id.localeCompare(right.claim.claim_id))
    .slice(0, Math.max(1, Math.min(limit, 20)))
    .map(({ claim }) => claim);
}

function receipt(runtime: RuntimeEpoch, selected: EpochClaim[]) {
  return {
    case_id: runtime.case_id,
    epoch_id: runtime.epoch.epoch_id,
    epoch_hash: runtime.epoch.root_hash,
    cutoff: runtime.epoch.cutoff,
    repository_head_sha: runtime.repository_head_sha,
    selected_source_hashes: [...new Set(selected.flatMap((claim) => [
      claim.source_hash,
      ...(claim.verification_sources ?? []).map((source) => source.source_hash),
    ]))].sort(),
    taint_policy_version: runtime.epoch.policy_version,
  };
}

export function buildPublicContextPack(runtime: RuntimeEpoch, { query = '', tokenBudget = 2000 } = {}) {
  const selected: EpochClaim[] = [];
  let text = '';
  for (const claim of searchEpochClaims(runtime.epoch.claims, query, runtime.epoch.claims.length || 1)) {
    const line = `- ${claim.claim_text}${claim.page_slug ? ` (${claim.page_slug})` : ''}`;
    if (Math.ceil((text.length + line.length + 1) / 4) > tokenBudget) break;
    selected.push(claim);
    text += `${text ? '\n' : ''}${line}`;
  }
  return { ...receipt(runtime, selected), repo: runtime.repo, claim_count: selected.length, text };
}

type EpochReader = { runtimeEpoch(): Promise<RuntimeEpoch> };

export function registerPublicBenchmarkTools(server: McpServer, client: EpochReader): void {
  server.tool('session_brief', 'Frozen public knowledge available before this benchmark issue opened.', {}, async () => {
    try {
      const runtime = await client.runtimeEpoch();
      const selected = runtime.epoch.claims.slice(0, 20);
      return ok({
        ...receipt(runtime, selected), repo: runtime.repo, issue_number: runtime.issue_number,
        claim_count: runtime.epoch.claims.length, page_count: runtime.epoch.pages?.length ?? 0,
        pages: runtime.epoch.pages ?? [], claims: selected,
      });
    } catch (error) { return fail(error); }
  });

  server.tool('wiki_search', 'Search only verified public claims in this run\'s immutable pre-issue epoch.', {
    query: z.string().min(1).describe('Search query.'),
    limit: z.number().int().min(1).max(20).optional().default(5),
  }, async ({ query, limit }) => {
    try {
      const runtime = await client.runtimeEpoch();
      const claims = searchEpochClaims(runtime.epoch.claims, query, limit);
      return ok({ ...receipt(runtime, claims), claims });
    } catch (error) { return fail(error); }
  });

  server.tool('context_pack', 'Build a bounded context pack from this run\'s immutable pre-issue epoch.', {
    query: z.string().optional().describe('Optional focus query; omit for the full frozen pack.'),
    token_budget: z.number().int().min(200).max(8000).optional().default(2000),
  }, async ({ query, token_budget }) => {
    try { return ok(buildPublicContextPack(await client.runtimeEpoch(), { query, tokenBudget: token_budget })); }
    catch (error) { return fail(error); }
  });

  server.tool('code_context', 'Return epoch-grounded code claims and the exact frozen repository head; never queries a later code index.', {
    task: z.string().min(1).describe('Code question or task.'),
  }, async ({ task }) => {
    try {
      const runtime = await client.runtimeEpoch();
      const claims = searchEpochClaims(runtime.epoch.claims, task, 8);
      return ok({
        ...receipt(runtime, claims),
        repo: runtime.repo,
        index_available: false,
        status: 'frozen_code_index_unavailable',
        instruction: 'Use the checked-out repository at repository_head_sha; these matches are frozen knowledge claims only.',
        claims,
      });
    } catch (error) { return fail(error); }
  });
}
