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
  gatewayJwt?: string | null;
  s2d?: S2DProvider | null;
  fetchImpl?: typeof fetch;
  mintToken?: (opts: MintWalletTokenOptions) => Promise<string>;
  tokenTtlSeconds?: number;
}

/**
 * Undici surfaces its default 300s headers timeout as `TypeError: fetch failed`
 * with a UND_ERR_* cause. Long home endpoints (lint refresh, batch-approve)
 * legitimately outlive it while the server keeps working — callers convert
 * this into a "started, poll for completion" result instead of an error.
 */
function isClientTimeout(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const cause = (err as { cause?: { code?: string } }).cause;
  return typeof cause?.code === 'string' && cause.code.startsWith('UND_ERR');
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
  private readonly gatewayJwt: string | null;
  private readonly s2d: S2DProvider | null;
  private readonly fetchImpl: typeof fetch;
  private readonly mintToken: (opts: MintWalletTokenOptions) => Promise<string>;
  private readonly tokenTtlSeconds?: number;
  private readonly rememberedQueueItems = new Map<string, { item: QueueItem; rememberedAt: number }>();

  constructor(deps: HomeClientDeps) {
    this.baseUrl = deps.baseUrl.replace(/\/$/, '');
    this.signer = deps.signer;
    this.gatewayJwt = deps.gatewayJwt?.trim() || null;
    this.s2d = deps.s2d ?? null;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.mintToken = deps.mintToken ?? defaultMintWalletToken;
    this.tokenTtlSeconds = deps.tokenTtlSeconds;
  }

  private requireSigner(): WalletSigner {
    if (!this.signer) {
      throw new FailClosedError(
        'No Home authorization: set HOME_GATEWAY_JWT or KNOWLEDGE_MCP_PRIVATE_KEY so the MCP can authenticate to rickydata_home. Home-backed tools fail closed.',
      );
    }
    return this.signer;
  }

  private async authHeader(): Promise<string> {
    if (this.gatewayJwt) return `Bearer ${this.gatewayJwt}`;
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

  rememberQueueItems(items: Array<Record<string, unknown>>): void {
    const rememberedAt = Date.now();
    for (const value of items) {
      const id = typeof value['id'] === 'string' ? value['id'].trim() : '';
      const kind = typeof value['kind'] === 'string' ? value['kind'].trim() : '';
      const title = typeof value['title'] === 'string' ? value['title'].trim() : '';
      const sourceRef = value['sourceRef'];
      if (!id || !kind || !title || !sourceRef || typeof sourceRef !== 'object') continue;
      const label = typeof (sourceRef as Record<string, unknown>)['label'] === 'string'
        ? String((sourceRef as Record<string, unknown>)['label']).trim()
        : '';
      const scope = (sourceRef as Record<string, unknown>)['scope'];
      if (!label || (scope !== 'private' && scope !== 'global')) continue;
      const nodeId = typeof (sourceRef as Record<string, unknown>)['nodeId'] === 'string'
        ? String((sourceRef as Record<string, unknown>)['nodeId'])
        : undefined;
      this.rememberedQueueItems.set(id, {
        item: {
          id,
          kind,
          title,
          sourceRef: { label, ...(nodeId ? { nodeId } : {}), scope },
        },
        rememberedAt,
      });
    }
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
    const remembered = this.rememberedQueueItems.get(itemId);
    const item = remembered && Date.now() - remembered.rememberedAt <= 5 * 60_000
      ? remembered.item
      : await this.findQueueItem(itemId);
    if (!item) throw new Error(`pending item not found in live queue: ${itemId}`);
    const result = await this.requestJson('POST', '/api/hitl/decision', {
      item: { id: item.id, kind: item.kind, title: item.title, sourceRef: item.sourceRef },
      action: verdict,
      ...(note?.trim() ? { answer: note.trim() } : {}),
      confidence: 1,
    });
    this.rememberedQueueItems.delete(itemId);
    return result;
  }

  // -------------------------------------------------------------------------
  // Operator lane — depth census, bulk triage, compiler batch-approve, and
  // Knowledge CI status. These are the calls operator sessions kept
  // re-implementing as throwaway scripts (2026-07-09 auto-apply rollout).
  // -------------------------------------------------------------------------

  /**
   * Census the FULL merged queue (not a display page): per-kind counts plus a
   * small filtered sample. `limit` bounds the underlying fetch — keep it above
   * the real queue depth or the census silently undercounts.
   */
  async queueCensus(input: { limit?: number; kind?: string; top?: number } = {}): Promise<unknown> {
    const limit = Math.max(1, Math.min(5000, input.limit ?? 2000));
    const body = await this.requestJson<{ items?: QueueItem[] }>('GET', `/api/hitl/queue?limit=${limit}`);
    const items = Array.isArray(body.items) ? body.items : [];
    const counts: Record<string, number> = {};
    for (const item of items) counts[item.kind] = (counts[item.kind] ?? 0) + 1;
    const kind = input.kind?.trim();
    const filtered = kind ? items.filter((item) => item.kind === kind) : items;
    const top = Math.max(1, Math.min(50, input.top ?? 10));
    return {
      total: items.length,
      fetch_limit: limit,
      truncated: items.length >= limit,
      counts,
      sample_kind: kind || 'all',
      sample: filtered.slice(0, top).map((item) => ({
        id: item.id,
        kind: item.kind,
        title: item.title,
        reason: item.reason ?? '',
        sourceRef: item.sourceRef,
      })),
    };
  }

  /**
   * Bulk park/reject up to 100 queue items in one verified write — the same
   * route the cockpit's bulk triage uses. Approvals are intentionally NOT
   * supported in bulk (wiki diffs must resolve individually).
   */
  async bulkDecide(ids: string[], action: 'park' | 'reject'): Promise<unknown> {
    if (ids.length === 0) throw new Error('ids must be non-empty');
    if (ids.length > 100) throw new Error('at most 100 ids per call — chunk and repeat');
    return this.requestJson('POST', '/api/hitl/decisions/bulk', { ids, action });
  }

  /**
   * Apply every pending LOW-RISK wiki diff (contradictions are never batch-
   * approved). The server loop can outlive the client's fetch timeout; a
   * timeout therefore means "still running", not "failed" — poll queueCensus
   * for wiki_update to hit zero instead of re-firing.
   */
  async batchApproveWikiDiffs(): Promise<unknown> {
    try {
      return await this.requestJson('POST', '/api/wiki/compiler/batch-approve');
    } catch (err) {
      if (isClientTimeout(err)) {
        return {
          started: true,
          client_timeout: true,
          note: 'The server keeps applying diffs after a client timeout. Poll queue_census (kind wiki_update) until it reaches zero; do NOT re-fire immediately.',
        };
      }
      throw err;
    }
  }

  /**
   * Knowledge CI status: knownGood + a findings census (full finding bodies are
   * large; high-severity details are included, med/low are counted). With
   * `refresh` the 16-check run recomputes and can take minutes — a client
   * timeout means the run continues server-side; re-read without refresh.
   */
  async lintStatus(refresh: boolean): Promise<unknown> {
    let body: Record<string, unknown>;
    try {
      body = await this.requestJson<Record<string, unknown>>('GET', `/api/memory/lint${refresh ? '?refresh=1' : ''}`);
    } catch (err) {
      if (refresh && isClientTimeout(err)) {
        return {
          refresh_started: true,
          client_timeout: true,
          note: 'The lint run continues server-side. Re-call with refresh=false in a few minutes to read the completed run.',
        };
      }
      throw err;
    }
    const run = (body['run'] && typeof body['run'] === 'object' ? (body['run'] as Record<string, unknown>) : body);
    const findings = (Array.isArray(body['findings'])
      ? body['findings']
      : Array.isArray(run['findings'])
        ? run['findings']
        : []) as Array<{ check?: string; severity?: string; subjectRef?: string; detail?: string }>;
    const byCheck: Record<string, number> = {};
    for (const finding of findings) {
      const check = String(finding.check ?? 'unknown');
      byCheck[check] = (byCheck[check] ?? 0) + 1;
    }
    return {
      knownGood: run['knownGood'] ?? body['knownGood'] ?? null,
      runId: run['id'] ?? run['runId'] ?? null,
      startedAt: run['startedAt'] ?? null,
      findings_total: findings.length,
      findings_by_check: byCheck,
      high_findings: findings
        .filter((finding) => finding.severity === 'high')
        .map((finding) => ({
          check: finding.check,
          subjectRef: finding.subjectRef,
          detail: (finding.detail ?? '').slice(0, 240),
        })),
    };
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
