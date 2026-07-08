import {
  mintWalletToken as defaultMintWalletToken,
  type MintWalletTokenOptions,
  type WalletSigner,
} from './wallet-token.js';
import { ApiError, FailClosedError } from './errors.js';
import { stableVoiceId } from './ids.js';
import type { S2DProvider } from './s2d.js';

export interface HomeClientDeps {
  baseUrl: string;
  signer: WalletSigner | null;
  s2d?: S2DProvider | null;
  fetchImpl?: typeof fetch;
  mintToken?: (opts: MintWalletTokenOptions) => Promise<string>;
  tokenTtlSeconds?: number;
}

type SourceRef = { label: string; nodeId?: string; scope: 'private' | 'global' };
type QueueItem = {
  id: string;
  kind: string;
  title: string;
  reason?: string;
  sourceRef: SourceRef;
  confidence?: number;
  evidence?: unknown;
};

export class HomeKnowledgeClient {
  private readonly baseUrl: string;
  private readonly signer: WalletSigner | null;
  private readonly s2d: S2DProvider | null;
  private readonly fetchImpl: typeof fetch;
  private readonly mintToken: (opts: MintWalletTokenOptions) => Promise<string>;
  private readonly tokenTtlSeconds?: number;

  constructor(deps: HomeClientDeps) {
    this.baseUrl = deps.baseUrl.replace(/\/$/, '');
    this.signer = deps.signer;
    this.s2d = deps.s2d ?? null;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.mintToken = deps.mintToken ?? defaultMintWalletToken;
    this.tokenTtlSeconds = deps.tokenTtlSeconds;
  }

  private requireSigner(): WalletSigner {
    if (!this.signer) {
      throw new FailClosedError(
        'No operator wallet context: set KNOWLEDGE_MCP_PRIVATE_KEY so the MCP can mint the scwt_ wallet token rickydata_home requires. Home-backed tools fail closed.',
      );
    }
    return this.signer;
  }

  private async authHeader(): Promise<string> {
    const signer = this.requireSigner();
    const token = await this.mintToken({
      address: signer.address,
      signFn: (m) => signer.signMessage(m),
      ttlSeconds: this.tokenTtlSeconds,
    });
    return `Bearer ${token}`;
  }

  private async requiredS2DHeaders(): Promise<Record<string, string>> {
    if (!this.s2d) {
      throw new FailClosedError(
        'No sign-to-derive session provider: set KNOWLEDGE_MCP_PRIVATE_KEY so home tools can read wallet-private data. Home-backed tools fail closed.',
      );
    }
    const creds = await this.s2d.ensure();
    if (!creds) throw new FailClosedError('Sign-to-derive session unavailable; refusing home request before network egress.');
    return {
      'x-derive-session-id': creds.sessionId,
      'x-derive-key': creds.keyHex,
    };
  }

  private async requestJson<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        accept: 'application/json',
        authorization: await this.authHeader(),
        ...(await this.requiredS2DHeaders()),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new ApiError('home', res.status, text);
    return text ? (JSON.parse(text) as T) : ({} as T);
  }

  wikiSearch(query: string, limit = 5): Promise<unknown> {
    const qs = new URLSearchParams({ q: query, limit: String(limit) });
    return this.requestJson('GET', `/api/wiki/search?${qs.toString()}`);
  }

  wikiPage(slug: string): Promise<unknown> {
    return this.requestJson('GET', `/api/wiki/${encodeURIComponent(slug)}`);
  }

  contextPack(input: { surface?: string; task?: string; repo?: string; budget: number }): Promise<unknown> {
    const present = [input.surface, input.task, input.repo].filter((v) => v?.trim()).length;
    if (present !== 1) throw new Error('context_pack requires exactly one of surface, task, or repo');
    const qs = new URLSearchParams({ budget: String(input.budget), consumer: 'voice-knowledge-partner' });
    if (input.surface?.trim()) qs.set('surface', input.surface.trim());
    if (input.task?.trim()) qs.set('task', input.task.trim());
    if (input.repo?.trim()) qs.set('repo', input.repo.trim());
    return this.requestJson('GET', `/api/context-pack?${qs.toString()}`);
  }

  trace(kind: string, id: string): Promise<unknown> {
    const qs = new URLSearchParams({ kind, id });
    return this.requestJson('GET', `/api/knowledge/trace?${qs.toString()}`);
  }

  async nextQuestions(input: { topic?: string; limit: number }): Promise<unknown> {
    const body = await this.requestJson<{ ranked?: Array<Record<string, unknown>> }>('GET', '/api/memory/questions?ranked=1');
    const topic = input.topic?.trim().toLowerCase();
    const ranked = Array.isArray(body.ranked) ? body.ranked : [];
    const filtered = topic
      ? ranked.filter((q) => JSON.stringify(q).toLowerCase().includes(topic))
      : ranked;
    return { ranked: filtered.slice(0, input.limit), total_ranked: ranked.length };
  }

  async reviewPending(limit = 5): Promise<unknown> {
    const body = await this.requestJson<{ items?: QueueItem[] }>('GET', `/api/hitl/queue?limit=${Math.max(1, Math.min(50, limit))}`);
    const items = Array.isArray(body.items) ? body.items : [];
    const counts: Record<string, number> = {};
    for (const item of items) counts[item.kind] = (counts[item.kind] ?? 0) + 1;
    return {
      counts,
      items: items.slice(0, limit).map((item) => ({
        id: item.id,
        kind: item.kind,
        title: item.title,
        reason: item.reason ?? '',
        sourceRef: item.sourceRef,
      })),
    };
  }

  private async findQueueItem(itemId: string): Promise<QueueItem | null> {
    const body = await this.requestJson<{ items?: QueueItem[] }>('GET', '/api/hitl/queue?limit=200');
    return (Array.isArray(body.items) ? body.items : []).find((item) => item.id === itemId) ?? null;
  }

  async recordAnswer(questionId: string, answer: string): Promise<unknown> {
    const item =
      (await this.findQueueItem(questionId)) ?? {
        id: questionId,
        kind: 'open_question',
        title: `Open question ${questionId}`,
        sourceRef: { label: 'OpenQuestion', nodeId: questionId, scope: 'private' as const },
      };
    return this.requestJson('POST', '/api/hitl/decision', {
      item: { id: item.id, kind: item.kind, title: item.title, sourceRef: item.sourceRef },
      action: 'answer',
      answer,
      confidence: 1,
    });
  }

  async resolveItem(itemId: string, verdict: 'approve' | 'reject', note?: string): Promise<unknown> {
    const item = await this.findQueueItem(itemId);
    if (!item) throw new Error(`pending item not found in live queue: ${itemId}`);
    return this.requestJson('POST', '/api/hitl/decision', {
      item: { id: item.id, kind: item.kind, title: item.title, sourceRef: item.sourceRef },
      action: verdict,
      ...(note?.trim() ? { answer: note.trim() } : {}),
      confidence: 1,
    });
  }

  async captureDecision(input: { decision: string; context?: string; sessionId?: string }): Promise<unknown> {
    const decision = input.decision.trim();
    if (!decision) throw new Error('decision is required');
    const id = `voice-decision:${stableVoiceId('decision', [input.sessionId, input.context, decision])}`;
    const title = input.context?.trim() ? `Voice decision: ${input.context.trim()}` : 'Voice decision';
    return this.requestJson('POST', '/api/hitl/decision', {
      item: {
        id,
        kind: 'voice_decision',
        title,
        sourceRef: { label: 'VoiceDecision', nodeId: id, scope: 'private' },
      },
      action: 'answer',
      answer: decision,
      confidence: 1,
    });
  }
}
