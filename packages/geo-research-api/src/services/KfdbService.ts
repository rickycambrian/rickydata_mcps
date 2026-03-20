import { config } from '../config/index.js';
import { AppError } from '../middleware/errors.js';

const KFDB_BASE = config.kfdb.url;

const READ_HEADERS: Record<string, string> = {
  Accept: 'application/json, text/event-stream',
  ...(config.kfdb.apiKey ? { Authorization: `Bearer ${config.kfdb.apiKey}` } : {}),
};

const WRITE_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
  ...(config.kfdb.apiKey ? { Authorization: `Bearer ${config.kfdb.apiKey}` } : {}),
};

export interface DiscoveryPaper {
  id: string;
  arxiv_id: string;
  title: string;
  abstract: string;
  authors: string[];
  published_date: string;
  web_url: string;
  status: 'processing' | 'ready_for_review' | 'published' | 'failed';
  discovered_by: string;
  topics: string[];
  claim_count: number;
  created_at: string;
  confidence_score?: number;
  confidence_tier?: 'auto_approve' | 'review' | 'skip';
  confidence_reason?: string;
  topic_profile_id?: string;
  source_candidate_id?: string;
}

export interface ExtractedClaim {
  id: string;
  paper_kfdb_id: string;
  text: string;
  position: number;
  role: string;
  source_quote: string;
  status: 'pending' | 'approved' | 'rejected' | 'edited';
  edited_text: string;
  edited_by: string;
  confidence_score?: number;
  evidence_type?: 'experimental' | 'theoretical' | 'observational' | 'computational';
  methodology?: string;
}

export interface ReviewItem {
  id: string;
  wallet_address: string;
  paper_kfdb_id: string;
  status: 'pending' | 'approved' | 'rejected' | 'needs_revision';
  feedback: string;
  assigned_at: string;
  reviewed_at: string;
}

export interface PublishedRecord {
  id: string;
  paper_kfdb_id: string;
  geo_paper_entity_id: string;
  geo_claim_entity_ids: string[];
  geo_proposal_id: string;
  geo_tx_hash: string;
  published_by: string;
  published_at: string;
}

export interface PdfAnnotation {
  id: string;
  paper_id: string;
  page: number;
  rects_json: string;
  text: string;
  annotation_type: 'highlight' | 'note' | 'claim_link';
  claim_id: string;
  created_at: string;
}

export interface DiscoveryConfig {
  id: string;
  categories: string;
  keywords: string;
  min_relevance_score: number;
  enabled: string;
}

export interface PaperRelationship {
  id: string;
  source_paper_id: string;
  target_paper_id: string;
  relationship_type: 'cites' | 'extends' | 'contradicts' | 'reproduces' | 'shares_topic' | 'shares_author';
  similarity_score?: number;
  shared_authors?: string[];
}

export interface TopicProfile {
  id: string;
  name: string;
  description: string;
  categories: string[];
  keywords: string[];
  enabled: string;
  auto_extract: string;
  min_candidate_score: number;
  max_daily_extractions: number;
  owner_wallet: string;
  created_at: string;
  updated_at: string;
}

export interface DiscoveryRun {
  id: string;
  topic_profile_id: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  started_at: string;
  finished_at: string;
  query_window_start: string;
  query_window_end: string;
  candidate_count: number;
  promoted_count: number;
  error_summary: string;
  created_by: string;
}

export interface PaperCandidate {
  id: string;
  arxiv_id: string;
  topic_profile_id: string;
  source_run_id: string;
  title: string;
  abstract: string;
  authors: string[];
  categories: string[];
  published_date: string;
  score_total: number;
  score_breakdown: Record<string, number>;
  novelty_score: number;
  graph_fit_score: number;
  status: 'pending' | 'promoted' | 'processing' | 'extracted' | 'dismissed' | 'failed';
  discovered_by: string;
  created_at: string;
  updated_at: string;
  promoted_at?: string;
  paper_id?: string;
  error_summary?: string;
}

export interface ResearchTopic {
  id: string;
  name: string;
  slug: string;
  description: string;
  topic_profile_id: string;
  paper_count: number;
  claim_count: number;
  trend_score: number;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
}

export interface TopicMembership {
  id: string;
  topic_id: string;
  entity_type: 'paper' | 'claim' | 'candidate';
  entity_id: string;
  topic_profile_id: string;
  confidence: number;
  created_at: string;
}

export interface TopicSnapshot {
  id: string;
  topic_profile_id: string;
  snapshot_date: string;
  paper_count: number;
  new_paper_count: number;
  claim_count: number;
  velocity_score: number;
  top_paper_ids: string[];
  top_claim_ids: string[];
  created_at: string;
}

export interface AssistantThread {
  id: string;
  entity_id: string;
  context_type?: 'published_paper' | 'discovery_paper' | 'review_item' | 'general';
  context_ref_id?: string;
  wallet_address: string;
  agent_id: string;
  title: string;
  status: 'active' | 'archived';
  latest_gateway_text_session_id?: string;
  latest_gateway_voice_session_id?: string;
  created_at: string;
  updated_at: string;
}

export interface AssistantMessage {
  id: string;
  thread_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  source: 'text' | 'voice' | 'system';
  gateway_message_id?: string;
  created_at: string;
}

export interface AssistantDraft {
  id: string;
  thread_id: string;
  entity_id: string;
  draft_type: 'claim' | 'topic' | 'relation' | 'question';
  payload_json: Record<string, unknown>;
  status: 'draft' | 'accepted' | 'dismissed';
  fingerprint?: string;
  created_at: string;
  updated_at: string;
}

export interface ClaimFeedback {
  id: string;
  paper_id: string;
  claim_index: number;
  rating: 'positive' | 'negative';
  comment: string;
  timestamp: string;
}

export interface AgentActionProposal {
  id: string;
  proposal_id: string;
  action_type: string;
  description: string;
  params_json: Record<string, unknown>;
  status: 'pending' | 'confirmed' | 'rejected' | 'completed' | 'failed';
  wallet_address: string;
  thread_id: string;
  result_json?: Record<string, unknown>;
  created_at: string;
  completed_at?: string;
}

async function createNode(label: string, properties: Record<string, unknown>): Promise<string> {
  const wrapped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (typeof value === 'string') wrapped[key] = { String: value };
    else if (typeof value === 'number') wrapped[key] = Number.isInteger(value) ? { Integer: value } : { Float: value };
    else if (typeof value === 'boolean') wrapped[key] = { Boolean: value };
    else if (Array.isArray(value)) wrapped[key] = { String: JSON.stringify(value) };
    else wrapped[key] = { String: String(value) };
  }

  const res = await fetch(`${KFDB_BASE}/api/v1/write`, {
    method: 'POST',
    headers: WRITE_HEADERS,
    body: JSON.stringify({
      operations: [{ operation: 'create_node', label, properties: wrapped }],
    }),
  });

  if (!res.ok) throw new AppError(502, `Failed to create ${label} in KFDB`);
  const data = await res.json();
  const newId: string = data.affected_ids?.[0];
  if (!newId) throw new AppError(502, 'KFDB did not return an ID');
  return newId;
}

async function getNode<T>(label: string, id: string): Promise<T> {
  const res = await fetch(`${KFDB_BASE}/api/v1/entities/${label}/${id}`, {
    headers: READ_HEADERS,
  });
  if (!res.ok) throw new AppError(404, `${label} not found`);
  const data = await res.json();
  return { ...flattenProps(data.properties), id: data.id } as T;
}

async function listNodes<T>(label: string, limit = 100, offset = 0): Promise<T[]> {
  const url = new URL(`${KFDB_BASE}/api/v1/entities/${label}`);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('offset', String(offset));

  const res = await fetch(url, {
    headers: READ_HEADERS,
  });

  if (!res.ok) {
    if (res.status === 404) return [];
    throw new AppError(502, `Failed to list ${label} from KFDB`);
  }

  const data = await res.json();
  const items: Record<string, unknown>[] = data.items || [];
  return items.map((item) => ({ ...flattenProps(item), id: (item as any)._id || (item as any).id }) as T);
}

async function getNodeWithFallback<T>(label: string, id: string, scanLimit = 1000): Promise<T> {
  try {
    return await getNode<T>(label, id);
  } catch (err: any) {
    if (err?.statusCode !== 404) throw err;

    console.warn(`[KFDB] Direct lookup missed ${label}/${id}. Falling back to filtered scan.`);
    const items = await listNodes<Record<string, unknown>>(label, scanLimit);
    const match = items.find((item) => String((item as any).id) === id || String((item as any)._id) === id);
    if (!match) throw err;
    return { ...match, id } as T;
  }
}

async function filterNodes<T>(
  label: string,
  filters: Record<string, unknown>,
  operators?: Record<string, string>,
  limit = 100,
): Promise<T[]> {
  const res = await fetch(`${KFDB_BASE}/api/v1/entities/${label}/filter`, {
    method: 'POST',
    headers: { ...READ_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filters,
      filter_operators: operators || Object.fromEntries(Object.keys(filters).map((k) => [k, 'eq'])),
      limit,
    }),
  });
  if (!res.ok) {
    if (res.status === 404) return [];
    throw new AppError(502, `Failed to filter ${label} from KFDB`);
  }
  const data = await res.json();
  const items: Record<string, unknown>[] = data.items || [];
  return items.map((item) => ({ ...flattenProps(item), id: (item as any)._id || (item as any).id }) as T);
}

function matchesFallbackFilter(
  item: Record<string, unknown>,
  filters: Record<string, unknown>,
  operators?: Record<string, string>,
): boolean {
  return Object.entries(filters).every(([key, expected]) => {
    const operator = operators?.[key] || 'eq';
    const actual = item[key];

    switch (operator) {
      case 'eq':
      default:
        return String(actual ?? '') === String(expected ?? '');
    }
  });
}

async function filterNodesWithFallback<T>(
  label: string,
  filters: Record<string, unknown>,
  operators?: Record<string, string>,
  limit = 100,
): Promise<T[]> {
  try {
    return await filterNodes<T>(label, filters, operators, limit);
  } catch (err) {
    if (Object.keys(filters).length === 0) throw err;

    console.warn(
      `[KFDB] Filter failed for ${label} with filters ${JSON.stringify(filters)}. Falling back to client-side scan.`,
      err,
    );

    const scanLimit = Math.max(limit * 10, 1000);
    const allItems = await listNodes<Record<string, unknown>>(label, scanLimit);
    return allItems
      .filter((item) => matchesFallbackFilter(item, filters, operators))
      .slice(0, limit) as T[];
  }
}

async function updateNode(label: string, id: string, properties: Record<string, unknown>): Promise<void> {
  const wrapped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (typeof value === 'string') wrapped[key] = { String: value };
    else if (typeof value === 'number') wrapped[key] = Number.isInteger(value) ? { Integer: value } : { Float: value };
    else if (typeof value === 'boolean') wrapped[key] = { Boolean: value };
    else if (Array.isArray(value)) wrapped[key] = { String: JSON.stringify(value) };
    else wrapped[key] = { String: String(value) };
  }

  const res = await fetch(`${KFDB_BASE}/api/v1/write`, {
    method: 'POST',
    headers: WRITE_HEADERS,
    body: JSON.stringify({
      operations: [{ operation: 'update_node', label, id, properties: wrapped }],
    }),
  });
  if (!res.ok) throw new AppError(502, `Failed to update ${label} in KFDB`);
}

async function createEdge(fromLabel: string, fromId: string, edgeType: string, toLabel: string, toId: string): Promise<void> {
  const res = await fetch(`${KFDB_BASE}/api/v1/write`, {
    method: 'POST',
    headers: WRITE_HEADERS,
    body: JSON.stringify({
      operations: [{
        operation: 'create_edge',
        from_label: fromLabel,
        from_id: fromId,
        edge_type: edgeType,
        to_label: toLabel,
        to_id: toId,
      }],
    }),
  });
  if (!res.ok) throw new AppError(502, 'Failed to create edge in KFDB');
}

function flattenProps(props: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const inner = value as Record<string, unknown>;
      const val = inner.String ?? inner.Integer ?? inner.Float ?? inner.Boolean ?? value;
      result[key] = val;
    } else {
      result[key] = value;
    }
  }
  return result;
}

function parseJsonField(value: unknown): string[] {
  if (Array.isArray(value)) return value as string[];
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function parseJsonObjectField<T>(value: unknown, fallback: T): T {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as T;
  }
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return fallback;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 80);
}

function normalizeDiscoveryPaper(raw: Record<string, unknown>): DiscoveryPaper {
  return {
    ...raw,
    authors: parseJsonField(raw.authors),
    topics: parseJsonField(raw.topics),
    claim_count: Number(raw.claim_count) || 0,
    confidence_score: raw.confidence_score != null ? Number(raw.confidence_score) : undefined,
  } as DiscoveryPaper;
}

function normalizePaperCandidate(raw: Record<string, unknown>): PaperCandidate {
  return {
    ...raw,
    authors: parseJsonField(raw.authors),
    categories: parseJsonField(raw.categories),
    score_breakdown: parseJsonObjectField<Record<string, number>>(raw.score_breakdown, {}),
    score_total: Number(raw.score_total) || 0,
    novelty_score: Number(raw.novelty_score) || 0,
    graph_fit_score: Number(raw.graph_fit_score) || 0,
  } as PaperCandidate;
}

function normalizeTopicProfile(raw: Record<string, unknown>): TopicProfile {
  return {
    ...raw,
    categories: parseJsonField(raw.categories),
    keywords: parseJsonField(raw.keywords),
    min_candidate_score: Number(raw.min_candidate_score) || 0,
    max_daily_extractions: Number(raw.max_daily_extractions) || 0,
  } as TopicProfile;
}

function normalizeDiscoveryRun(raw: Record<string, unknown>): DiscoveryRun {
  return {
    ...raw,
    candidate_count: Number(raw.candidate_count) || 0,
    promoted_count: Number(raw.promoted_count) || 0,
  } as DiscoveryRun;
}

function normalizeResearchTopic(raw: Record<string, unknown>): ResearchTopic {
  return {
    ...raw,
    paper_count: Number(raw.paper_count) || 0,
    claim_count: Number(raw.claim_count) || 0,
    trend_score: Number(raw.trend_score) || 0,
  } as ResearchTopic;
}

function normalizeTopicSnapshot(raw: Record<string, unknown>): TopicSnapshot {
  return {
    ...raw,
    paper_count: Number(raw.paper_count) || 0,
    new_paper_count: Number(raw.new_paper_count) || 0,
    claim_count: Number(raw.claim_count) || 0,
    velocity_score: Number(raw.velocity_score) || 0,
    top_paper_ids: parseJsonField(raw.top_paper_ids),
    top_claim_ids: parseJsonField(raw.top_claim_ids),
  } as TopicSnapshot;
}

function normalizeTopicMembership(raw: Record<string, unknown>): TopicMembership {
  return {
    ...raw,
    confidence: Number(raw.confidence) || 0,
  } as TopicMembership;
}

function normalizeAssistantThread(raw: Record<string, unknown>): AssistantThread {
  const contextTypeRaw = String(raw.context_type || '').trim();
  const contextType = (
    contextTypeRaw === 'published_paper' ||
    contextTypeRaw === 'discovery_paper' ||
    contextTypeRaw === 'review_item' ||
    contextTypeRaw === 'general'
  ) ? contextTypeRaw as AssistantThread['context_type'] : undefined;
  const contextRefId = String(raw.context_ref_id || raw.entity_id || '').trim() || undefined;

  return {
    ...raw,
    status: (raw.status as AssistantThread['status']) || 'active',
    context_type: contextType || 'published_paper',
    context_ref_id: contextRefId,
  } as AssistantThread;
}

function normalizeAssistantMessage(raw: Record<string, unknown>): AssistantMessage {
  return {
    ...raw,
    role: (raw.role as AssistantMessage['role']) || 'assistant',
    source: (raw.source as AssistantMessage['source']) || 'text',
  } as AssistantMessage;
}

function normalizeAssistantDraft(raw: Record<string, unknown>): AssistantDraft {
  return {
    ...raw,
    draft_type: (raw.draft_type as AssistantDraft['draft_type']) || 'question',
    status: (raw.status as AssistantDraft['status']) || 'draft',
    payload_json: parseJsonObjectField<Record<string, unknown>>(raw.payload_json, {}),
  } as AssistantDraft;
}

function normalizeAgentActionProposal(raw: Record<string, unknown>): AgentActionProposal {
  return {
    ...raw,
    status: (raw.status as AgentActionProposal['status']) || 'pending',
    params_json: parseJsonObjectField<Record<string, unknown>>(raw.params_json, {}),
    result_json: raw.result_json ? parseJsonObjectField<Record<string, unknown>>(raw.result_json, {}) : undefined,
  } as AgentActionProposal;
}

export async function createDiscoveryPaper(paper: Omit<DiscoveryPaper, 'id' | 'created_at'>): Promise<DiscoveryPaper> {
  const id = await createNode('discovery_paper', {
    ...paper,
    authors: JSON.stringify(paper.authors),
    topics: JSON.stringify(paper.topics),
    created_at: new Date().toISOString(),
  });
  return getDiscoveryPaper(id);
}

export async function getDiscoveryPaper(id: string): Promise<DiscoveryPaper> {
  const raw = await getNodeWithFallback<Record<string, unknown>>('discovery_paper', id);
  return normalizeDiscoveryPaper(raw);
}

export async function listDiscoveryPapers(status?: string, limit = 50): Promise<DiscoveryPaper[]> {
  if (!status) {
    const raws = await listNodes<Record<string, unknown>>('discovery_paper', limit);
    return raws.map(normalizeDiscoveryPaper);
  }

  const filters: Record<string, unknown> = { status };
  const operators: Record<string, string> = { status: 'eq' };
  const raws = await filterNodesWithFallback<Record<string, unknown>>('discovery_paper', filters, operators, limit);
  return raws.map(normalizeDiscoveryPaper);
}

export async function listDiscoveryPapersForTopicProfile(topicProfileId: string, limit = 100): Promise<DiscoveryPaper[]> {
  const raws = await filterNodesWithFallback<Record<string, unknown>>(
    'discovery_paper',
    { topic_profile_id: topicProfileId },
    { topic_profile_id: 'eq' },
    limit,
  );
  return raws.map(normalizeDiscoveryPaper);
}

export async function updateDiscoveryPaperStatus(id: string, status: DiscoveryPaper['status']): Promise<void> {
  await updateNode('discovery_paper', id, { status });
}

export async function updateDiscoveryPaper(id: string, updates: Record<string, unknown>): Promise<void> {
  await updateNode('discovery_paper', id, updates);
}

export async function deleteDiscoveryPaper(id: string): Promise<void> {
  const res = await fetch(`${KFDB_BASE}/api/v1/write`, {
    method: 'POST',
    headers: WRITE_HEADERS,
    body: JSON.stringify({
      operations: [{ operation: 'delete_node', label: 'discovery_paper', id }],
    }),
  });
  if (!res.ok) throw new AppError(502, 'Failed to delete discovery_paper from KFDB');
}

export async function findPaperByArxivId(arxivId: string): Promise<DiscoveryPaper | null> {
  const results = await filterNodesWithFallback<Record<string, unknown>>('discovery_paper', { arxiv_id: arxivId }, { arxiv_id: 'eq' }, 1);
  if (results.length === 0) return null;
  return normalizeDiscoveryPaper(results[0]);
}

export async function createExtractedClaim(claim: Omit<ExtractedClaim, 'id'>): Promise<ExtractedClaim> {
  const id = await createNode('extracted_claim', claim);
  return getNode<ExtractedClaim>('extracted_claim', id);
}

export async function getClaimsForPaper(paperKfdbId: string): Promise<ExtractedClaim[]> {
  return filterNodes<ExtractedClaim>('extracted_claim', { paper_kfdb_id: paperKfdbId });
}

export async function getClaim(id: string): Promise<ExtractedClaim> {
  return getNode<ExtractedClaim>('extracted_claim', id);
}

export async function updateClaim(id: string, updates: Partial<ExtractedClaim>): Promise<void> {
  await updateNode('extracted_claim', id, updates as Record<string, unknown>);
}

export async function deleteClaim(id: string): Promise<void> {
  const res = await fetch(`${KFDB_BASE}/api/v1/write`, {
    method: 'POST',
    headers: WRITE_HEADERS,
    body: JSON.stringify({
      operations: [{ operation: 'delete_node', label: 'extracted_claim', id }],
    }),
  });
  if (!res.ok) throw new AppError(502, 'Failed to delete extracted_claim from KFDB');
}

export async function createClaimFeedback(feedback: Omit<ClaimFeedback, 'id'>): Promise<ClaimFeedback> {
  const id = await createNode('claim_feedback', {
    paper_id: feedback.paper_id,
    claim_index: feedback.claim_index,
    rating: feedback.rating,
    comment: feedback.comment || '',
    timestamp: feedback.timestamp || new Date().toISOString(),
  });
  return getNode<ClaimFeedback>('claim_feedback', id);
}

export async function getClaimFeedbacks(paperId: string): Promise<ClaimFeedback[]> {
  return filterNodes<ClaimFeedback>('claim_feedback', { paper_id: paperId });
}

export async function createReviewItem(walletAddress: string, paperKfdbId: string): Promise<ReviewItem> {
  const id = await createNode('review_item', {
    wallet_address: walletAddress,
    paper_kfdb_id: paperKfdbId,
    status: 'pending',
    feedback: '',
    assigned_at: new Date().toISOString(),
    reviewed_at: '',
  });
  try {
    await createEdge('review_item', id, 'REVIEWS', 'discovery_paper', paperKfdbId);
  } catch {
    console.warn(`[KFDB] Failed to create REVIEWS edge for review_item ${id}, continuing without edge`);
  }
  return getNode<ReviewItem>('review_item', id);
}

export async function getReviewItems(walletAddress: string): Promise<ReviewItem[]> {
  return filterNodes<ReviewItem>('review_item', { wallet_address: walletAddress });
}

export async function getReviewItem(id: string): Promise<ReviewItem> {
  return getNode<ReviewItem>('review_item', id);
}

export async function updateReviewItem(id: string, updates: Partial<ReviewItem>): Promise<void> {
  await updateNode('review_item', id, {
    ...(updates as Record<string, unknown>),
    reviewed_at: new Date().toISOString(),
  });
}

export async function createPublishedRecord(record: Omit<PublishedRecord, 'id'>): Promise<PublishedRecord> {
  const id = await createNode('published_record', {
    ...record,
    geo_claim_entity_ids: JSON.stringify(record.geo_claim_entity_ids),
  });
  try {
    await createEdge('published_record', id, 'PUBLISHES', 'discovery_paper', record.paper_kfdb_id);
  } catch {
    console.warn(`[KFDB] Failed to create PUBLISHES edge for published_record ${id}, continuing without edge`);
  }
  return getNode<PublishedRecord>('published_record', id);
}

export async function getPublishedRecords(limit = 50): Promise<PublishedRecord[]> {
  const raws = await filterNodes<Record<string, unknown>>('published_record', {}, {}, limit);
  return raws.map((raw) => ({
    ...raw,
    geo_claim_entity_ids: parseJsonField(raw.geo_claim_entity_ids),
  })) as PublishedRecord[];
}

export async function createAnnotation(annotation: Omit<PdfAnnotation, 'id' | 'created_at'>): Promise<PdfAnnotation> {
  const id = await createNode('pdf_annotation', {
    ...annotation,
    created_at: new Date().toISOString(),
  });
  return getNode<PdfAnnotation>('pdf_annotation', id);
}

export async function getAnnotations(paperId: string): Promise<PdfAnnotation[]> {
  return filterNodes<PdfAnnotation>('pdf_annotation', { paper_id: paperId });
}

export async function deleteAnnotation(id: string): Promise<void> {
  const res = await fetch(`${KFDB_BASE}/api/v1/write`, {
    method: 'POST',
    headers: WRITE_HEADERS,
    body: JSON.stringify({
      operations: [{ operation: 'delete_node', label: 'pdf_annotation', id }],
    }),
  });
  if (!res.ok) throw new AppError(502, 'Failed to delete pdf_annotation from KFDB');
}

export async function getDiscoveryConfig(): Promise<DiscoveryConfig | null> {
  const results = await filterNodes<DiscoveryConfig>('discovery_config', {}, {}, 1);
  return results.length > 0 ? results[0] : null;
}

export async function updateDiscoveryConfig(configUpdate: Partial<Omit<DiscoveryConfig, 'id'>>): Promise<DiscoveryConfig> {
  const existing = await getDiscoveryConfig();
  if (existing) {
    await updateNode('discovery_config', existing.id, configUpdate as Record<string, unknown>);
    return getNode<DiscoveryConfig>('discovery_config', existing.id);
  }
  const id = await createNode('discovery_config', {
    categories: configUpdate.categories || '',
    keywords: configUpdate.keywords || '',
    min_relevance_score: configUpdate.min_relevance_score ?? 50,
    enabled: configUpdate.enabled || 'false',
  });
  return getNode<DiscoveryConfig>('discovery_config', id);
}

export async function createPaperRelationship(rel: Omit<PaperRelationship, 'id'>): Promise<PaperRelationship> {
  const id = await createNode('paper_relationship', rel);
  try {
    await createEdge('paper_relationship', id, rel.relationship_type.toUpperCase(), 'discovery_paper', rel.target_paper_id);
  } catch {
    console.warn(`[KFDB] Failed to create ${rel.relationship_type} edge, continuing without edge`);
  }
  return getNode<PaperRelationship>('paper_relationship', id);
}

export async function getPaperRelationships(paperId: string): Promise<PaperRelationship[]> {
  const asSource = await filterNodes<PaperRelationship>('paper_relationship', { source_paper_id: paperId });
  const asTarget = await filterNodes<PaperRelationship>('paper_relationship', { target_paper_id: paperId });
  const seen = new Set<string>();
  const all: PaperRelationship[] = [];
  for (const rel of [...asSource, ...asTarget]) {
    if (!seen.has(rel.id)) {
      seen.add(rel.id);
      all.push(rel);
    }
  }
  return all;
}

export async function createTopicEdge(sourcePaperId: string, targetPaperId: string, similarity: number): Promise<PaperRelationship> {
  const id = await createNode('paper_relationship', {
    source_paper_id: sourcePaperId,
    target_paper_id: targetPaperId,
    relationship_type: 'shares_topic',
    similarity_score: similarity,
  });
  try {
    await createEdge('paper_relationship', id, 'SHARES_TOPIC', 'discovery_paper', targetPaperId);
  } catch {
    console.warn('[KFDB] Failed to create SHARES_TOPIC edge, continuing without edge');
  }
  return getNode<PaperRelationship>('paper_relationship', id);
}

export async function createAuthorEdge(sourcePaperId: string, targetPaperId: string, sharedAuthors: string[]): Promise<PaperRelationship> {
  const id = await createNode('paper_relationship', {
    source_paper_id: sourcePaperId,
    target_paper_id: targetPaperId,
    relationship_type: 'shares_author',
    shared_authors: JSON.stringify(sharedAuthors),
  });
  try {
    await createEdge('paper_relationship', id, 'SHARES_AUTHOR', 'discovery_paper', targetPaperId);
  } catch {
    console.warn('[KFDB] Failed to create SHARES_AUTHOR edge, continuing without edge');
  }
  return getNode<PaperRelationship>('paper_relationship', id);
}

export async function createContainsEdge(paperId: string, claimId: string): Promise<void> {
  try {
    await createEdge('discovery_paper', paperId, 'CONTAINS', 'extracted_claim', claimId);
  } catch {
    console.warn(`[KFDB] Failed to create CONTAINS edge for paper ${paperId} -> claim ${claimId}, continuing without edge`);
  }
}

export async function countAllDiscoveryPapers(): Promise<number> {
  const all = await filterNodes<Record<string, unknown>>('discovery_paper', {}, {}, 1000);
  return all.length;
}

export async function countRelationshipsByType(): Promise<Record<string, number>> {
  const all = await filterNodes<PaperRelationship>('paper_relationship', {}, {}, 5000);
  const counts: Record<string, number> = {};
  for (const rel of all) {
    counts[rel.relationship_type] = (counts[rel.relationship_type] || 0) + 1;
  }
  return counts;
}

export async function createTopicProfile(profile: Omit<TopicProfile, 'id' | 'created_at' | 'updated_at'>): Promise<TopicProfile> {
  const now = new Date().toISOString();
  const id = await createNode('topic_profile', {
    ...profile,
    categories: JSON.stringify(profile.categories),
    keywords: JSON.stringify(profile.keywords),
    created_at: now,
    updated_at: now,
  });
  return getTopicProfile(id);
}

export async function getTopicProfile(id: string): Promise<TopicProfile> {
  const raw = await getNode<Record<string, unknown>>('topic_profile', id);
  return normalizeTopicProfile(raw);
}

export async function listTopicProfiles(ownerWallet?: string, limit = 100): Promise<TopicProfile[]> {
  const filters: Record<string, unknown> = ownerWallet ? { owner_wallet: ownerWallet } : {};
  const operators: Record<string, string> = ownerWallet ? { owner_wallet: 'eq' } : {};
  const raws = await filterNodes<Record<string, unknown>>('topic_profile', filters, operators, limit);
  return raws.map(normalizeTopicProfile);
}

export async function updateTopicProfile(id: string, updates: Partial<Omit<TopicProfile, 'id' | 'created_at' | 'updated_at'>>): Promise<TopicProfile> {
  const payload: Record<string, unknown> = {
    ...updates,
    updated_at: new Date().toISOString(),
  };
  if (updates.categories) payload.categories = JSON.stringify(updates.categories);
  if (updates.keywords) payload.keywords = JSON.stringify(updates.keywords);
  await updateNode('topic_profile', id, payload);
  return getTopicProfile(id);
}

export async function createDiscoveryRun(run: Omit<DiscoveryRun, 'id'>): Promise<DiscoveryRun> {
  const id = await createNode('discovery_run', run);
  return getDiscoveryRun(id);
}

export async function getDiscoveryRun(id: string): Promise<DiscoveryRun> {
  const raw = await getNodeWithFallback<Record<string, unknown>>('discovery_run', id);
  return normalizeDiscoveryRun(raw);
}

export async function updateDiscoveryRun(id: string, updates: Partial<DiscoveryRun>): Promise<DiscoveryRun> {
  await updateNode('discovery_run', id, updates as Record<string, unknown>);
  return getDiscoveryRun(id);
}

export async function listDiscoveryRuns(status?: DiscoveryRun['status'], limit = 100): Promise<DiscoveryRun[]> {
  const filters: Record<string, unknown> = status ? { status } : {};
  const operators: Record<string, string> = status ? { status: 'eq' } : {};
  const raws = await filterNodesWithFallback<Record<string, unknown>>('discovery_run', filters, operators, limit);
  return raws.map(normalizeDiscoveryRun);
}

export async function listDiscoveryRunsForTopicProfile(topicProfileId: string, limit = 100): Promise<DiscoveryRun[]> {
  const raws = await filterNodesWithFallback<Record<string, unknown>>(
    'discovery_run',
    { topic_profile_id: topicProfileId },
    { topic_profile_id: 'eq' },
    limit,
  );
  return raws.map(normalizeDiscoveryRun);
}

export async function findDiscoveryRunByWindow(topicProfileId: string, queryWindowStart: string, queryWindowEnd: string): Promise<DiscoveryRun | null> {
  const runs = await filterNodesWithFallback<Record<string, unknown>>(
    'discovery_run',
    { topic_profile_id: topicProfileId, query_window_start: queryWindowStart, query_window_end: queryWindowEnd },
    { topic_profile_id: 'eq', query_window_start: 'eq', query_window_end: 'eq' },
    1,
  );
  return runs[0] ? normalizeDiscoveryRun(runs[0]) : null;
}

export async function createPaperCandidate(candidate: Omit<PaperCandidate, 'id' | 'created_at' | 'updated_at'>): Promise<PaperCandidate> {
  const now = new Date().toISOString();
  const id = await createNode('paper_candidate', {
    ...candidate,
    authors: JSON.stringify(candidate.authors),
    categories: JSON.stringify(candidate.categories),
    score_breakdown: JSON.stringify(candidate.score_breakdown),
    created_at: now,
    updated_at: now,
  });
  try {
    await createEdge('paper_candidate', id, 'CANDIDATE_FOR', 'topic_profile', candidate.topic_profile_id);
  } catch {
    console.warn(`[KFDB] Failed to create CANDIDATE_FOR edge for paper_candidate ${id}, continuing without edge`);
  }
  return getPaperCandidate(id);
}

export async function getPaperCandidate(id: string): Promise<PaperCandidate> {
  const raw = await getNodeWithFallback<Record<string, unknown>>('paper_candidate', id);
  return normalizePaperCandidate(raw);
}

export async function updatePaperCandidate(id: string, updates: Partial<PaperCandidate>): Promise<PaperCandidate> {
  const payload: Record<string, unknown> = {
    ...updates,
    updated_at: new Date().toISOString(),
  };
  if (updates.authors) payload.authors = JSON.stringify(updates.authors);
  if (updates.categories) payload.categories = JSON.stringify(updates.categories);
  if (updates.score_breakdown) payload.score_breakdown = JSON.stringify(updates.score_breakdown);
  await updateNode('paper_candidate', id, payload);
  return getPaperCandidate(id);
}

export async function listPaperCandidates(options: {
  status?: PaperCandidate['status'];
  topicProfileId?: string;
  limit?: number;
} = {}): Promise<PaperCandidate[]> {
  const filters: Record<string, unknown> = {};
  const operators: Record<string, string> = {};
  if (options.status) {
    filters.status = options.status;
    operators.status = 'eq';
  }
  if (options.topicProfileId) {
    filters.topic_profile_id = options.topicProfileId;
    operators.topic_profile_id = 'eq';
  }
  const raws = await filterNodesWithFallback<Record<string, unknown>>('paper_candidate', filters, operators, options.limit || 100);
  return raws.map(normalizePaperCandidate);
}

export async function findPaperCandidateByArxiv(topicProfileId: string, arxivId: string): Promise<PaperCandidate | null> {
  const raws = await filterNodes<Record<string, unknown>>(
    'paper_candidate',
    { topic_profile_id: topicProfileId, arxiv_id: arxivId },
    { topic_profile_id: 'eq', arxiv_id: 'eq' },
    1,
  );
  return raws[0] ? normalizePaperCandidate(raws[0]) : null;
}

export async function createResearchTopic(topic: Omit<ResearchTopic, 'id' | 'slug' | 'created_at' | 'updated_at'> & { slug?: string }): Promise<ResearchTopic> {
  const now = new Date().toISOString();
  const id = await createNode('research_topic', {
    ...topic,
    slug: topic.slug || slugify(topic.name),
    created_at: now,
    updated_at: now,
  });
  return getResearchTopic(id);
}

export async function getResearchTopic(id: string): Promise<ResearchTopic> {
  const raw = await getNode<Record<string, unknown>>('research_topic', id);
  return normalizeResearchTopic(raw);
}

export async function listResearchTopics(options: { topicProfileId?: string; limit?: number } = {}): Promise<ResearchTopic[]> {
  const filters: Record<string, unknown> = options.topicProfileId ? { topic_profile_id: options.topicProfileId } : {};
  const operators: Record<string, string> = options.topicProfileId ? { topic_profile_id: 'eq' } : {};
  const raws = await filterNodesWithFallback<Record<string, unknown>>('research_topic', filters, operators, options.limit || 100);
  return raws.map(normalizeResearchTopic);
}

export async function findResearchTopicByName(topicProfileId: string, name: string): Promise<ResearchTopic | null> {
  const raws = await filterNodes<Record<string, unknown>>(
    'research_topic',
    { topic_profile_id: topicProfileId, slug: slugify(name) },
    { topic_profile_id: 'eq', slug: 'eq' },
    1,
  );
  return raws[0] ? normalizeResearchTopic(raws[0]) : null;
}

export async function findOrCreateResearchTopic(topicProfileId: string, name: string, description = ''): Promise<ResearchTopic> {
  const existing = await findResearchTopicByName(topicProfileId, name);
  if (existing) return existing;
  return createResearchTopic({
    topic_profile_id: topicProfileId,
    name,
    description,
    paper_count: 0,
    claim_count: 0,
    trend_score: 0,
    last_seen_at: new Date().toISOString(),
  });
}

export async function updateResearchTopic(id: string, updates: Partial<ResearchTopic>): Promise<ResearchTopic> {
  await updateNode('research_topic', id, {
    ...updates,
    updated_at: new Date().toISOString(),
  } as Record<string, unknown>);
  return getResearchTopic(id);
}

export async function createTopicMembership(membership: Omit<TopicMembership, 'id' | 'created_at'>): Promise<TopicMembership> {
  const existing = await findTopicMembership(membership.topic_id, membership.entity_type, membership.entity_id);
  if (existing) return existing;
  const id = await createNode('topic_membership', {
    ...membership,
    created_at: new Date().toISOString(),
  });
  try {
    await createEdge('topic_membership', id, 'BELONGS_TO_TOPIC', 'research_topic', membership.topic_id);
  } catch {
    console.warn(`[KFDB] Failed to create BELONGS_TO_TOPIC edge for topic_membership ${id}, continuing without edge`);
  }
  return getTopicMembership(id);
}

export async function getTopicMembership(id: string): Promise<TopicMembership> {
  const raw = await getNode<Record<string, unknown>>('topic_membership', id);
  return normalizeTopicMembership(raw);
}

export async function findTopicMembership(topicId: string, entityType: TopicMembership['entity_type'], entityId: string): Promise<TopicMembership | null> {
  const raws = await filterNodes<Record<string, unknown>>(
    'topic_membership',
    { topic_id: topicId, entity_type: entityType, entity_id: entityId },
    { topic_id: 'eq', entity_type: 'eq', entity_id: 'eq' },
    1,
  );
  return raws[0] ? normalizeTopicMembership(raws[0]) : null;
}

export async function listTopicMembershipsByTopic(topicId: string, limit = 500): Promise<TopicMembership[]> {
  const raws = await filterNodes<Record<string, unknown>>('topic_membership', { topic_id: topicId }, { topic_id: 'eq' }, limit);
  return raws.map(normalizeTopicMembership);
}

export async function listTopicMembershipsForEntity(entityType: TopicMembership['entity_type'], entityId: string, limit = 500): Promise<TopicMembership[]> {
  const raws = await filterNodes<Record<string, unknown>>(
    'topic_membership',
    { entity_type: entityType, entity_id: entityId },
    { entity_type: 'eq', entity_id: 'eq' },
    limit,
  );
  return raws.map(normalizeTopicMembership);
}

export async function createTopicSnapshot(snapshot: Omit<TopicSnapshot, 'id' | 'created_at'>): Promise<TopicSnapshot> {
  const id = await createNode('topic_snapshot', {
    ...snapshot,
    top_paper_ids: JSON.stringify(snapshot.top_paper_ids),
    top_claim_ids: JSON.stringify(snapshot.top_claim_ids),
    created_at: new Date().toISOString(),
  });
  return getTopicSnapshot(id);
}

export async function getTopicSnapshot(id: string): Promise<TopicSnapshot> {
  const raw = await getNode<Record<string, unknown>>('topic_snapshot', id);
  return normalizeTopicSnapshot(raw);
}

export async function listTopicSnapshots(topicProfileId: string, limit = 100): Promise<TopicSnapshot[]> {
  const raws = await filterNodesWithFallback<Record<string, unknown>>(
    'topic_snapshot',
    { topic_profile_id: topicProfileId },
    { topic_profile_id: 'eq' },
    limit,
  );
  return raws.map(normalizeTopicSnapshot);
}

export async function getLatestTopicSnapshot(topicProfileId: string): Promise<TopicSnapshot | null> {
  const snapshots = await listTopicSnapshots(topicProfileId, 100);
  snapshots.sort((a, b) => new Date(b.snapshot_date).getTime() - new Date(a.snapshot_date).getTime());
  return snapshots[0] || null;
}

export async function createAssistantThread(
  thread: Omit<AssistantThread, 'id' | 'created_at' | 'updated_at'>,
): Promise<AssistantThread> {
  const now = new Date().toISOString();
  const id = await createNode('assistant_thread', {
    ...thread,
    created_at: now,
    updated_at: now,
  });
  return getAssistantThread(id);
}

export async function getAssistantThread(id: string): Promise<AssistantThread> {
  const raw = await getNodeWithFallback<Record<string, unknown>>('assistant_thread', id);
  return normalizeAssistantThread(raw);
}

export async function updateAssistantThread(
  id: string,
  updates: Partial<Omit<AssistantThread, 'id' | 'created_at' | 'wallet_address' | 'entity_id' | 'agent_id'>>,
): Promise<AssistantThread> {
  await updateNode('assistant_thread', id, {
    ...updates,
    updated_at: new Date().toISOString(),
  } as Record<string, unknown>);
  return getAssistantThread(id);
}

export async function listAssistantThreads(options: {
  walletAddress: string;
  entityId?: string;
  contextType?: AssistantThread['context_type'];
  contextRefId?: string;
  status?: AssistantThread['status'];
  limit?: number;
}): Promise<AssistantThread[]> {
  const filters: Record<string, unknown> = { wallet_address: options.walletAddress };
  const operators: Record<string, string> = { wallet_address: 'eq' };

  if (options.entityId) {
    filters.entity_id = options.entityId;
    operators.entity_id = 'eq';
  }
  if (options.contextType) {
    if (options.contextType === 'published_paper') {
      // Preserve legacy threads that only have entity_id populated.
      if (options.contextRefId && !options.entityId) {
        filters.entity_id = options.contextRefId;
        operators.entity_id = 'eq';
      }
    } else {
      filters.context_type = options.contextType;
      operators.context_type = 'eq';
    }
  }
  if (options.contextRefId && options.contextType !== 'published_paper') {
    filters.context_ref_id = options.contextRefId;
    operators.context_ref_id = 'eq';
  }
  if (options.status) {
    filters.status = options.status;
    operators.status = 'eq';
  }

  const raws = await filterNodesWithFallback<Record<string, unknown>>(
    'assistant_thread',
    filters,
    operators,
    options.limit || 200,
  );

  return raws
    .map(normalizeAssistantThread)
    .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
}

export async function findActiveAssistantThread(
  walletAddress: string,
  contextType: NonNullable<AssistantThread['context_type']>,
  contextRefId: string,
): Promise<AssistantThread | null> {
  const threads = await listAssistantThreads({
    walletAddress,
    contextType,
    contextRefId,
    status: 'active',
    limit: 50,
  });
  return threads[0] || null;
}

export async function createAssistantMessage(
  message: Omit<AssistantMessage, 'id' | 'created_at'>,
): Promise<AssistantMessage> {
  const id = await createNode('assistant_message', {
    ...message,
    created_at: new Date().toISOString(),
  });
  return getAssistantMessage(id);
}

export async function getAssistantMessage(id: string): Promise<AssistantMessage> {
  const raw = await getNodeWithFallback<Record<string, unknown>>('assistant_message', id);
  return normalizeAssistantMessage(raw);
}

export async function listAssistantMessages(threadId: string, limit = 500): Promise<AssistantMessage[]> {
  const raws = await filterNodesWithFallback<Record<string, unknown>>(
    'assistant_message',
    { thread_id: threadId },
    { thread_id: 'eq' },
    limit,
  );
  return raws
    .map(normalizeAssistantMessage)
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
}

export async function createAssistantDraft(
  draft: Omit<AssistantDraft, 'id' | 'created_at' | 'updated_at'>,
): Promise<AssistantDraft> {
  const now = new Date().toISOString();
  const id = await createNode('assistant_draft', {
    ...draft,
    payload_json: JSON.stringify(draft.payload_json),
    created_at: now,
    updated_at: now,
  });
  return getAssistantDraft(id);
}

export async function getAssistantDraft(id: string): Promise<AssistantDraft> {
  const raw = await getNodeWithFallback<Record<string, unknown>>('assistant_draft', id);
  return normalizeAssistantDraft(raw);
}

export async function listAssistantDrafts(
  threadId: string,
  status?: AssistantDraft['status'],
  limit = 500,
): Promise<AssistantDraft[]> {
  const filters: Record<string, unknown> = { thread_id: threadId };
  const operators: Record<string, string> = { thread_id: 'eq' };
  if (status) {
    filters.status = status;
    operators.status = 'eq';
  }
  const raws = await filterNodesWithFallback<Record<string, unknown>>('assistant_draft', filters, operators, limit);
  return raws
    .map(normalizeAssistantDraft)
    .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
}

export async function findAssistantDraftByFingerprint(
  threadId: string,
  fingerprint: string,
): Promise<AssistantDraft | null> {
  const raws = await filterNodesWithFallback<Record<string, unknown>>(
    'assistant_draft',
    { thread_id: threadId, fingerprint },
    { thread_id: 'eq', fingerprint: 'eq' },
    1,
  );
  return raws[0] ? normalizeAssistantDraft(raws[0]) : null;
}

export async function updateAssistantDraft(
  id: string,
  updates: Partial<Omit<AssistantDraft, 'id' | 'thread_id' | 'entity_id' | 'created_at'>>,
): Promise<AssistantDraft> {
  const payload: Record<string, unknown> = {
    ...updates,
    updated_at: new Date().toISOString(),
  };
  if (updates.payload_json) payload.payload_json = JSON.stringify(updates.payload_json);
  await updateNode('assistant_draft', id, payload);
  return getAssistantDraft(id);
}

export async function createActionProposal(
  data: Omit<AgentActionProposal, 'id' | 'created_at'>,
): Promise<AgentActionProposal> {
  const id = await createNode('agent_action_proposal', {
    ...data,
    params_json: JSON.stringify(data.params_json),
    result_json: data.result_json ? JSON.stringify(data.result_json) : '',
    created_at: new Date().toISOString(),
  });
  return getActionProposal(id);
}

export async function getActionProposal(id: string): Promise<AgentActionProposal> {
  const raw = await getNodeWithFallback<Record<string, unknown>>('agent_action_proposal', id);
  return normalizeAgentActionProposal(raw);
}

export async function updateActionProposal(
  id: string,
  updates: Partial<Omit<AgentActionProposal, 'id' | 'created_at' | 'wallet_address' | 'thread_id'>>,
): Promise<AgentActionProposal> {
  const payload: Record<string, unknown> = { ...updates };
  if (updates.params_json) payload.params_json = JSON.stringify(updates.params_json);
  if (updates.result_json) payload.result_json = JSON.stringify(updates.result_json);
  await updateNode('agent_action_proposal', id, payload);
  return getActionProposal(id);
}
