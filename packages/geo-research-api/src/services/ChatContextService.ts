import * as KfdbService from './KfdbService.js';
import * as PublishedPaperContextService from './PublishedPaperContextService.js';

export type ChatContextType = 'published_paper' | 'discovery_paper' | 'review_item' | 'general';

export type ChatContext =
  | { type: 'published_paper'; entityId: string; threadId?: string; newThread?: boolean }
  | { type: 'discovery_paper'; paperId: string; threadId?: string; newThread?: boolean }
  | { type: 'review_item'; reviewId: string; threadId?: string; newThread?: boolean }
  | { type: 'general'; contextRefId?: string; label?: string; threadId?: string; newThread?: boolean };

export interface ResolvedContext {
  type: ChatContextType;
  refId: string;
  entityId: string;
}

function shorten(text: string, limit: number): string {
  if (!text) return '';
  return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
}

export function resolveContext(context: ChatContext): ResolvedContext {
  if (context.type === 'published_paper') {
    return { type: 'published_paper', refId: context.entityId, entityId: context.entityId };
  }
  if (context.type === 'discovery_paper') {
    return { type: 'discovery_paper', refId: context.paperId, entityId: context.paperId };
  }
  if (context.type === 'review_item') {
    return { type: 'review_item', refId: context.reviewId, entityId: context.reviewId };
  }
  const ref = context.contextRefId || 'general';
  return { type: 'general', refId: ref, entityId: ref };
}

export function getThreadContext(thread: KfdbService.AssistantThread): ResolvedContext {
  const type = (thread.context_type || 'published_paper') as ChatContextType;
  const refId = thread.context_ref_id || thread.entity_id;
  return { type, refId, entityId: thread.entity_id || refId };
}

export async function getContextTitle(context: ChatContext): Promise<string> {
  if (context.type === 'published_paper') {
    const published = await PublishedPaperContextService.getPublishedPaperContext(context.entityId);
    return published.entity.name || `Published paper ${context.entityId.slice(0, 8)}`;
  }

  if (context.type === 'discovery_paper') {
    const paper = await KfdbService.getDiscoveryPaper(context.paperId);
    return paper.title || `Discovery paper ${context.paperId.slice(0, 8)}`;
  }

  if (context.type === 'review_item') {
    const review = await KfdbService.getReviewItem(context.reviewId);
    const paper = await KfdbService.getDiscoveryPaper(review.paper_kfdb_id);
    return `Review: ${paper.title || review.paper_kfdb_id.slice(0, 8)}`;
  }

  return context.label || 'General Research Thread';
}

export async function buildThreadContextPreamble(input: {
  thread: KfdbService.AssistantThread;
  recentMessages: KfdbService.AssistantMessage[];
  drafts: KfdbService.AssistantDraft[];
}): Promise<string> {
  const { thread, recentMessages, drafts } = input;
  const resolved = getThreadContext(thread);

  if (resolved.type === 'published_paper') {
    const context = await PublishedPaperContextService.getPublishedPaperContext(resolved.refId);
    return PublishedPaperContextService.buildThreadContextPreamble({
      context,
      recentMessages,
      drafts,
    });
  }

  if (resolved.type === 'discovery_paper') {
    const paper = await KfdbService.getDiscoveryPaper(resolved.refId);
    const claims = await KfdbService.getClaimsForPaper(paper.id);
    const recent = recentMessages
      .slice(-8)
      .map((message) => `${message.role.toUpperCase()}: ${shorten(message.content, 240)}`)
      .join('\n');

    return [
      'You are the research-paper-analyst-geo-uploader assistant in a discovery-paper workflow.',
      'Priority: use tools for retrieval, verification, and grounded evidence before strong claims.',
      'You may suggest actionable operations, but never execute writes directly.',
      'When proposing operations, append one fenced machine block at the end:',
      '```agent_actions',
      '{"actions":[{"action":"add_to_review|submit_paper","description":"...","params":{"paperId":"...","arxivId":"..."}}]}',
      '```',
      'You may also append one `research_updates` block for claim/topic/relation/question draft suggestions.',
      '',
      `PAPER ID: ${paper.id}`,
      `ARXIV ID: ${paper.arxiv_id || 'Unknown'}`,
      `TITLE: ${paper.title}`,
      `STATUS: ${paper.status}`,
      `ABSTRACT: ${shorten(paper.abstract || '', 1400)}`,
      `TOPICS: ${(paper.topics || []).join(', ') || 'None'}`,
      '',
      `EXTRACTED CLAIMS (${claims.length}):`,
      claims.length > 0
        ? claims.slice(0, 20).map((claim, index) => `${index + 1}. [${claim.role}] ${shorten(claim.edited_text || claim.text, 220)}`).join('\n')
        : 'None',
      '',
      'RECENT THREAD CONTEXT:',
      recent || 'No prior messages.',
    ].join('\n');
  }

  if (resolved.type === 'review_item') {
    const review = await KfdbService.getReviewItem(resolved.refId);
    const paper = await KfdbService.getDiscoveryPaper(review.paper_kfdb_id);
    const claims = await KfdbService.getClaimsForPaper(paper.id);

    return [
      'You are the research-paper-analyst-geo-uploader assistant in a review workflow.',
      'You can propose review actions, but do not execute them directly.',
      'When proposing actions, append one fenced machine block at the end:',
      '```agent_actions',
      '{"actions":[{"action":"approve_paper|publish_paper|edit_claim","description":"...","params":{"reviewId":"...","paperId":"...","claimId":"...","text":"..."}}]}',
      '```',
      'Never claim an action is completed until user confirmation and API completion.',
      '',
      `REVIEW ID: ${review.id}`,
      `REVIEW STATUS: ${review.status}`,
      `PAPER ID: ${paper.id}`,
      `PAPER STATUS: ${paper.status}`,
      `PAPER TITLE: ${paper.title}`,
      `PAPER ABSTRACT: ${shorten(paper.abstract || '', 1200)}`,
      '',
      `CLAIMS (${claims.length}):`,
      claims.length > 0
        ? claims.slice(0, 30).map((claim, index) => `${index + 1}. (${claim.id}) [${claim.role}] ${shorten(claim.edited_text || claim.text, 240)}`).join('\n')
        : 'None',
    ].join('\n');
  }

  return [
    'You are the research-paper-analyst-geo-uploader assistant in general research mode.',
    'Use tools when verification or retrieval is needed.',
    'You may suggest operations with an `agent_actions` block, but never execute writes directly.',
    'Keep outputs grounded and transparent about uncertainty.',
  ].join('\n');
}

export async function buildVoiceContextBrief(thread: KfdbService.AssistantThread): Promise<string> {
  const resolved = getThreadContext(thread);

  if (resolved.type === 'published_paper') {
    const context = await PublishedPaperContextService.getPublishedPaperContext(resolved.refId);
    const drafts = await KfdbService.listAssistantDrafts(thread.id, undefined, 300);
    return PublishedPaperContextService.buildVoiceContextBrief(context, drafts);
  }

  if (resolved.type === 'discovery_paper') {
    const paper = await KfdbService.getDiscoveryPaper(resolved.refId);
    const claims = await KfdbService.getClaimsForPaper(paper.id);
    return [
      `You are in live voice mode for discovery paper: ${paper.title}.`,
      `ArXiv ID: ${paper.arxiv_id || 'Unknown'}`,
      `Status: ${paper.status}`,
      `Abstract: ${shorten(paper.abstract || '', 900)}`,
      `Top extracted claims:\n${claims.slice(0, 5).map((c, i) => `${i + 1}) ${shorten(c.edited_text || c.text, 160)}`).join('\n') || 'None'}`,
      'You may suggest actions, but never execute writes without user confirmation.',
    ].join('\n\n');
  }

  if (resolved.type === 'review_item') {
    const review = await KfdbService.getReviewItem(resolved.refId);
    const paper = await KfdbService.getDiscoveryPaper(review.paper_kfdb_id);
    return [
      `You are in live voice mode for review item ${review.id}.`,
      `Paper: ${paper.title}`,
      `Review status: ${review.status}`,
      `Paper status: ${paper.status}`,
      `Abstract: ${shorten(paper.abstract || '', 900)}`,
      'You may propose approve/publish/edit actions, but never claim completion before confirmation.',
    ].join('\n\n');
  }

  return [
    'You are in live voice mode for general research chat.',
    'Use tools when needed and keep recommendations grounded.',
  ].join('\n\n');
}

export async function resolveDraftPromotionPaperId(thread: KfdbService.AssistantThread): Promise<string | null> {
  const resolved = getThreadContext(thread);

  if (resolved.type === 'discovery_paper') {
    return resolved.refId;
  }

  if (resolved.type === 'review_item') {
    const review = await KfdbService.getReviewItem(resolved.refId);
    return review.paper_kfdb_id;
  }

  if (resolved.type === 'published_paper') {
    const published = await PublishedPaperContextService.getPublishedPaperContext(resolved.refId);
    return published.discovery_paper?.id || null;
  }

  return null;
}
