import * as GeoQuery from './GeoQuery.js';
import * as KfdbService from './KfdbService.js';
import * as PaperRecommendation from './PaperRecommendation.js';

export interface PublishedPaperContext {
  entity_id: string;
  entity: GeoQuery.GeoEntity;
  published_claims: GeoQuery.GeoEntity[];
  published_record: KfdbService.PublishedRecord | null;
  discovery_paper: KfdbService.DiscoveryPaper | null;
  extracted_claims: KfdbService.ExtractedClaim[];
  topic_context: Array<{ topic_id: string; topic_name: string; confidence: number }>;
  related_papers: Array<{ id: string; title: string; score: number; reason: string }>;
  context_sources: string[];
}

function shorten(text: string, limit: number): string {
  if (!text) return '';
  return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
}

export async function getPublishedPaperContext(entityId: string): Promise<PublishedPaperContext> {
  const entity = await GeoQuery.getGeoEntity(entityId);
  if (!entity) {
    throw new Error('Published entity not found');
  }

  // We support paper pages in v1. Non-paper entities can still read context but will have sparse fields.
  const isPaper = entity.types.some((type) => type.toLowerCase() === 'paper');

  let records: KfdbService.PublishedRecord[] = [];
  try {
    records = await KfdbService.getPublishedRecords(500);
  } catch {
    records = [];
  }
  const normalizedEntityId = entityId.replace(/-/g, '').toLowerCase();
  const publishedRecord = records.find((record) =>
    record.geo_paper_entity_id.replace(/-/g, '').toLowerCase() === normalizedEntityId,
  ) || null;

  let publishedClaims: GeoQuery.GeoEntity[] = [];
  if (publishedRecord?.geo_claim_entity_ids?.length) {
    const claimResults = await Promise.all(
      publishedRecord.geo_claim_entity_ids.map((claimId) => GeoQuery.getGeoEntity(claimId).catch(() => null)),
    );
    publishedClaims = claimResults.filter(Boolean) as GeoQuery.GeoEntity[];
  }

  if (publishedClaims.length === 0 && isPaper) {
    publishedClaims = await GeoQuery.listClaimsForPaperEntity(entityId);
  }

  let discoveryPaper: KfdbService.DiscoveryPaper | null = null;
  let extractedClaims: KfdbService.ExtractedClaim[] = [];
  let topicContext: Array<{ topic_id: string; topic_name: string; confidence: number }> = [];
  let relatedPapers: Array<{ id: string; title: string; score: number; reason: string }> = [];

  if (publishedRecord?.paper_kfdb_id) {
    try {
      discoveryPaper = await KfdbService.getDiscoveryPaper(publishedRecord.paper_kfdb_id);
      extractedClaims = await KfdbService.getClaimsForPaper(discoveryPaper.id);

      const memberships = await KfdbService.listTopicMembershipsForEntity('paper', discoveryPaper.id, 100);
      if (memberships.length > 0) {
        const topics = await Promise.all(
          memberships.map(async (membership) => {
            try {
              const topic = await KfdbService.getResearchTopic(membership.topic_id);
              return {
                topic_id: membership.topic_id,
                topic_name: topic.name,
                confidence: membership.confidence,
              };
            } catch {
              return null;
            }
          }),
        );
        topicContext = topics.filter(Boolean) as Array<{ topic_id: string; topic_name: string; confidence: number }>;
      }

      const related = await PaperRecommendation.getRelatedPapers(discoveryPaper.id, 8);
      relatedPapers = related.map((item) => ({
        id: item.paper.id,
        title: item.paper.title,
        score: item.score,
        reason: item.reason,
      }));
    } catch {
      // Context assembly should not fail because one source is unavailable.
    }
  }

  const contextSources = [
    'geo_entity',
    publishedClaims.length > 0 ? 'geo_claims' : '',
    publishedRecord ? 'kfdb_published_record' : '',
    discoveryPaper ? 'kfdb_discovery_paper' : '',
    extractedClaims.length > 0 ? 'kfdb_extracted_claims' : '',
    topicContext.length > 0 ? 'kfdb_topic_memberships' : '',
    relatedPapers.length > 0 ? 'kfdb_related_papers' : '',
  ].filter(Boolean);

  return {
    entity_id: entityId,
    entity,
    published_claims: publishedClaims,
    published_record: publishedRecord,
    discovery_paper: discoveryPaper,
    extracted_claims: extractedClaims,
    topic_context: topicContext,
    related_papers: relatedPapers,
    context_sources: contextSources,
  };
}

export function buildThreadContextPreamble(input: {
  context: PublishedPaperContext;
  recentMessages: KfdbService.AssistantMessage[];
  drafts: KfdbService.AssistantDraft[];
}): string {
  const { context, recentMessages, drafts } = input;
  const entity = context.entity;

  const publishedClaims = context.published_claims.slice(0, 20).map((claim, index) => {
    const description = claim.description || claim.properties?.Description || '';
    return `${index + 1}. ${claim.name}${description ? ` — ${shorten(description, 240)}` : ''}`;
  });

  const extractedClaims = context.extracted_claims.slice(0, 20).map((claim, index) => {
    const claimText = claim.edited_text || claim.text;
    return `${index + 1}. [${claim.role}] ${shorten(claimText, 260)}`;
  });

  const topics = context.topic_context
    .map((topic) => `${topic.topic_name} (${Math.round(topic.confidence * 100)}%)`)
    .join(', ');

  const related = context.related_papers
    .slice(0, 8)
    .map((paper) => `- ${paper.title} (score ${paper.score.toFixed(2)}): ${paper.reason}`)
    .join('\n');

  const recent = recentMessages
    .slice(-8)
    .map((message) => `${message.role.toUpperCase()}: ${shorten(message.content, 280)}`)
    .join('\n');

  const existingDrafts = drafts
    .filter((draft) => draft.status === 'draft')
    .slice(0, 20)
    .map((draft, index) => `${index + 1}. ${draft.draft_type}: ${JSON.stringify(draft.payload_json)}`)
    .join('\n');

  const paperUrl = context.discovery_paper?.web_url
    || context.entity.properties?.['Web URL']
    || context.entity.properties?.web_url
    || '';
  const paperArxivId = context.discovery_paper?.arxiv_id
    || context.entity.properties?.arxiv_id
    || context.entity.properties?.ArXiv
    || context.entity.properties?.['ArXiv ID']
    || '';

  return [
    'You are the research-paper-analyst-geo-uploader agent inside a source-scoped published-paper assistant.',
    'Priority: use tools when the request needs verification, retrieval, download, citations, or paper-level evidence.',
    'If an arXiv ID is provided below, prefer direct arXiv retrieval tools with that ID instead of fuzzy search by title.',
    'If the user asks to "download", "review", "verify", or "analyze the full paper", perform retrieval/extraction tool calls before final conclusions.',
    'Never fabricate tool usage, tool availability, skill lists, ontology IDs, benchmark metrics, or download status.',
    'Allowed actions: read/search/analyze/extract only. Forbidden actions: publish, on-chain mutation, or any external write action.',
    'If a required tool fails, report the failed tool and reason briefly, then continue with best available grounded context.',
    'If asked which tools/skills are available, only report what was actually used in this thread and what is explicitly in this context.',
    'If you discover new structured research updates, append one fenced code block at the end using this exact format:',
    '```research_updates',
    '{"updates":[{"draft_type":"claim|topic|relation|question","title":"...","content":"...","evidence":"...","confidence":0.0}]}',
    '```',
    'Do not include any other machine-readable blocks.',
    '',
    `PAPER ID: ${context.entity_id}`,
    `PAPER NAME: ${entity.name}`,
    `PAPER TYPES: ${(entity.types || []).join(', ')}`,
    `PAPER URL: ${paperUrl || 'Unknown'}`,
    `PAPER ARXIV ID: ${paperArxivId || 'Unknown'}`,
    `PAPER ABSTRACT: ${shorten(entity.properties?.Abstract || entity.description || '', 1400)}`,
    '',
    `PUBLISHED CLAIMS (${publishedClaims.length}):`,
    publishedClaims.length > 0 ? publishedClaims.join('\n') : 'None',
    '',
    `EXTRACTED CLAIMS (${extractedClaims.length}):`,
    extractedClaims.length > 0 ? extractedClaims.join('\n') : 'None',
    '',
    `TOPIC CONTEXT: ${topics || 'None'}`,
    '',
    'RELATED PAPERS:',
    related || 'None',
    '',
    'RECENT THREAD CONTEXT:',
    recent || 'No prior messages.',
    '',
    'EXISTING OPEN DRAFTS:',
    existingDrafts || 'No open drafts.',
  ].join('\n');
}

export function buildVoiceContextBrief(context: PublishedPaperContext, drafts: KfdbService.AssistantDraft[]): string {
  const claimHighlights = context.published_claims
    .slice(0, 5)
    .map((claim, index) => `${index + 1}) ${shorten(claim.name, 160)}`)
    .join('\n');

  const topicHighlights = context.topic_context
    .slice(0, 5)
    .map((topic) => `${topic.topic_name} (${Math.round(topic.confidence * 100)}%)`)
    .join(', ');

  const openDrafts = drafts
    .filter((draft) => draft.status === 'draft')
    .slice(0, 8)
    .map((draft) => `${draft.draft_type}: ${shorten(JSON.stringify(draft.payload_json), 180)}`)
    .join('\n');

  return [
    `You are in a live voice research session for: ${context.entity.name}.`,
    `Abstract: ${shorten(context.entity.properties?.Abstract || context.entity.description || '', 900)}`,
    `Top claims:\n${claimHighlights || 'None'}`,
    `Topics: ${topicHighlights || 'None'}`,
    `Open drafts:\n${openDrafts || 'None'}`,
    'Ask clarifying questions when uncertain. Never claim that a draft was accepted unless the user confirmed it.',
  ].join('\n\n');
}
