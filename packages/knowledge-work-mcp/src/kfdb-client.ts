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

type WikiPageRow = {
  slug: string;
  kind: string;
  title: string;
  summary: string;
  bodyMd: string;
  status: string;
  sourceCount: number;
  lastCompiledAt: string;
  compilerVersion: string;
  nodeId: string;
};

type WikiClaimRow = {
  id: string;
  pageSlug: string;
  text: string;
  confidenceTier: string;
  confidenceScore: number;
  status: string;
  sourceRef: string;
  updatedAt: string;
  verified?: boolean;
};

type KnowledgeBundle = {
  pages?: Array<Record<string, unknown>>;
  claims?: Array<Record<string, unknown>>;
  open_questions?: Array<Record<string, unknown>>;
  diagnostics?: Record<string, unknown>;
  reproducibility_hash?: string;
};

type QuestionKind = 'question' | 'assumption' | 'clarification';

type OpenQuestionView = {
  id: string;
  question: string;
  questionKind: QuestionKind;
  answer: string;
  whyItMatters: string;
  category: string;
  sourceRef: string;
  createdAt: string;
  ageDays: number | null;
  rotting: boolean;
  priority: number;
};

type RoadmapItemRow = {
  slug: string;
  name: string;
  status: string;
};

const QUESTION_ROT_DAYS = 14;
const BLOCKING_IN_PROGRESS = 1.0;
const BLOCKING_NEXT = 0.7;
const BLOCKING_BASELINE = 0.2;

const COMPLIMENT_CUES = [
  'do you like',
  'do you love',
  'is this cool',
  'is this a good idea',
  'is it a good idea',
  'would this be good',
  'would it be good',
  'what do you think of',
  'sound good',
];

const HYPOTHETICAL_CUES = [
  'would you',
  'do you think',
  'could it be',
  'should we',
  'should i',
  'in the future',
  'hypothetically',
  'imagine',
  'if you had',
  'if we had',
  'might you',
  'ever want',
  'ever need',
  'would it help',
];

const PAST_BEHAVIOR_CUES = [
  'which ',
  'what did',
  'what was',
  'when did',
  'when was',
  'how did',
  'how many',
  'where did',
  'where is',
  'who ',
  'which wallet',
  'which commit',
  'last time',
];

function unwrap(value: unknown): string | number | boolean | undefined {
  if (value == null || value === 'Null') return undefined;
  if (typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if ('String' in v) {
      const s = v['String'];
      return typeof s === 'string' && s.startsWith('__enc_') ? undefined : (s as string);
    }
    if ('Integer' in v) return v['Integer'] as number;
    if ('Float' in v) return v['Float'] as number;
    if ('Boolean' in v) return v['Boolean'] as boolean;
    return undefined;
  }
  if (typeof value === 'string' && value.startsWith('__enc_')) return undefined;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  return undefined;
}

function unwrapRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    const unwrapped = unwrap(value);
    if (unwrapped !== undefined) out[key] = unwrapped;
  }
  return out;
}

function rowsOf(response: unknown): Record<string, unknown>[] {
  const r = response as { data?: unknown; rows?: unknown };
  const arr = r?.data ?? r?.rows;
  return Array.isArray(arr) ? (arr as Record<string, unknown>[]) : [];
}

function str(row: Record<string, unknown>, key: string): string {
  const value = unwrap(row[key]);
  return typeof value === 'string' ? value : '';
}

function num(row: Record<string, unknown>, key: string): number {
  const value = unwrap(row[key]);
  return typeof value === 'number' ? value : 0;
}

function wikiPageOf(row: Record<string, unknown>): WikiPageRow | null {
  const unwrapped = unwrapRow(row);
  const slug = str(row, 'slug');
  if (!slug || unwrapped['rickydata_wiki_schema_version'] !== 'v1') return null;
  return {
    slug,
    kind: str(row, 'kind'),
    title: str(row, 'title'),
    summary: str(row, 'summary'),
    bodyMd: str(row, 'body_md'),
    status: str(row, 'status') || 'active',
    sourceCount: num(row, 'source_count'),
    lastCompiledAt: str(row, 'last_compiled_at'),
    compilerVersion: str(row, 'compiler_version'),
    nodeId: str(row, '_id'),
  };
}

function wikiClaimOf(row: Record<string, unknown>): WikiClaimRow | null {
  const unwrapped = unwrapRow(row);
  const pageSlug = str(row, 'page_slug');
  if (!pageSlug || unwrapped['rickydata_wiki_schema_version'] !== 'v1') return null;
  return {
    id: str(row, '_id'),
    pageSlug,
    text: str(row, 'text'),
    confidenceTier: str(row, 'confidence_tier'),
    confidenceScore: num(row, 'confidence_score'),
    status: str(row, 'status') || 'active',
    sourceRef: str(row, 'source_ref'),
    updatedAt: str(row, 'updated_at'),
  };
}

function normalizeQuestionKind(raw: string): QuestionKind {
  return raw === 'assumption' || raw === 'clarification' ? raw : 'question';
}

function openQuestionOf(row: Record<string, unknown>, now: Date): OpenQuestionView | null {
  const unwrapped = unwrapRow(row);
  if (!Object.keys(unwrapped).some((key) => !key.startsWith('_'))) return null;
  const id = str(row, '_id') || str(row, 'id');
  if (!id) return null;
  const status = str(row, 'status');
  const answer = str(row, 'answer');
  const violated = status === 'violated';
  const answered = !violated && (status === 'answered' || status === 'resolved' || answer.trim().length > 0);
  if (answered || violated) return null;
  const createdAt = str(row, 'created_at');
  const createdMs = Date.parse(createdAt);
  const ageDays = Number.isNaN(createdMs) ? null : Math.max(0, Math.floor((now.getTime() - createdMs) / 86_400_000));
  return {
    id,
    question: str(row, 'question') || 'Open question',
    questionKind: normalizeQuestionKind(str(row, 'question_kind')),
    answer,
    whyItMatters: str(row, 'why_it_matters') || str(row, 'whyItMatters'),
    category: str(row, 'category'),
    sourceRef: str(row, 'source_ref'),
    createdAt,
    ageDays,
    rotting: ageDays !== null && ageDays > QUESTION_ROT_DAYS,
    priority: num(row, 'priority'),
  };
}

function includesAny(haystack: string, cues: string[]): string | null {
  return cues.find((cue) => haystack.includes(cue)) ?? null;
}

function momTestAnswerability(question: string): {
  score: number;
  phrasing: 'past-behavior' | 'specific' | 'neutral' | 'hypothetical' | 'compliment';
  rewriteHint: string | null;
} {
  const q = question.toLowerCase().trim();
  const compliment = includesAny(q, COMPLIMENT_CUES);
  if (compliment) {
    return {
      score: 0.2,
      phrasing: 'compliment',
      rewriteHint: `Compliment-seeking ("${compliment}") - ask what actually happened instead (for example, "which ... did you use last time", "what broke when ..."). The Mom Test: ask about past behavior, never for approval.`,
    };
  }
  const hypothetical = includesAny(q, HYPOTHETICAL_CUES);
  if (hypothetical) {
    return {
      score: 0.35,
      phrasing: 'hypothetical',
      rewriteHint: `Hypothetical ("${hypothetical}") - the operator can only guess. Rephrase around a concrete past event ("when did X last happen", "which Y did you pick and why").`,
    };
  }
  const past = includesAny(q, PAST_BEHAVIOR_CUES);
  if (past) {
    return { score: 1.0, phrasing: q.startsWith('which') || past.trim() === 'which' ? 'specific' : 'past-behavior', rewriteHint: null };
  }
  return { score: 0.7, phrasing: 'neutral', rewriteHint: null };
}

function computeBlocking(q: OpenQuestionView, items: RoadmapItemRow[]): { blocking: number; refs: string[] } {
  const hay = `${q.question} ${q.answer}`.toLowerCase();
  const inProgress: string[] = [];
  const next: string[] = [];
  for (const item of items) {
    const slug = item.slug.toLowerCase();
    const name = item.name.toLowerCase();
    const mentioned = (slug.length >= 4 && hay.includes(slug)) || (name.length >= 5 && hay.includes(name));
    if (!mentioned) continue;
    if (item.status === 'in_progress') inProgress.push(item.slug);
    else if (item.status === 'accepted') next.push(item.slug);
  }
  if (inProgress.length > 0) return { blocking: BLOCKING_IN_PROGRESS, refs: [...inProgress].sort() };
  if (next.length > 0) return { blocking: BLOCKING_NEXT, refs: [...next].sort() };
  return { blocking: BLOCKING_BASELINE, refs: [] };
}

function computeFreshness(ageDays: number | null): number {
  if (ageDays === null) return 0.3;
  return 0.3 + 0.7 * Math.min(1, ageDays / QUESTION_ROT_DAYS);
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function rankOpenQuestions(questions: OpenQuestionView[], items: RoadmapItemRow[]): Array<Record<string, unknown>> {
  return questions
    .map((q) => {
      const { blocking, refs } = computeBlocking(q, items);
      const gap = 0.5;
      const freshness = computeFreshness(q.ageDays);
      const answerability = momTestAnswerability(q.question);
      const components = {
        blocking: round3(blocking),
        gap: round3(gap),
        freshness: round3(freshness),
        answerability: round3(answerability.score),
      };
      return {
        id: q.id,
        question: q.question,
        questionKind: q.questionKind,
        ageDays: q.ageDays,
        value: round3(blocking * gap * freshness * answerability.score),
        components,
        answerability,
        blockingRefs: refs,
        gapSubjects: [],
        whyItMatters: q.whyItMatters,
        category: q.category,
        sourceRef: q.sourceRef,
        createdAt: q.createdAt,
        rotting: q.rotting,
        priority: q.priority,
      };
    })
    .sort((a, b) => {
      const av = typeof a['value'] === 'number' ? a['value'] : 0;
      const bv = typeof b['value'] === 'number' ? b['value'] : 0;
      const aa = typeof a['ageDays'] === 'number' ? a['ageDays'] : -1;
      const ba = typeof b['ageDays'] === 'number' ? b['ageDays'] : -1;
      return bv - av || ba - aa || String(a['id']).localeCompare(String(b['id']));
    });
}

const SPOKEN_DIGITS: Record<string, string> = {
  '0': 'zero',
  '1': 'one',
  '2': 'two',
  '3': 'three',
  '4': 'four',
  '5': 'five',
  '6': 'six',
  '7': 'seven',
  '8': 'eight',
  '9': 'nine',
};

function voiceSafeDurations(text: string): string {
  return text.replace(/\b(\d+)\.(\d+)s\b/g, (_match, whole: string, fraction: string) => {
    const spokenWhole = whole
      .split('')
      .map((digit) => SPOKEN_DIGITS[digit] ?? digit)
      .join(' ');
    const spokenFraction = fraction
      .split('')
      .map((digit) => SPOKEN_DIGITS[digit] ?? digit)
      .join(' ');
    return `${spokenWhole} point ${spokenFraction} seconds`;
  });
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

  private async queryKql(query: string): Promise<Record<string, unknown>[]> {
    const res = await this.postJson('/api/v1/query', { query }, await this.headersWithOptionalS2D());
    return rowsOf(res);
  }

  async wikiSearch(query: string, limit = 5): Promise<unknown> {
    const bundle = (await this.knowledgeBundle({
      query,
      token_budget: 2500,
      page_limit: Math.max(limit, 5),
      claim_limit: 20,
      include_questions: false,
    })) as KnowledgeBundle;
    const pages = Array.isArray(bundle.pages) ? bundle.pages : [];
    return {
      hits: pages.slice(0, limit).map((page) => ({
        slug: String(page['slug'] ?? ''),
        title: String(page['title'] ?? ''),
        summary: String(page['summary'] ?? ''),
        kind: String(page['kind'] ?? ''),
        score: typeof page['score'] === 'number' ? page['score'] : 0,
        source: 'kfdb_bundle',
        verifiedClaimCount: typeof page['verified_claim_count'] === 'number' ? page['verified_claim_count'] : 0,
        claimCount: typeof page['claim_count'] === 'number' ? page['claim_count'] : 0,
      })),
      fallback: {
        source: 'kfdb_agent_knowledge',
        reason: 'home wiki route unavailable',
        diagnostics: bundle.diagnostics ?? {},
        reproducibility_hash: bundle.reproducibility_hash,
      },
    };
  }

  async wikiPage(slug: string): Promise<unknown> {
    const target = slug.trim();
    const [pageRows, claimRows, bundle] = await Promise.all([
      this.queryKql('MATCH (n:WikiPage) RETURN n.* LIMIT 1000'),
      this.queryKql('MATCH (n:WikiClaim) RETURN n.* LIMIT 2000'),
      this.knowledgeBundle({
        query: target,
        token_budget: 6000,
        page_limit: 10,
        claim_limit: 200,
        include_questions: false,
      }) as Promise<KnowledgeBundle>,
    ]);

    const page = pageRows.map(wikiPageOf).find((p): p is WikiPageRow => p !== null && p.slug === target);
    if (!page) throw new ApiError('kfdb', 404, `wiki page not found: ${target}`);

    const verifiedById = new Map<string, boolean>();
    for (const claim of Array.isArray(bundle.claims) ? bundle.claims : []) {
      const id = String(claim['id'] ?? '');
      if (!id) continue;
      verifiedById.set(id, claim['verified'] === true);
    }

    const claims = claimRows
      .map(wikiClaimOf)
      .filter((claim): claim is WikiClaimRow => claim !== null && claim.pageSlug === target && claim.status !== 'retracted')
      .map((claim) => ({
        ...claim,
        verified: verifiedById.get(claim.id) === true,
      }));

    return {
      page: {
        slug: page.slug,
        title: page.title,
        kind: page.kind,
        summary: page.summary,
        bodyMd: page.bodyMd,
        body_md: page.bodyMd,
        status: page.status,
        sourceCount: page.sourceCount,
        lastCompiledAt: page.lastCompiledAt,
        compilerVersion: page.compilerVersion,
        nodeId: page.nodeId,
      },
      claims,
      verifiedClaimIds: claims.filter((claim) => claim.verified).map((claim) => claim.id),
      history: [],
      backlinks: [],
      fallback: {
        source: 'kfdb_query',
        reason: 'home wiki route unavailable',
        diagnostics: bundle.diagnostics ?? {},
        reproducibility_hash: bundle.reproducibility_hash,
      },
    };
  }

  async trace(kind: string, id: string): Promise<unknown> {
    const traceKind = kind.trim().toLowerCase();
    const target = id.trim();
    if (!target) throw new ApiError('kfdb', 400, 'trace id is required');

    if (traceKind === 'wiki-page' || traceKind === 'wikipage' || traceKind === 'page') {
      return {
        kind: 'wiki-page',
        id: target,
        ...(await this.wikiPage(target) as Record<string, unknown>),
      };
    }

    const claimRows = await this.queryKql('MATCH (n:WikiClaim) RETURN n.* LIMIT 5000');
    const claim = claimRows
      .map(wikiClaimOf)
      .find((row): row is WikiClaimRow => row !== null && row.status !== 'retracted' && (row.id === target || row.sourceRef === target));
    if (!claim) throw new ApiError('kfdb', 404, `wiki claim trace not found: ${target}`);

    const page = await this.wikiPage(claim.pageSlug) as {
      page?: Record<string, unknown>;
      claims?: Array<Record<string, unknown>>;
      verifiedClaimIds?: string[];
      fallback?: Record<string, unknown>;
    };
    const exactClaim = page.claims?.find((row) => row['id'] === claim.id) ?? claim;
    const claimText = String((exactClaim as Record<string, unknown>)['text'] ?? claim.text);
    const verified = Array.isArray(page.verifiedClaimIds) ? page.verifiedClaimIds.includes(claim.id) : Boolean((exactClaim as Record<string, unknown>)['verified']);
    const pageSlug = claim.pageSlug;
    const pageRecord = page.page ?? {};
    const compactPage = {
      slug: typeof pageRecord['slug'] === 'string' ? pageRecord['slug'] : pageSlug,
      title: typeof pageRecord['title'] === 'string' ? pageRecord['title'] : undefined,
      kind: typeof pageRecord['kind'] === 'string' ? pageRecord['kind'] : undefined,
      status: typeof pageRecord['status'] === 'string' ? pageRecord['status'] : undefined,
    };
    const rawAnswer = `${claimText} (page ${pageSlug}; claim ${claim.id}; ${verified ? 'verified' : 'recorded but not yet verified'}).`;
    const answer = voiceSafeDurations(rawAnswer);

    return {
      answer,
      rawAnswer,
      claimText,
      spokenClaimText: voiceSafeDurations(claimText),
      claimId: claim.id,
      pageSlug,
      sourceRef: claim.sourceRef,
      verified,
      kind: 'wiki-claim',
      id: claim.id,
      page: compactPage,
      citation: { pageSlug, claimId: claim.id, verified },
      trace: [
        { label: 'WikiClaim', id: claim.id, sourceRef: claim.sourceRef },
        { label: 'WikiPage', slug: pageSlug },
      ],
      fallback: { source: 'kfdb_trace', reason: 'home trace route unavailable' },
    };
  }

  async nextQuestions(input: { topic?: string; limit: number }): Promise<unknown> {
    const now = new Date();
    const bundle = await this.knowledgeBundle({
      query: input.topic?.trim() || undefined,
      token_budget: 12000,
      page_limit: 1,
      claim_limit: 1,
      include_questions: true,
      question_limit: 500,
    }) as KnowledgeBundle;
    const questionRows = Array.isArray(bundle.open_questions) ? bundle.open_questions : [];
    const topic = input.topic?.trim().toLowerCase();
    const questions = questionRows
      .map((row) => openQuestionOf(row, now))
      .filter((q): q is OpenQuestionView => q !== null)
      .filter((q) => !topic || JSON.stringify(q).toLowerCase().includes(topic));
    const items: RoadmapItemRow[] = [];
    const ranked = rankOpenQuestions(questions, items);

    return {
      ranked: ranked.slice(0, input.limit),
      total_ranked: ranked.length,
      fallback: {
        source: 'kfdb_agent_knowledge',
        reason: 'home next_questions unavailable or empty; ranked the optimized KFDB knowledge-bundle question projection',
        total_open: questions.length,
        ranking: 'value = blocking x gap x freshness x answerability; blocking and gap default to baseline in MCP fallback',
        diagnostics: bundle.diagnostics ?? {},
        reproducibility_hash: bundle.reproducibility_hash,
      },
    };
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
