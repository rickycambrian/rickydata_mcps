import { createHash } from 'node:crypto';
import { ApiError, FailClosedError } from './errors.js';
import type { S2DProvider } from './s2d.js';
import type { WriteRequest } from './atoms.js';

/**
 * When KFDB rejects a request because the sign-to-derive session is invalid
 * (revoked or expired), rewrite the error into actionable guidance: the fix
 * is reconnecting on the agent page, not retrying.
 */
export function decorateS2DRejection(error: ApiError): ApiError {
  const isAuthStatus = error.status === 401 || error.status === 403;
  if (!isAuthStatus || !/sign-to-derive|derive session/i.test(error.body)) return error;
  return new ApiError(
    error.service,
    error.status,
    error.body,
    `s2d_unavailable: the sign-to-derive session was rejected by KFDB (revoked or expired). ` +
      `Reconnect your second brain on the agent page to mint a new session. Original: ${error.body.slice(0, 200)}`,
  );
}

export interface KfdbClientDeps {
  baseUrl: string;
  apiKey?: string;
  walletAddress?: string;
  requestWalletAddress?: string;
  s2d?: S2DProvider | null;
  requireS2D?: boolean;
  s2dProvenance?: 'delegated-static' | 'legacy-wallet' | 'injected';
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
  authority?: Record<string, unknown>;
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

type PendingWikiReviewItem = {
  id: string;
  kind: 'wiki_update' | 'wiki_contradiction';
  title: string;
  reason: string;
  sourceRef: { label: 'RickydataWikiCompilerRun'; nodeId: string; scope: 'private' };
};

const QUESTION_ROT_DAYS = 14;
const BLOCKING_IN_PROGRESS = 1.0;
const BLOCKING_NEXT = 0.7;
const BLOCKING_BASELINE = 0.2;
const TRANSIENT_READ_STATUSES = new Set([429, 502, 503, 504]);
const TRANSIENT_READ_RETRY_DELAY_MS = 250;

function missingCompoundIdentifierQueries(task: string, result: unknown): string[] {
  const resultText = JSON.stringify(result).toLowerCase();
  const identifiers = task.match(/\b[A-Z][a-z0-9]+(?:[A-Z][A-Za-z0-9]*)+\b/g) ?? [];
  return [...new Set(identifiers)]
    .filter((identifier) => !resultText.includes(identifier.toLowerCase()))
    .map((identifier) => `${identifier} schema contract`);
}

function codeEvidenceKey(item: unknown): string {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return JSON.stringify(item);
  const value = item as Record<string, unknown>;
  return String(value['node_id'] ?? `${value['file_path'] ?? ''}:${value['name'] ?? ''}:${value['start_line'] ?? ''}`);
}

function mergeCodeContextResults(primary: unknown, supplements: unknown[], queries: string[]): unknown {
  if (!primary || typeof primary !== 'object' || Array.isArray(primary)) return primary;
  const value = primary as Record<string, unknown>;
  const evidence = [primary, ...supplements].flatMap((result) => {
    if (!result || typeof result !== 'object' || Array.isArray(result)) return [];
    const items = (result as Record<string, unknown>)['evidence_items'];
    return Array.isArray(items) ? items : [];
  });
  const seen = new Set<string>();
  const mergedEvidence = evidence.filter((item) => {
    const key = codeEvidenceKey(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const primaryDiagnostics = value['diagnostics'] && typeof value['diagnostics'] === 'object'
    ? value['diagnostics'] as Record<string, unknown>
    : {};
  const totalMs = [primary, ...supplements].reduce<number>((sum, result) => {
    if (!result || typeof result !== 'object' || Array.isArray(result)) return sum;
    const diagnostics = (result as Record<string, unknown>)['diagnostics'];
    if (!diagnostics || typeof diagnostics !== 'object' || Array.isArray(diagnostics)) return sum;
    const duration = (diagnostics as Record<string, unknown>)['total_ms'];
    return sum + (typeof duration === 'number' ? duration : 0);
  }, 0);
  return {
    ...value,
    evidence_items: mergedEvidence,
    diagnostics: {
      ...primaryDiagnostics,
      evidence_count: mergedEvidence.length,
      query_expansions: queries,
      ...(totalMs > 0 ? { total_ms: totalMs } : {}),
    },
  };
}

function filterScopedGraphNeighborhoods(
  input: unknown,
  allowedRepoIds: Set<string>,
): { neighborhoods: Record<string, unknown>[]; nodesDropped: number; edgesDropped: number } {
  const rawNeighborhoods = Array.isArray(input) ? input : [];
  const neighborhoods: Record<string, unknown>[] = [];
  let nodesDropped = 0;
  let edgesDropped = 0;

  for (const rawNeighborhood of rawNeighborhoods) {
    if (!rawNeighborhood || typeof rawNeighborhood !== 'object' || Array.isArray(rawNeighborhood)) continue;
    const neighborhood = rawNeighborhood as Record<string, unknown>;
    const rawNodes = Array.isArray(neighborhood['nodes']) ? neighborhood['nodes'] : [];
    const scopedNodes = rawNodes.filter((rawNode) => {
      if (!rawNode || typeof rawNode !== 'object' || Array.isArray(rawNode)) return false;
      const node = rawNode as Record<string, unknown>;
      const properties = node['properties'];
      if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return false;
      return allowedRepoIds.has(String((properties as Record<string, unknown>)['repo_id'] ?? ''));
    });
    nodesDropped += rawNodes.length - scopedNodes.length;

    const scopedNodeIds = new Set(scopedNodes.map((node) => String((node as Record<string, unknown>)['id'] ?? '')));
    const seedNodeId = String(neighborhood['seed_node_id'] ?? '');
    const rawEdges = Array.isArray(neighborhood['edges']) ? neighborhood['edges'] : [];
    if (!seedNodeId || !scopedNodeIds.has(seedNodeId)) {
      nodesDropped += scopedNodes.length;
      edgesDropped += rawEdges.length;
      continue;
    }

    const scopedEdges = rawEdges.filter((rawEdge) => {
      if (!rawEdge || typeof rawEdge !== 'object' || Array.isArray(rawEdge)) return false;
      const edge = rawEdge as Record<string, unknown>;
      return scopedNodeIds.has(String(edge['from_node'] ?? ''))
        && scopedNodeIds.has(String(edge['to_node'] ?? ''));
    });
    edgesDropped += rawEdges.length - scopedEdges.length;
    neighborhoods.push({ ...neighborhood, nodes: scopedNodes, edges: scopedEdges });
  }

  return { neighborhoods, nodesDropped, edgesDropped };
}

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

function containsCiphertext(value: unknown): boolean {
  if (typeof value === 'string') return value.startsWith('__enc_');
  if (Array.isArray(value)) return value.some(containsCiphertext);
  if (value && typeof value === 'object') return Object.values(value as Record<string, unknown>).some(containsCiphertext);
  return false;
}

function assertNoCiphertext(value: unknown, surface: string): void {
  if (containsCiphertext(value)) {
    throw new FailClosedError(`KFDB ciphertext boundary violation in ${surface}; refusing to return undecrypted private data.`);
  }
}

function str(row: Record<string, unknown>, key: string): string {
  const value = unwrap(row[key]);
  return typeof value === 'string' ? value : '';
}

function num(row: Record<string, unknown>, key: string): number {
  const value = unwrap(row[key]);
  return typeof value === 'number' ? value : 0;
}

function firstString(row: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = unwrap(row[key]);
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function semanticNodeId(filePath: string, entity: Record<string, unknown>): string {
  const entityId = firstString(entity, ['_id', 'id', 'node_id']);
  if (entityId) return entityId;
  const uriTarget = filePath.split('://')[1]?.split('/')[0]?.trim();
  return uriTarget || '';
}

function boundedSemanticTitle(value: string, maxLength = 160): { title: string; truncated: boolean } {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return { title: normalized, truncated: false };
  return { title: `${normalized.slice(0, maxLength - 1)}…`, truncated: true };
}

function projectSemanticHit(hit: unknown, requestedLabel: string): Record<string, unknown> {
  const value = hit && typeof hit === 'object' ? hit as Record<string, unknown> : {};
  const properties = value['properties'] && typeof value['properties'] === 'object'
    ? value['properties'] as Record<string, unknown>
    : {};
  const entity = value['entity'] && typeof value['entity'] === 'object'
    ? value['entity'] as Record<string, unknown>
    : {};
  const filePath = firstString(properties, ['file_path']);
  const entityLabel = firstString(properties, ['entity_label']) || requestedLabel;
  const nodeId = semanticNodeId(filePath, entity);
  const slug = firstString(entity, ['slug', 'page_slug', 'roadmap_slug']) || nodeId;
  const sourceTitle = firstString(entity, ['title', 'name', 'question', 'summary', 'objective', 'decision']);
  const sourceSummary = firstString(entity, [
    'summary',
    'why_it_matters',
    'whyItMatters',
    'description',
    'objective',
    'decision',
    'answer',
    'question',
    'text',
  ]);
  const titleProjection = boundedSemanticTitle(sourceTitle || `${entityLabel} ${slug || 'result'}`);
  const title = titleProjection.title;
  const summary = (sourceSummary || title).replace(/\s+/g, ' ').trim().slice(0, 200);
  return {
    node_id: nodeId,
    embedding_id: typeof value['id'] === 'string' ? value['id'] : '',
    entity_label: entityLabel,
    file_path: filePath,
    repo_id: firstString(properties, ['repo_id']),
    labels: Array.isArray(value['labels']) ? value['labels'] : [entityLabel],
    similarity: typeof value['similarity'] === 'number' ? value['similarity'] : 0,
    title,
    summary,
    slug,
    ...(titleProjection.truncated ? { title_truncated: true } : {}),
    ...(sourceTitle || sourceSummary ? {} : { content_null: true }),
  };
}

function projectSemanticResponse(response: unknown, requestedLabel: string): Record<string, unknown> {
  const value = response && typeof response === 'object' ? response as Record<string, unknown> : {};
  const results = Array.isArray(value['results']) ? value['results'] : [];
  return {
    ...value,
    results: results.map((hit) => projectSemanticHit(hit, requestedLabel)),
  };
}

function pendingWikiReviewItems(rows: Record<string, unknown>[]): PendingWikiReviewItem[] {
  const runs = rows
    .map(unwrapRow)
    .sort((a, b) => str(b, 'started_at').localeCompare(str(a, 'started_at')));
  const byPage = new Map<string, PendingWikiReviewItem>();

  for (const run of runs) {
    const runId = str(run, 'run_id');
    const runNodeId = str(run, '_id');
    if (!runId || !runNodeId) continue;
    let diffs: Array<Record<string, unknown>> = [];
    try {
      const parsed = JSON.parse(str(run, 'diffs_json') || '[]') as unknown;
      if (Array.isArray(parsed)) diffs = parsed.filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === 'object');
    } catch {
      continue;
    }
    for (const stored of diffs) {
      if (stored['status'] !== 'pending') continue;
      const kind = stored['kind'] === 'wiki_contradiction' ? 'wiki_contradiction' : 'wiki_update';
      const diff = stored['diff'];
      if (!diff || typeof diff !== 'object') continue;
      const value = diff as Record<string, unknown>;
      const pageSlug = String(value['pageSlug'] ?? '').trim();
      if (!pageSlug) continue;
      const existing = byPage.get(pageSlug);
      if (existing?.kind === 'wiki_contradiction' || (existing && kind !== 'wiki_contradiction')) continue;
      const title = String(value['title'] ?? pageSlug).trim() || pageSlug;
      const op = String(value['op'] ?? 'update').trim() || 'update';
      byPage.set(pageSlug, {
        id: `wiki-update:${pageSlug}:${runId}`,
        kind,
        title: kind === 'wiki_contradiction' ? `Wiki contradiction on "${title}"` : `Wiki ${op}: ${title}`,
        reason: String(value['rationale'] ?? '').trim() || (kind === 'wiki_contradiction'
          ? 'The compiler found a claim conflict that requires operator review.'
          : `The compiler proposes ${op === 'create' ? 'a new page' : 'a page update'} for review.`),
        sourceRef: { label: 'RickydataWikiCompilerRun', nodeId: runNodeId, scope: 'private' },
      });
    }
  }
  return [...byPage.values()];
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

type RecentActivityKind = 'DEV' | 'PROOF' | 'KNOWLEDGE' | 'LEARN' | 'MEDIA';

type RecentActivityEvent = {
  id: string;
  kind: RecentActivityKind;
  occurred_at: string;
  title: string;
  summary: string;
  repo: string;
  source: { label: string; id: string; version: string };
  commit_sha?: string;
  pr_url?: string;
  course_slug?: string;
  lesson_id?: string;
  status?: string;
};

type RecentActivitySource = {
  label: string;
  ok: boolean;
  row_count: number;
  event_count: number;
  watermark: string;
  omission: string;
};

type RecentActivitySourceSpec = {
  label: string;
  limit: number;
  /** Narrow large labels to properties consumed by this projection so KFDB
   * does not decrypt and return unrelated private fields. */
  fields?: readonly string[];
  events?: (row: Record<string, unknown>) => RecentActivityEvent[];
};

const RECENT_ACTIVITY_SOURCE_CONCURRENCY = 4;

function parseJson<T>(value: string, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function activityIso(row: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = str(row, key);
    if (value && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  }
  return '';
}

function activityEvent(
  row: Record<string, unknown>,
  options: {
    kind: RecentActivityKind;
    label: string;
    at: string[];
    ids: string[];
    versions: string[];
    title: string;
    summary: string;
    repo?: string;
    commitSha?: string;
    prUrl?: string;
    courseSlug?: string;
    lessonId?: string;
    status?: string;
  },
): RecentActivityEvent[] {
  const occurredAt = activityIso(row, options.at);
  const sourceId = options.ids.map((key) => str(row, key)).find(Boolean) || str(row, '_id');
  if (!occurredAt || !sourceId) return [];
  const version = options.versions.map((key) => str(row, key)).find(Boolean) || occurredAt;
  return [{
    id: `${options.label}:${sourceId}:${options.kind}`,
    kind: options.kind,
    occurred_at: occurredAt,
    title: options.title,
    summary: options.summary,
    repo: options.repo || str(row, 'repo_id') || str(row, 'repo'),
    source: { label: options.label, id: sourceId, version },
    ...(options.commitSha ? { commit_sha: options.commitSha } : {}),
    ...(options.prUrl ? { pr_url: options.prUrl } : {}),
    ...(options.courseSlug ? { course_slug: options.courseSlug } : {}),
    ...(options.lessonId ? { lesson_id: options.lessonId } : {}),
    ...(options.status ? { status: options.status } : {}),
  }];
}

const RECENT_ACTIVITY_SOURCES: RecentActivitySourceSpec[] = [
  {
    label: 'RickydataGitCommit', limit: 20_000,
    fields: [
      '_id', 'commit_sha', 'repo_id', 'committed_at', 'authored_at',
      'last_attributed_at', 'subject', 'message',
    ],
    events: (row) => {
      const sha = str(row, 'commit_sha');
      const repo = str(row, 'repo_id');
      if (!sha || !repo) return [];
      return activityEvent(row, {
        kind: 'DEV', label: 'RickydataGitCommit',
        at: ['committed_at', 'authored_at', 'last_attributed_at'],
        ids: ['_id', 'commit_sha'], versions: ['commit_sha'],
        title: str(row, 'subject') || `Commit ${sha.slice(0, 10)}`,
        summary: str(row, 'message') || str(row, 'subject') || 'An immutable repository commit was recorded.',
        repo, commitSha: sha,
      });
    },
  },
  {
    label: 'RickydataDevelopmentEpisode', limit: 20_000,
    events: (row) => {
      const sha = str(row, 'commit_sha');
      const repo = str(row, 'repo_id');
      if (!sha || !repo) return [];
      return activityEvent(row, {
        kind: 'DEV', label: 'RickydataDevelopmentEpisode', at: ['occurred_at'],
        ids: ['episode_id', '_id'], versions: ['commit_sha'],
        title: str(row, 'title') || `Development episode ${sha.slice(0, 10)}`,
        summary: [
          str(row, 'problem_or_opportunity'),
          str(row, 'implementation_summary'),
          str(row, 'verification_summary'),
        ].filter(Boolean).join(' · '),
        repo,
        commitSha: sha,
      });
    },
  },
  {
    label: 'RickydataDailyLearningBrief', limit: 1000,
    events: (row) => {
      if (str(row, 'status') !== 'complete' || num(row, 'publishable') !== 1) return [];
      return activityEvent(row, {
        kind: 'LEARN', label: 'RickydataDailyLearningBrief', at: ['created_at', 'updated_at'],
        ids: ['_id'], versions: ['reproducibility_hash'],
        title: str(row, 'title') || `Daily development brief ${str(row, 'day')}`,
        summary: str(row, 'summary') || 'A complete, commit-backed daily learning brief was published.',
        repo: 'rickydata', lessonId: str(row, 'lesson_id'), status: 'complete',
      });
    },
  },
  {
    label: 'EvidenceRecord', limit: 5000,
    events: (row) => activityEvent(row, {
      kind: 'PROOF', label: 'EvidenceRecord', at: ['created_at'],
      ids: ['evidence_record_id', 'roadmap_item_id', '_id'], versions: ['commit_sha', 'created_at'],
      title: str(row, 'roadmap_item_id') || 'Release evidence recorded',
      summary: str(row, 'summary') || `${str(row, 'kind') || 'quality gate'} ${str(row, 'status') || 'recorded'}`,
      commitSha: str(row, 'commit_sha'), status: str(row, 'status'),
    }),
  },
  {
    label: 'RickydataChangeEvidence', limit: 3000,
    events: (row) => activityEvent(row, {
      kind: 'DEV', label: 'RickydataChangeEvidence', at: ['created_at', 'updated_at'],
      ids: ['change_id', 'intent_id', '_id'], versions: ['commit_sha', 'updated_at'],
      title: str(row, 'title') || str(row, 'summary') || 'Development change recorded',
      summary: str(row, 'diff_summary') || str(row, 'summary') || 'A development change entered the evidence graph.',
      commitSha: str(row, 'commit_sha'),
    }),
  },
  {
    label: 'RickydataWikiCompilerRun', limit: 2500,
    events: (row) => {
      const diffs = parseJson<Array<{ status?: string }>>(str(row, 'diffs_json'), []);
      const applied = diffs.filter((diff) => diff.status === 'applied' || diff.status === 'reverted').length;
      if (!applied) return [];
      return activityEvent(row, {
        kind: 'KNOWLEDGE', label: 'RickydataWikiCompilerRun', at: ['finished_at'],
        ids: ['run_id', '_id'], versions: ['cursor_to', 'finished_at'],
        title: `${applied} wiki update${applied === 1 ? '' : 's'} applied`,
        summary: `${num(row, 'atom_count')} knowledge atoms processed; ${applied} durable change${applied === 1 ? '' : 's'} graduated into the wiki.`,
        repo: 'rickydata_home',
      });
    },
  },
  {
    label: 'WikiPage', limit: 3000,
    events: (row) => activityEvent(row, {
      kind: 'KNOWLEDGE', label: 'WikiPage', at: ['updated_at', 'created_at'],
      ids: ['slug', '_id'], versions: ['revision_hash', 'updated_at'],
      title: str(row, 'title') || str(row, 'slug') || 'Wiki page updated',
      summary: str(row, 'summary') || 'A durable knowledge page changed.', repo: 'rickydata_home',
    }),
  },
  {
    label: 'RickydataCourse', limit: 1000,
    events: (row) => activityEvent(row, {
      kind: 'LEARN', label: 'RickydataCourse', at: ['generated_at'],
      ids: ['slug', '_id'], versions: ['generated_at'],
      title: str(row, 'title') || str(row, 'slug') || 'Course generated',
      summary: str(row, 'summary') || 'Grounded development work graduated into a learning course.',
      repo: str(row, 'repo') || str(row, 'slug'), courseSlug: str(row, 'slug'),
    }),
  },
  {
    label: 'RickydataLearningJob', limit: 5000,
    events: (row) => str(row, 'status') === 'succeeded' ? activityEvent(row, {
      kind: 'LEARN', label: 'RickydataLearningJob', at: ['finished_at'],
      ids: ['job_id', '_id'], versions: ['finished_at'],
      title: str(row, 'course_slug') || 'Learning generation completed',
      summary: str(row, 'message') || 'A learning generation job completed.',
      repo: str(row, 'repo'), courseSlug: str(row, 'course_slug'), status: 'succeeded',
    }) : [],
  },
  {
    label: 'RickydataLessonVideo', limit: 2000,
    events: (row) => activityEvent(row, {
      kind: 'MEDIA', label: 'RickydataLessonVideo', at: ['published_at'],
      ids: ['lesson_id', '_id'], versions: ['sha256', 'published_at'],
      title: `${str(row, 'kind') || 'Lesson'} video published`,
      summary: 'A grounded lesson now has published learner-facing video.', repo: 'rickydata_learn',
      lessonId: str(row, 'lesson_id'), status: 'published',
    }),
  },
  {
    label: 'RickydataCourseAudio', limit: 1000,
    events: (row) => activityEvent(row, {
      kind: 'MEDIA', label: 'RickydataCourseAudio', at: ['published_at'],
      ids: ['course_slug', '_id'], versions: ['sha256', 'published_at'],
      title: `${str(row, 'course_slug') || 'Course'} audio published`,
      summary: 'A course now has a durable audio edition.', repo: 'rickydata_learn',
      courseSlug: str(row, 'course_slug'), status: 'published',
    }),
  },
  {
    label: 'RickydataLearningDraft', limit: 2000,
    events: (row) => {
      const rawKind = str(row, 'artifact_kind');
      const artifactKind = rawKind || (str(row, 'lesson_id') ? 'curriculum_text' : '');
      const status = str(row, 'status');
      const ready = artifactKind === 'curriculum_text'
        ? status === 'published'
        : artifactKind === 'deep_dive' && (status === 'ready' || status === 'published');
      if (!ready) return [];
      const courseSlug = str(row, 'course_slug');
      const lessonId = str(row, 'lesson_id');
      return activityEvent(row, {
        kind: 'LEARN', label: 'RickydataLearningDraft', at: ['updated_at', 'created_at'],
        ids: ['_id'], versions: ['updated_at', 'created_at'],
        title: str(row, 'title') || (artifactKind === 'deep_dive' ? 'Deep dive ready' : 'Curriculum lesson published'),
        summary: artifactKind === 'deep_dive'
          ? 'A grounded deeper treatment is ready to read.'
          : 'Grounded learner-facing text was published.',
        repo: courseSlug || 'rickydata_home', courseSlug, lessonId, status,
      });
    },
  },
  {
    label: 'RickydataVideoBrief', limit: 2000,
    events: (row) => {
      const status = str(row, 'status');
      if (status !== 'rendered' && status !== 'published') return [];
      const courseSlug = str(row, 'course_slug');
      const lessonId = str(row, 'lesson_id');
      return activityEvent(row, {
        kind: 'MEDIA', label: 'RickydataVideoBrief', at: ['updated_at', 'created_at'],
        ids: ['_id'], versions: ['updated_at', 'created_at'],
        title: str(row, 'title') || 'Accompanying video ready',
        summary: status === 'published' ? 'A grounded video was published.' : 'A grounded video was rendered and is ready to watch.',
        repo: courseSlug || 'rickydata_learn', courseSlug, lessonId, status,
      });
    },
  },
  { label: 'RickydataLesson', limit: 5000 },
  { label: 'RickydataLessonProgress', limit: 5000 },
  { label: 'RickydataFeedComment', limit: 5000 },
  { label: 'RickydataLearningChallenge', limit: 5000 },
  { label: 'RickydataAnswerFeedback', limit: 5000 },
  { label: 'RickydataContentCandidate', limit: 2000 },
  { label: 'RickydataContentJob', limit: 2000 },
];

export const RECENT_ACTIVITY_SOURCE_LABELS = RECENT_ACTIVITY_SOURCES.map((source) => source.label);

export class KfdbKnowledgeClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly walletAddress?: string;
  private readonly requestWalletAddress?: string;
  private readonly s2d: S2DProvider | null;
  private readonly requireS2D: boolean;
  private readonly s2dProvenance: 'delegated-static' | 'legacy-wallet' | 'injected';
  private readonly fetchImpl: typeof fetch;

  constructor(deps: KfdbClientDeps) {
    this.baseUrl = deps.baseUrl.replace(/\/$/, '');
    this.apiKey = deps.apiKey;
    this.walletAddress = deps.walletAddress?.toLowerCase();
    this.requestWalletAddress = deps.requestWalletAddress?.toLowerCase();
    this.s2d = deps.s2d ?? null;
    this.requireS2D = deps.requireS2D ?? false;
    this.s2dProvenance = deps.s2dProvenance ?? 'injected';
    this.fetchImpl = deps.fetchImpl ?? fetch;
    if (this.walletAddress && this.requestWalletAddress && this.walletAddress !== this.requestWalletAddress) {
      throw new FailClosedError(
        `Wallet authority mismatch: delegated KFDB wallet ${this.walletAddress} does not match gateway requester ${this.requestWalletAddress}.`,
      );
    }
  }

  private baseHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      'content-type': 'application/json',
      'x-client-id': 'knowledge-work-mcp',
    };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    if (this.walletAddress) headers['x-wallet-address'] = this.walletAddress;
    return headers;
  }

  private async headersWithOptionalS2D(): Promise<Record<string, string>> {
    const headers = this.baseHeaders();
    if (!this.s2d) {
      if (this.requireS2D) {
        throw new FailClosedError('Sign-to-derive authority is required for this wallet-private read; refusing network egress.');
      }
      return headers;
    }
    const creds = await this.s2d.ensure();
    if (!creds) {
      if (this.requireS2D) {
        throw new FailClosedError('Sign-to-derive authority is unavailable for this wallet-private read; refusing network egress.');
      }
      return headers;
    }
    this.assertCredentialWallet(creds.walletAddress);
    headers['x-wallet-address'] = creds.walletAddress;
    headers['x-derive-session-id'] = creds.sessionId;
    headers['x-derive-key'] = creds.keyHex;
    return headers;
  }

  private assertCredentialWallet(walletAddress: string): void {
    const effective = walletAddress.toLowerCase();
    for (const expected of [this.walletAddress, this.requestWalletAddress]) {
      if (expected && expected !== effective) {
        throw new FailClosedError(
          `Wallet authority mismatch: derive credential ${effective} does not match expected requester ${expected}.`,
        );
      }
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
    this.assertCredentialWallet(creds.walletAddress);
    return {
      ...this.baseHeaders(),
      'x-wallet-address': creds.walletAddress,
      'x-derive-session-id': creds.sessionId,
      'x-derive-key': creds.keyHex,
    };
  }

  private authorityMetadata(headers: Record<string, string>): Record<string, unknown> {
    let endpoint = this.baseUrl;
    try { endpoint = new URL(this.baseUrl).origin; } catch { /* keep configured base */ }
    const sessionId = headers['x-derive-session-id'] || '';
    return {
      effective_wallet_address: headers['x-wallet-address'] || null,
      requester_wallet_address: this.requestWalletAddress || headers['x-wallet-address'] || null,
      tenant_scope: 'wallet-private',
      query_scope: 'private',
      kfdb_endpoint: endpoint,
      credential_type: sessionId ? 'kfdb-s2d-session' : 'kfdb-api-key',
      session_id_fingerprint: sessionId
        ? createHash('sha256').update(sessionId).digest('hex').slice(0, 12)
        : null,
      session_id_provenance: sessionId ? this.s2dProvenance : null,
    };
  }

  async authority(): Promise<Record<string, unknown>> {
    return this.authorityMetadata(await this.headersWithOptionalS2D());
  }

  private withAuthority(value: unknown, headers: Record<string, string>): unknown {
    const authority = this.authorityMetadata(headers);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return { ...(value as Record<string, unknown>), authority };
    }
    return { result: value, authority };
  }

  private async requestJson<T>(
    path: string,
    init: RequestInit,
    retryTransientRead = false,
  ): Promise<T> {
    const attempts = retryTransientRead ? 2 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
          ...init,
        });
        const text = await res.text();
        if (!res.ok) throw decorateS2DRejection(new ApiError('kfdb', res.status, text));
        return text ? (JSON.parse(text) as T) : ({} as T);
      } catch (error) {
        const retryable = error instanceof ApiError
          ? TRANSIENT_READ_STATUSES.has(error.status)
          : error instanceof TypeError;
        if (!retryTransientRead || !retryable || attempt === attempts - 1) throw error;
        await new Promise((resolve) => setTimeout(resolve, TRANSIENT_READ_RETRY_DELAY_MS));
      }
    }
    throw new Error('unreachable KFDB request state');
  }

  private async postJson<T>(
    path: string,
    body: unknown,
    headers: Record<string, string>,
    retryTransientRead = false,
  ): Promise<T> {
    return this.requestJson(path, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }, retryTransientRead);
  }

  private async getJson<T>(
    path: string,
    headers: Record<string, string>,
  ): Promise<T> {
    return this.requestJson(path, { method: 'GET', headers }, true);
  }

  async knowledgeBundle(params: {
    query?: string;
    token_budget?: number;
    page_limit?: number;
    claim_limit?: number;
    include_questions?: boolean;
    question_limit?: number;
  }): Promise<unknown> {
    const headers = await this.headersWithOptionalS2D();
    const result = await this.postJson('/api/v1/agent/knowledge', params, headers, true);
    assertNoCiphertext(result, 'knowledge_bundle');
    return this.withAuthority(result, headers);
  }

  private async queryKql(query: string): Promise<Record<string, unknown>[]> {
    const res = await this.postJson('/api/v1/query', { query, scope: 'private' }, await this.headersWithOptionalS2D(), true);
    const rows = rowsOf(res);
    for (const row of rows) assertNoCiphertext(row, query);
    return rows;
  }

  /**
   * Exact chronological projection for “what happened recently?” questions.
   * This deliberately scans append-stable private labels instead of using
   * semantic similarity, which can rank old but related material as recent.
   */
  async recentActivity(input: { hours?: number; limit?: number; now?: Date } = {}): Promise<unknown> {
    const hours = Math.min(168, Math.max(1, Math.floor(input.hours ?? 24)));
    const limit = Math.min(100, Math.max(1, Math.floor(input.limit ?? 40)));
    const now = input.now ?? new Date();
    if (!Number.isFinite(now.getTime())) throw new ApiError('kfdb', 400, 'recent activity now value is invalid');
    const to = now.toISOString();
    const fromMs = now.getTime() - hours * 60 * 60_000;
    const from = new Date(fromMs).toISOString();

    const scan = async (source: RecentActivitySourceSpec) => {
      try {
        const projection = source.fields?.length
          ? source.fields.map((field) => `n.${field} AS ${field}`).join(', ')
          : 'n.*';
        const rows = (await this.queryKql(
          `MATCH (n:${source.label}) RETURN ${projection} LIMIT ${source.limit}`,
        )).map(unwrapRow);
        const events = (source.events ? rows.flatMap(source.events) : [])
          .filter((event) => {
            const occurredAt = Date.parse(event.occurred_at);
            return Number.isFinite(occurredAt) && occurredAt >= fromMs && occurredAt <= now.getTime();
          });
        const watermark = events.reduce(
          (latest, event) => event.occurred_at > latest ? event.occurred_at : latest,
          '',
        );
        const status: RecentActivitySource = {
          label: source.label,
          ok: true,
          row_count: rows.length,
          event_count: events.length,
          watermark,
          omission: '',
        };
        return { label: source.label, rows, events, status };
      } catch (error) {
        if (error instanceof FailClosedError || (error instanceof ApiError && (error.status === 401 || error.status === 403))) {
          throw error;
        }
        const omission = error instanceof ApiError
          ? `${error.status}: ${error.body}`
          : error instanceof Error ? error.message : String(error);
        const status: RecentActivitySource = {
          label: source.label,
          ok: false,
          row_count: 0,
          event_count: 0,
          watermark: '',
          omission: omission.slice(0, 240),
        };
        return { label: source.label, rows: [] as Record<string, unknown>[], events: [] as RecentActivityEvent[], status };
      }
    };
    const reads = new Array<Awaited<ReturnType<typeof scan>>>(RECENT_ACTIVITY_SOURCES.length);
    let sourceCursor = 0;
    const worker = async () => {
      for (;;) {
        const index = sourceCursor;
        sourceCursor += 1;
        if (index >= RECENT_ACTIVITY_SOURCES.length) return;
        reads[index] = await scan(RECENT_ACTIVITY_SOURCES[index]!);
      }
    };
    await Promise.all(Array.from(
      { length: Math.min(RECENT_ACTIVITY_SOURCE_CONCURRENCY, RECENT_ACTIVITY_SOURCES.length) },
      () => worker(),
    ));

    const rowsFor = (label: string): Record<string, unknown>[] => reads.find((read) => read.label === label)?.rows ?? [];
    const byId = new Map<string, RecentActivityEvent>();
    for (const event of reads.flatMap((read) => read.events)) {
      const current = byId.get(event.id);
      if (!current || event.occurred_at > current.occurred_at) byId.set(event.id, event);
    }
    const allEvents = [...byId.values()].sort(
      (a, b) => b.occurred_at.localeCompare(a.occurred_at) || a.id.localeCompare(b.id),
    );
    const counts: Record<RecentActivityKind, number> = { DEV: 0, PROOF: 0, KNOWLEDGE: 0, LEARN: 0, MEDIA: 0 };
    for (const event of allEvents) counts[event.kind] += 1;

    const recommendations = rowsFor('RickydataContentCandidate')
      .map((row) => {
        const quality = parseJson<Record<string, unknown>>(str(row, 'quality_json'), {});
        const impact = parseJson<Record<string, unknown>>(str(row, 'curriculum_impact_json'), {});
        const recommendation = parseJson<Record<string, unknown>>(str(row, 'agent_recommendation_json'), {});
        const status = str(row, 'status') || 'proposed';
        if (str(row, 'text_status') !== 'ready' || quality['passed'] !== true || status === 'parked' || status === 'rejected') return null;
        return {
          id: str(row, 'candidate_id') || str(row, '_id'),
          title: str(row, 'title'),
          status,
          quality: typeof quality['overall'] === 'number' ? quality['overall'] : 0,
          action: String(recommendation['action'] ?? ''),
          priority: String(recommendation['priority'] ?? ''),
          rationale: String(recommendation['rationale'] ?? ''),
          target_course: String(impact['targetCourse'] ?? impact['target_course'] ?? ''),
          target_phase: String(impact['targetPhase'] ?? impact['target_phase'] ?? ''),
          source_refs: parseJson<string[]>(str(row, 'source_refs_json'), []),
          updated_at: str(row, 'updated_at'),
        };
      })
      .filter((row): row is NonNullable<typeof row> => Boolean(row?.id))
      .sort((a, b) => b.quality - a.quality || b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id))
      .slice(0, 8);

    const activeJobs = rowsFor('RickydataContentJob')
      .filter((row) => ['queued', 'running', 'retry_wait', 'failed', 'dead_letter'].includes(str(row, 'status')))
      .map((row) => ({
        id: str(row, 'job_id') || str(row, '_id'),
        candidate_id: str(row, 'candidate_id'),
        kind: str(row, 'kind'),
        status: str(row, 'status'),
        stage: str(row, 'stage'),
        detail: str(row, 'detail'),
        updated_at: str(row, 'updated_at'),
      }))
      .filter((row) => Boolean(row.id))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id))
      .slice(0, 12);

    const courseCount = new Set(rowsFor('RickydataCourse').map((row) => str(row, 'slug')).filter(Boolean)).size;
    const lessonRows = rowsFor('RickydataLesson').filter((row) => str(row, '_id') && str(row, 'course_slug'));
    const playableVideoLessons = new Set(
      rowsFor('RickydataLessonVideo').map((row) => str(row, 'lesson_id')).filter(Boolean),
    ).size;
    const sources = reads.map((read) => read.status);
    const curriculum = {
      course_count: courseCount,
      lesson_count: lessonRows.length,
      playable_video_lessons: playableVideoLessons,
      video_coverage_percent: lessonRows.length ? Math.round((playableVideoLessons / lessonRows.length) * 10_000) / 100 : 0,
    };
    const reproducibilityHash = createHash('sha256').update(JSON.stringify({
      window: { from, to, hours },
      events: allEvents.map((event) => [event.id, event.source.version]),
      sources: sources.map((source) => [source.label, source.ok, source.row_count, source.event_count, source.watermark]),
      recommendations: recommendations.map((row) => [row.id, row.quality, row.status, row.updated_at]),
      active_jobs: activeJobs.map((row) => [row.id, row.status, row.stage, row.updated_at]),
      curriculum,
    })).digest('hex');
    const omissions = sources.filter((source) => !source.ok).map((source) => `${source.label}: ${source.omission}`);

    const authorityHeaders = await this.headersWithOptionalS2D();
    return {
      schema: 'rickydata.recent-activity.v1',
      window: { from, to, hours },
      counts,
      total_events: allEvents.length,
      returned_events: Math.min(allEvents.length, limit),
      events: allEvents.slice(0, limit),
      recommendations,
      active_jobs: activeJobs,
      curriculum,
      complete: omissions.length === 0,
      sources,
      omissions,
      authority: this.authorityMetadata(authorityHeaders),
      reproducibility_hash: reproducibilityHash,
      interpretation: 'Chronological private-graph receipts. Missing sources are unknown, never zero; use trace or code_context to deepen these exact receipts.',
    };
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
      authority: bundle.authority,
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

    const page = pageRows.map(wikiPageOf).find(
      (p): p is WikiPageRow => p !== null && (p.slug === target || p.nodeId === target),
    );
    if (!page) throw new ApiError('kfdb', 404, `wiki page not found: ${target}`);

    const verifiedById = new Map<string, boolean>();
    for (const claim of Array.isArray(bundle.claims) ? bundle.claims : []) {
      const id = String(claim['id'] ?? '');
      if (!id) continue;
      verifiedById.set(id, claim['verified'] === true);
    }

    const claims = claimRows
      .map(wikiClaimOf)
      .filter((claim): claim is WikiClaimRow => claim !== null && claim.pageSlug === page.slug && claim.status !== 'retracted')
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
      authority: bundle.authority,
    };
  }

  async trace(kind: string, id: string): Promise<unknown> {
    const traceKind = kind.trim().toLowerCase();
    const target = id.trim();
    if (!target) throw new ApiError('kfdb', 400, 'trace id is required');
    const authorityHeaders = await this.headersWithOptionalS2D();

    if (traceKind === 'knowledge-assertion' || traceKind === 'assertion') {
      const assertionRows = await this.queryKql('MATCH (n:RickydataKnowledgeAssertion) RETURN n.* LIMIT 500');
      const assertion = assertionRows
        .map(unwrapRow)
        .find((row) => str(row, 'slug') === target);
      if (!assertion) throw new ApiError('kfdb', 404, `knowledge assertion trace not found: ${target}`);
      const expectJson = str(assertion, 'expect_json');
      const anchorJson = str(assertion, 'anchor_json');
      const oracleJson = str(assertion, 'oracle_json');
      let anchor: Record<string, unknown> = {};
      let oracle: Record<string, unknown> = {};
      try { anchor = JSON.parse(anchorJson) as Record<string, unknown>; } catch { /* Keep exact raw JSON in the trace. */ }
      try { oracle = JSON.parse(oracleJson) as Record<string, unknown>; } catch { /* Keep exact raw JSON in the trace. */ }
      const title = str(assertion, 'title') || target;
      return this.withAuthority({
        subject: { kind: 'knowledge-assertion', id: target },
        title,
        confidence: 'recorded',
        nodes: [{
          ref: { kind: 'knowledge-assertion', id: target },
          title,
          type: 'knowledge-assertion',
          data: {
            slug: target,
            origin: str(assertion, 'origin'),
            status: str(assertion, 'status'),
            severity: str(assertion, 'severity'),
            comparator: str(assertion, 'comparator'),
            anchorKind: String(anchor['kind'] ?? ''),
            anchorKey: String(anchor['key'] ?? ''),
            oracleKind: String(oracle['kind'] ?? ''),
            expectJson,
            anchorJson,
            oracleJson,
            sourceSha256: str(assertion, 'source_sha256'),
            createdBy: str(assertion, 'created_by'),
            updatedAt: str(assertion, 'updated_at'),
            rationale: str(assertion, 'rationale'),
          },
        }],
        edges: [],
        omissions: [{ reason: 'latest-lint-run-omitted-from-fast-path' }],
      }, authorityHeaders);
    }

    if (traceKind === 'wiki-page' || traceKind === 'wikipage' || traceKind === 'page') {
      return this.withAuthority({
        kind: 'wiki-page',
        id: target,
        ...(await this.wikiPage(target) as Record<string, unknown>),
      }, authorityHeaders);
    }

    if (target.startsWith('evidence:')) {
      const evidenceId = target.slice('evidence:'.length).trim();
      const evidenceRows = await this.queryKql('MATCH (n:EvidenceRecord) RETURN n.* LIMIT 5000');
      const evidence = evidenceRows
        .map(unwrapRow)
        .find((row) => [str(row, 'evidence_record_id'), str(row, '_id')].includes(evidenceId));
      if (evidence) {
        const commitSha = str(evidence, 'commit_sha');
        const repo = str(evidence, 'repo_id') || str(evidence, 'repo');
        const roadmapItemId = str(evidence, 'roadmap_item_id');
        const summary = str(evidence, 'summary');
        const status = str(evidence, 'status');
        const evidenceNode = {
          ref: { kind: 'evidence-record', id: evidenceId },
          title: roadmapItemId || `EvidenceRecord ${evidenceId}`,
          type: 'EvidenceRecord',
          data: {
            evidenceRecordId: evidenceId,
            roadmapItemId,
            kind: str(evidence, 'kind'),
            status,
            summary,
            commitSha,
            repo,
            createdAt: str(evidence, 'created_at'),
          },
        };
        const commitNode = commitSha ? {
          ref: { kind: 'commit-reference', id: commitSha },
          title: `Commit ${commitSha}`,
          type: 'CommitReference',
          data: { commitSha, repo, provenance: 'EvidenceRecord.commit_sha' },
        } : null;
        return this.withAuthority({
          answer: `EvidenceRecord ${evidenceId}${status ? ` is ${status}` : ''}${commitSha ? ` and records commit ${commitSha}` : ''}${repo ? ` in ${repo}` : ''}.`,
          subject: { kind: 'evidence-record', id: evidenceId },
          kind: 'evidence-record',
          id: evidenceId,
          sourceRef: target,
          commitSha,
          repo,
          status,
          summary,
          nodes: commitNode ? [evidenceNode, commitNode] : [evidenceNode],
          edges: commitNode ? [{
            source: evidenceNode.ref,
            target: commitNode.ref,
            relation: 'records_commit',
            provenance: 'EvidenceRecord.commit_sha',
          }] : [],
          trace: [
            { label: 'EvidenceRecord', id: evidenceId, sourceRef: target },
            ...(commitSha ? [{ label: 'CommitReference', commitSha, repo, provenance: 'EvidenceRecord.commit_sha' }] : []),
          ],
          citation: { sourceRef: target, evidenceRecordId: evidenceId, commitSha, repo },
          fallback: { source: 'kfdb_trace', reason: 'exact private EvidenceRecord receipt projection' },
        }, authorityHeaders);
      }
    }

    const claimRows = await this.queryKql('MATCH (n:WikiClaim) RETURN n.* LIMIT 5000');
    const claim = claimRows
      .map(wikiClaimOf)
      .find((row): row is WikiClaimRow => row !== null && row.status !== 'retracted' && (row.id === target || row.sourceRef === target));
    if (!claim) throw new ApiError('kfdb', 404, `wiki claim trace not found: ${target}`);

    const [page, exactBundle] = await Promise.all([
      this.wikiPage(claim.pageSlug),
      this.knowledgeBundle({
        query: claim.text,
        token_budget: 2500,
        page_limit: 10,
        claim_limit: 40,
        include_questions: false,
      }),
    ]) as [{
      page?: Record<string, unknown>;
      claims?: Array<Record<string, unknown>>;
      verifiedClaimIds?: string[];
      fallback?: Record<string, unknown>;
    }, KnowledgeBundle];
    const exactClaim = page.claims?.find((row) => row['id'] === claim.id) ?? claim;
    const claimText = String((exactClaim as Record<string, unknown>)['text'] ?? claim.text);
    const verified = Array.isArray(exactBundle.claims) && exactBundle.claims.some((row) =>
      row['id'] === claim.id && row['verified'] === true);
    const pageSlug = claim.pageSlug;
    const pageRecord = page.page ?? {};
    const compactPage = {
      slug: typeof pageRecord['slug'] === 'string' ? pageRecord['slug'] : pageSlug,
      title: typeof pageRecord['title'] === 'string' ? pageRecord['title'] : undefined,
      kind: typeof pageRecord['kind'] === 'string' ? pageRecord['kind'] : undefined,
      status: typeof pageRecord['status'] === 'string' ? pageRecord['status'] : undefined,
    };
    const rawAnswer = `Page ${pageSlug}; claim ${claim.id}; ${verified ? 'verified' : 'recorded but not yet verified'}. ${claimText}`;
    const answer = voiceSafeDurations(rawAnswer);

    return this.withAuthority({
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
    }, authorityHeaders);
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
    const allQuestions = questionRows
      .map((row) => openQuestionOf(row, now))
      .filter((q): q is OpenQuestionView => q !== null);
    const questions = allQuestions
      .filter((q) => !topic || JSON.stringify(q).toLowerCase().includes(topic));
    const items: RoadmapItemRow[] = [];
    const ranked = rankOpenQuestions(questions, items);
    let totalOpen = allQuestions.length;
    let globalQueueDiagnostics: unknown;
    let globalQueueReproducibilityHash: unknown;

    if (topic && questions.length === 0) {
      const globalBundle = await this.knowledgeBundle({
        token_budget: 12000,
        page_limit: 1,
        claim_limit: 1,
        include_questions: true,
        question_limit: 500,
      }) as KnowledgeBundle;
      const globalQuestionRows = Array.isArray(globalBundle.open_questions) ? globalBundle.open_questions : [];
      totalOpen = globalQuestionRows
        .map((row) => openQuestionOf(row, now))
        .filter((q): q is OpenQuestionView => q !== null)
        .length;
      globalQueueDiagnostics = globalBundle.diagnostics;
      globalQueueReproducibilityHash = globalBundle.reproducibility_hash;
    }
    const queueDiagnostics = (globalQueueDiagnostics ?? bundle.diagnostics) as Record<string, unknown> | undefined;
    const queueSources = queueDiagnostics?.['sources'];
    const questionSource = queueSources && typeof queueSources === 'object'
      ? (queueSources as Record<string, unknown>)['questions']
      : undefined;
    const questionSourceRecord = questionSource && typeof questionSource === 'object'
      ? questionSource as Record<string, unknown>
      : undefined;
    const prunedQuestions = typeof queueDiagnostics?.['pruned_questions'] === 'number'
      ? queueDiagnostics['pruned_questions']
      : null;
    const queueProjectionComplete = questionSourceRecord?.['complete'] === true && prunedQuestions === 0;

    return {
      ranked: ranked.slice(0, input.limit),
      total_ranked: ranked.length,
      fallback: {
        source: 'kfdb_agent_knowledge',
        reason: 'home next_questions unavailable or empty; ranked the optimized KFDB knowledge-bundle question projection',
        total_open: totalOpen,
        queue_projection_complete: queueProjectionComplete,
        total_open_is_lower_bound: !queueProjectionComplete,
        ...(topic ? {
          topic: input.topic?.trim(),
          topic_matches: questions.length,
          retry_hint: 'Omit topic to request the global highest-value ranking.',
          ...(questions.length === 0 ? {
            global_queue_diagnostics: globalQueueDiagnostics ?? {},
            global_queue_reproducibility_hash: globalQueueReproducibilityHash,
          } : {}),
        } : {}),
        ranking: 'value = blocking x gap x freshness x answerability; blocking and gap default to baseline in MCP fallback',
        diagnostics: bundle.diagnostics ?? {},
        reproducibility_hash: bundle.reproducibility_hash,
      },
    };
  }

  async reviewPending(limit = 5): Promise<unknown> {
    const [runsRead, questionsRead] = await Promise.allSettled([
      this.queryKql('MATCH (n:RickydataWikiCompilerRun) RETURN n.* LIMIT 500'),
      this.nextQuestions({ limit }),
    ]);
    if (runsRead.status === 'rejected' && questionsRead.status === 'rejected') throw runsRead.reason;

    const wikiItems = runsRead.status === 'fulfilled' ? pendingWikiReviewItems(runsRead.value) : [];
    const questionValue = questionsRead.status === 'fulfilled' && questionsRead.value && typeof questionsRead.value === 'object'
      ? questionsRead.value as Record<string, unknown>
      : {};
    const ranked = Array.isArray(questionValue['ranked']) ? questionValue['ranked'] as Array<Record<string, unknown>> : [];
    const questionItems = ranked.map((question) => {
      const id = String(question['id'] ?? '').trim();
      return {
        id,
        kind: 'open_question',
        title: String(question['question'] ?? '').trim() || `Open question ${id || 'unknown'}`,
        reason: String(question['whyItMatters'] ?? question['why_it_matters'] ?? '').trim() || 'Open question awaiting an operator answer.',
        sourceRef: { label: 'OpenQuestion', nodeId: id, scope: 'private' as const },
      };
    }).filter((item) => item.id);
    const items = [...wikiItems, ...questionItems].slice(0, Math.max(1, limit));
    const counts: Record<string, number> = {};
    for (const item of items) counts[item.kind] = (counts[item.kind] ?? 0) + 1;

    return {
      counts,
      items,
      fallback: {
        source: 'kfdb_pending_projection',
        reason: 'home review_pending unavailable or empty; merged pending compiler diffs ahead of ranked open questions',
        total_pending_wiki: wikiItems.length,
        total_open: typeof questionValue['total_ranked'] === 'number' ? questionValue['total_ranked'] : ranked.length,
        ...(runsRead.status === 'rejected' ? { wiki_error: runsRead.reason instanceof Error ? runsRead.reason.message : String(runsRead.reason) } : {}),
        ...(questionsRead.status === 'rejected' ? { questions_error: questionsRead.reason instanceof Error ? questionsRead.reason.message : String(questionsRead.reason) } : {}),
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
          include_entities: true,
        };
        try {
          const response = await this.postJson('/api/v1/semantic/search', body, headers, true);
          return { label, ok: true, result: projectSemanticResponse(response, label) };
        } catch (err) {
          return { label, ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      }),
    );
    return {
      query: input.query,
      min_similarity: input.minSimilarity,
      labels: results,
      authority: this.authorityMetadata(headers),
    };
  }

  async codeContext(params: { task: string; repo?: string }): Promise<unknown> {
    const authorityHeaders = await this.headersWithOptionalS2D();
    const body: Record<string, unknown> = {
      query: params.task,
      token_budget: 3000,
      include_tests: false,
      include_graph: true,
      graph_top_k: 3,
      graph_depth: 1,
      evidence_limit: 4,
      enable_sufficiency_gate: false,
    };
    let repoResolution: Record<string, unknown> | null = null;
    if (params.repo?.trim()) {
      repoResolution = await this.resolveCodeRepoScope(params.repo);
      if (repoResolution['status'] !== 'resolved') {
        return this.withAuthority({
          evidence_items: [],
          graph_neighborhood: [],
          retrieval_metadata: {
            sufficiency: {
              is_sufficient: false,
              reason: 'Requested repository scope is unavailable in the KFDB code index.',
            },
          },
          diagnostics: { repo_scope_unavailable: true, evidence_count: 0 },
          repo_resolution: repoResolution,
        }, authorityHeaders);
      }
      body['repo_scope'] = (repoResolution['resolved'] as Array<{ repo_id: string }>).map((item) => item.repo_id);
      body['strict_scope'] = true;
    }
    let result = await this.postJson<unknown>(
      '/api/v1/agent/context',
      body,
      authorityHeaders,
      true,
    );
    const focusedQueries = missingCompoundIdentifierQueries(params.task, result);
    if (focusedQueries.length > 0) {
      const supplements = await Promise.all(focusedQueries.map((query) => this.postJson<unknown>(
        '/api/v1/agent/context',
        { ...body, query },
        authorityHeaders,
        true,
      )));
      result = mergeCodeContextResults(result, supplements, focusedQueries);
    }
    assertNoCiphertext(result, 'code_context');
    if (!repoResolution) return this.withAuthority(result, authorityHeaders);
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      const value = result as Record<string, unknown>;
      const evidence = Array.isArray(value['evidence_items']) ? value['evidence_items'] : [];
      const scopedEvidence = evidence.filter((item) => {
        if (!item || typeof item !== 'object') return false;
        const streams = (item as Record<string, unknown>)['stream_hits'];
        return Array.isArray(streams)
          && streams.some((stream) => stream === 'fts' || stream === 'dense' || stream === 'symbol');
      });
      const dropped = evidence.length - scopedEvidence.length;
      const allowedRepoIds = new Set(
        (repoResolution['resolved'] as Array<{ repo_id: string }>).map((item) => item.repo_id),
      );
      const scopedGraph = filterScopedGraphNeighborhoods(value['graph_neighborhood'], allowedRepoIds);
      const diagnostics = value['diagnostics'] && typeof value['diagnostics'] === 'object'
        ? value['diagnostics'] as Record<string, unknown>
        : {};
      return this.withAuthority({
        ...value,
        evidence_items: scopedEvidence,
        graph_neighborhood: scopedGraph.neighborhoods,
        diagnostics: {
          ...diagnostics,
          evidence_count: scopedEvidence.length,
          graph_neighborhoods: scopedGraph.neighborhoods.length,
          repo_scope_filter_applied: true,
          repo_scope_graph_only_dropped: dropped,
          repo_scope_graph_nodes_dropped: scopedGraph.nodesDropped,
          repo_scope_graph_edges_dropped: scopedGraph.edgesDropped,
        },
        repo_resolution: repoResolution,
      }, authorityHeaders);
    }
    return this.withAuthority({ result, repo_resolution: repoResolution }, authorityHeaders);
  }

  private async resolveCodeRepoScope(raw: string): Promise<Record<string, unknown>> {
    const requested = [...new Set(raw.split(',').map((value) => value.trim()).filter(Boolean))];
    if (requested.length === 0) {
      return {
        status: 'invalid',
        requested,
        resolved: [],
        missing: [],
        ambiguous: [],
      };
    }
    const resolved: Array<{ repo: string; repo_id: string }> = [];
    const missing: string[] = [];
    const ambiguous: Array<{ repo: string; candidates: Array<{ repo: string; repo_id: string }> }> = [];
    const unresolved = requested.filter((value) => !isUuid(value));
    const repositories = unresolved.length > 0 ? await this.listImportedRepositories() : [];

    for (const selector of requested) {
      if (isUuid(selector)) {
        resolved.push({ repo: selector, repo_id: selector.toLowerCase() });
        continue;
      }
      const normalized = normalizeRepoSelector(selector);
      const matches = repositories.filter((repo) => {
        const fullName = normalizeRepoSelector(repo.full_name || `${repo.owner}/${repo.name}`);
        const name = normalizeRepoSelector(repo.name);
        return normalized.includes('/') ? fullName === normalized : name === normalized;
      });
      const unique = [...new Map(matches.map((repo) => [repo.repo_id, repo])).values()];
      if (unique.length === 1) {
        const match = unique[0]!;
        resolved.push({ repo: match.full_name || `${match.owner}/${match.name}`, repo_id: match.repo_id });
      } else if (unique.length === 0) {
        missing.push(selector);
      } else {
        ambiguous.push({
          repo: selector,
          candidates: unique.map((repo) => ({
            repo: repo.full_name || `${repo.owner}/${repo.name}`,
            repo_id: repo.repo_id,
          })),
        });
      }
    }

    return {
      status: ambiguous.length > 0 ? 'ambiguous' : missing.length > 0 ? 'not_indexed' : 'resolved',
      requested,
      resolved,
      missing,
      ambiguous,
    };
  }

  private async listImportedRepositories(): Promise<Array<{
    repo_id: string;
    owner: string;
    name: string;
    full_name: string;
  }>> {
    const result = await this.getJson<unknown>('/api/v1/import/github', await this.headersWithOptionalS2D());
    if (!result || typeof result !== 'object') return [];
    const repositories = (result as Record<string, unknown>)['repositories'];
    if (!Array.isArray(repositories)) return [];
    return repositories.flatMap((value) => {
      if (!value || typeof value !== 'object') return [];
      const repo = value as Record<string, unknown>;
      const repoId = String(repo['repo_id'] ?? '').trim().toLowerCase();
      const owner = String(repo['owner'] ?? '').trim();
      const name = String(repo['name'] ?? '').trim();
      const fullName = String(repo['full_name'] ?? '').trim();
      if (!isUuid(repoId) || !name) return [];
      return [{ repo_id: repoId, owner, name, full_name: fullName }];
    });
  }

  async writeData(request: WriteRequest): Promise<unknown> {
    return this.postJson('/api/v1/write', request, await this.headersWithRequiredS2D());
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.trim());
}

function normalizeRepoSelector(value: string): string {
  return value
    .trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/^github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/^\/+|\/+$/g, '')
    .toLowerCase();
}

export function loadKfdbClientFromEnv(
  env: Record<string, string | undefined>,
  s2d: S2DProvider | null,
): KfdbKnowledgeClient | null {
  const baseUrl = env.KFDB_API_URL?.trim();
  const apiKey = env.KFDB_API_KEY?.trim();
  if (!baseUrl || (!apiKey && !s2d)) return null;
  return new KfdbKnowledgeClient({
    baseUrl,
    apiKey,
    walletAddress: env.KFDB_WALLET_ADDRESS?.trim() || env.X_WALLET_ADDRESS?.trim(),
    requestWalletAddress: env.RICKYDATA_AUTH_WALLET_ADDRESS?.trim(),
    s2d,
    requireS2D: Boolean(
      env.RICKYDATA_AUTH_WALLET_ADDRESS?.trim()
      || env.S2D_SESSION_ID?.trim()
      || env.S2D_DERIVED_KEY?.trim()
    ),
    s2dProvenance: env.S2D_SESSION_ID?.trim()
      ? 'delegated-static'
      : env.KNOWLEDGE_MCP_PRIVATE_KEY?.trim()
        ? 'legacy-wallet'
        : 'injected',
  });
}
