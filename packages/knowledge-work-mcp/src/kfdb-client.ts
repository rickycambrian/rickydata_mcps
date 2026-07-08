import { ApiError, FailClosedError } from './errors.js';
import type { S2DProvider } from './s2d.js';
import type { WriteRequest } from './atoms.js';

export interface KfdbClientDeps {
  baseUrl: string;
  apiKey: string;
  walletAddress?: string;
  s2d?: S2DProvider | null;
  fetchImpl?: typeof fetch;
}

export interface SemanticSearchInput {
  query: string;
  labels: string[];
  minSimilarity: number;
  limit: number;
}

export class KfdbKnowledgeClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly walletAddress?: string;
  private readonly s2d: S2DProvider | null;
  private readonly fetchImpl: typeof fetch;

  constructor(deps: KfdbClientDeps) {
    this.baseUrl = deps.baseUrl.replace(/\/$/, '');
    this.apiKey = deps.apiKey;
    this.walletAddress = deps.walletAddress?.toLowerCase();
    this.s2d = deps.s2d ?? null;
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  private baseHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      'content-type': 'application/json',
      authorization: `Bearer ${this.apiKey}`,
      'x-client-id': 'knowledge-work-mcp',
    };
    if (this.walletAddress) headers['x-wallet-address'] = this.walletAddress;
    return headers;
  }

  private async headersWithOptionalS2D(): Promise<Record<string, string>> {
    const headers = this.baseHeaders();
    if (!this.s2d) return headers;
    try {
      const creds = await this.s2d.ensure();
      if (!creds) return headers;
      headers['x-wallet-address'] = creds.walletAddress || headers['x-wallet-address'] || '';
      headers['x-derive-session-id'] = creds.sessionId;
      headers['x-derive-key'] = creds.keyHex;
      return headers;
    } catch {
      return headers;
    }
  }

  private async headersWithRequiredS2D(): Promise<Record<string, string>> {
    if (!this.s2d) {
      throw new FailClosedError(
        'No sign-to-derive session provider: set KNOWLEDGE_MCP_PRIVATE_KEY so capture tools can encrypt writes at rest. Reads may run without S2D; writes fail closed.',
      );
    }
    const creds = await this.s2d.ensure();
    if (!creds) {
      throw new FailClosedError('Sign-to-derive session unavailable; refusing capture before network egress.');
    }
    return {
      ...this.baseHeaders(),
      'x-wallet-address': creds.walletAddress,
      'x-derive-session-id': creds.sessionId,
      'x-derive-key': creds.keyHex,
    };
  }

  private async postJson<T>(path: string, body: unknown, headers: Record<string, string>): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new ApiError('kfdb', res.status, text);
    return text ? (JSON.parse(text) as T) : ({} as T);
  }

  async knowledgeBundle(params: {
    query?: string;
    token_budget?: number;
    page_limit?: number;
    claim_limit?: number;
    include_questions?: boolean;
    question_limit?: number;
  }): Promise<unknown> {
    return this.postJson('/api/v1/agent/knowledge', params, await this.headersWithOptionalS2D());
  }

  async semanticSearch(input: SemanticSearchInput): Promise<unknown> {
    const labels = input.labels.length > 0 ? input.labels : ['WikiPage', 'OpenQuestion', 'HomeDecision', 'RoadmapItem'];
    const headers = await this.headersWithOptionalS2D();
    const results = await Promise.all(
      labels.map(async (label) => {
        const body = {
          query: input.query,
          label,
          limit: input.limit,
          threshold: input.minSimilarity,
        };
        try {
          return { label, ok: true, result: await this.postJson('/api/v1/semantic/search', body, headers) };
        } catch (err) {
          return { label, ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      }),
    );
    return { query: input.query, min_similarity: input.minSimilarity, labels: results };
  }

  async codeContext(params: { task: string; repo?: string }): Promise<unknown> {
    const body: Record<string, unknown> = {
      query: params.task,
      token_budget: 8000,
      include_tests: true,
      include_graph: true,
      evidence_limit: 10,
    };
    if (params.repo?.trim()) body['repo_scope'] = [params.repo.trim()];
    return this.postJson('/api/v1/agent/context', body, await this.headersWithOptionalS2D());
  }

  async writeData(request: WriteRequest): Promise<unknown> {
    return this.postJson('/api/v1/write', request, await this.headersWithRequiredS2D());
  }
}

export function loadKfdbClientFromEnv(
  env: Record<string, string | undefined>,
  s2d: S2DProvider | null,
): KfdbKnowledgeClient | null {
  const baseUrl = env.KFDB_API_URL?.trim();
  const apiKey = env.KFDB_API_KEY?.trim();
  if (!baseUrl || !apiKey) return null;
  return new KfdbKnowledgeClient({
    baseUrl,
    apiKey,
    walletAddress: env.KFDB_WALLET_ADDRESS?.trim() || env.X_WALLET_ADDRESS?.trim(),
    s2d,
  });
}
