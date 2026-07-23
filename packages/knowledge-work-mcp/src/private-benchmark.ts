import { createHash } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { FailClosedError } from './errors.js';
import { fail, ok } from './response.js';
import { searchEpochClaims, type EpochClaim } from './public-benchmark.js';

export interface FrozenCodeEntry {
  path: string;
  symbol?: string;
  snippet: string;
  source_hash: string;
}

export interface PrivateRuntimeEpoch {
  schema_version: number;
  trial_id: string;
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
  code_index?: {
    index_hash: string;
    repository_head_sha: string;
    entries: FrozenCodeEntry[];
  };
}

interface PrivateClientOptions {
  baseUrl: string;
  token: string;
  runtimeScopeId: string;
  fetchImpl?: typeof fetch;
}

export class PrivateBenchmarkClient {
  private cached: Promise<PrivateRuntimeEpoch> | null = null;

  constructor(private readonly options: PrivateClientOptions) {
    if (!options.baseUrl || !options.token || !options.runtimeScopeId) {
      throw new FailClosedError(
        'HOME_API_URL, HOME_BENCH_RUNTIME_TOKEN, and RICKYDATA_RUNTIME_SCOPE_ID are required in private benchmark mode.',
      );
    }
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): PrivateBenchmarkClient {
    return new PrivateBenchmarkClient({
      baseUrl: env.HOME_API_URL?.trim() || 'https://rickydata-home-2dbp4scmrq-uc.a.run.app',
      token: env.HOME_BENCH_RUNTIME_TOKEN?.trim() || '',
      runtimeScopeId: env.RICKYDATA_RUNTIME_SCOPE_ID?.trim() || '',
    });
  }

  runtimeEpoch(): Promise<PrivateRuntimeEpoch> {
    if (!this.cached) {
      this.cached = this.fetchRuntimeEpoch().catch((error) => {
        this.cached = null;
        throw error;
      });
    }
    return this.cached;
  }

  private async fetchRuntimeEpoch(): Promise<PrivateRuntimeEpoch> {
    const url = new URL('/internal/live-work/runtime-epoch', this.options.baseUrl).toString();
    const response = await (this.options.fetchImpl ?? fetch)(url, {
      headers: {
        accept: 'application/json',
        'x-internal-live-work-runtime-token': this.options.token,
        'x-rickydata-runtime-scope-id': this.options.runtimeScopeId,
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new FailClosedError(`private runtime epoch unavailable (HTTP ${response.status})`);
    const value = await response.json() as PrivateRuntimeEpoch;
    if (
      !value?.trial_id ||
      !value?.repository_head_sha ||
      !value?.epoch?.root_hash ||
      !Array.isArray(value.epoch.claims)
    ) {
      throw new FailClosedError('private runtime epoch response is incomplete');
    }
    if (value.code_index && value.code_index.repository_head_sha !== value.repository_head_sha) {
      throw new FailClosedError('private runtime code index is not bound to the frozen repository head');
    }
    return value;
  }
}

type EpochReader = { runtimeEpoch(): Promise<PrivateRuntimeEpoch> };

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(',')}}`;
}

function receipt(runtime: PrivateRuntimeEpoch, selectedSourceHashes: string[]) {
  return {
    trial_id: runtime.trial_id,
    epoch_id: runtime.epoch.epoch_id,
    epoch_hash: runtime.epoch.root_hash,
    cutoff: runtime.epoch.cutoff,
    repository_head_sha: runtime.repository_head_sha,
    selected_source_hashes: [...new Set(selectedSourceHashes)].sort(),
    taint_policy_version: runtime.epoch.policy_version,
  };
}

function sourcedClaims(claims: EpochClaim[]): string[] {
  return claims.flatMap((claim) => [
    claim.source_hash,
    ...(claim.verification_sources ?? []).map((source) => source.source_hash),
  ]);
}

function response(payload: Record<string, unknown>): Record<string, unknown> {
  return {
    ...payload,
    response_hash: createHash('sha256').update(canonicalJson(payload)).digest('hex'),
  };
}

function searchCode(entries: FrozenCodeEntry[], query: string, limit = 8): FrozenCodeEntry[] {
  const terms = [...new Set(query.toLowerCase().match(/[a-z0-9_]{2,}/g) ?? [])];
  return entries
    .map((entry) => ({
      entry,
      score: terms.reduce(
        (total, term) => total + (`${entry.path} ${entry.symbol ?? ''} ${entry.snippet}`.toLowerCase().includes(term) ? 1 : 0),
        0,
      ),
    }))
    .filter(({ score }) => terms.length === 0 || score > 0)
    .sort((left, right) => right.score - left.score || left.entry.path.localeCompare(right.entry.path))
    .slice(0, limit)
    .map(({ entry }) => entry);
}

export function registerPrivateBenchmarkTools(server: McpServer, client: EpochReader): void {
  server.tool('session_brief', 'Frozen private knowledge admitted before this live-work trial enrolled.', {}, async () => {
    try {
      const runtime = await client.runtimeEpoch();
      const claims = runtime.epoch.claims.slice(0, 20);
      return ok(response({
        ...receipt(runtime, sourcedClaims(claims)),
        repo: runtime.repo,
        issue_number: runtime.issue_number,
        claim_count: runtime.epoch.claims.length,
        page_count: runtime.epoch.pages?.length ?? 0,
        pages: runtime.epoch.pages ?? [],
        claims,
      }));
    } catch (error) { return fail(error); }
  });

  server.tool('wiki_search', 'Search only claims in this trial\'s immutable private epoch.', {
    query: z.string().min(1).describe('Search query.'),
    limit: z.number().int().min(1).max(20).optional().default(5),
  }, async ({ query, limit }) => {
    try {
      const runtime = await client.runtimeEpoch();
      const claims = searchEpochClaims(runtime.epoch.claims, query, limit);
      return ok(response({ ...receipt(runtime, sourcedClaims(claims)), claims }));
    } catch (error) { return fail(error); }
  });

  server.tool('context_pack', 'Build a bounded pack from this trial\'s immutable private epoch.', {
    query: z.string().optional().describe('Optional focus query.'),
    token_budget: z.number().int().min(200).max(8000).optional().default(2000),
  }, async ({ query, token_budget }) => {
    try {
      const runtime = await client.runtimeEpoch();
      const claims = searchEpochClaims(runtime.epoch.claims, query ?? '', runtime.epoch.claims.length || 1);
      const selected: EpochClaim[] = [];
      let text = '';
      for (const claim of claims) {
        const line = `- ${claim.claim_text}${claim.page_slug ? ` (${claim.page_slug})` : ''}`;
        if (Math.ceil((text.length + line.length + 1) / 4) > token_budget) break;
        selected.push(claim);
        text += `${text ? '\n' : ''}${line}`;
      }
      return ok(response({
        ...receipt(runtime, sourcedClaims(selected)),
        repo: runtime.repo,
        claim_count: selected.length,
        text,
      }));
    } catch (error) { return fail(error); }
  });

  server.tool('code_context', 'Search only the code index bound to this trial\'s frozen repository head.', {
    task: z.string().min(1).describe('Code question or task.'),
  }, async ({ task }) => {
    try {
      const runtime = await client.runtimeEpoch();
      if (!runtime.code_index) {
        throw new FailClosedError('frozen code index unavailable');
      }
      const entries = searchCode(runtime.code_index.entries, task);
      return ok(response({
        ...receipt(runtime, entries.map((entry) => entry.source_hash)),
        repo: runtime.repo,
        index_hash: runtime.code_index.index_hash,
        entries,
      }));
    } catch (error) { return fail(error); }
  });
}
