import * as AgentProxy from './AgentProxy.js';
import * as GeoQuery from './GeoQuery.js';
import * as KfdbService from './KfdbService.js';
import { searchPapers, type ArxivPaper } from './ArxivClient.js';
import { scorePaperExtraction, formatConfidenceExplanation } from './ConfidenceScoring.js';
import { matchAgentError, shouldRetryWithRecovery } from './AnswerSheetRecovery.js';
import { rankPapers, type RankingConfig } from './PaperRanking.js';
import { enrichPaperGraph } from './GraphEnrichment.js';
import type { SSEEvent } from './AgentProxy.js';

const STREAM_TIMEOUT_MS = 5 * 60 * 1000;
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'by', 'for', 'from', 'in', 'into', 'is', 'of', 'on', 'or', 'the', 'to', 'with',
]);

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  const setA = new Set(a.map((item) => item.toLowerCase()));
  const setB = new Set(b.map((item) => item.toLowerCase()));
  const intersection = [...setA].filter((item) => setB.has(item));
  const union = new Set([...setA, ...setB]);
  return union.size > 0 ? intersection.length / union.size : 0;
}

function tokenizeKeyword(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 4 && !STOP_WORDS.has(token));
}

function scoreKeywordCoverage(text: string, keywords: string[]): number {
  if (keywords.length === 0) return 0;

  const normalizedText = text.toLowerCase();
  const scores = keywords.map((keyword) => {
    if (normalizedText.includes(keyword.toLowerCase())) return 1;
    const tokens = tokenizeKeyword(keyword);
    if (tokens.length === 0) return 0;
    const matched = tokens.filter((token) => normalizedText.includes(token)).length;
    return matched / tokens.length;
  });

  const strongest = Math.max(...scores, 0);
  const average = scores.reduce((sum, value) => sum + value, 0) / scores.length;
  return round3(Math.min(1, strongest * 0.7 + average * 0.3));
}

function buildRankingConfig(profile: KfdbService.TopicProfile): RankingConfig {
  return {
    topicKeywords: profile.keywords,
    preferredCategories: profile.categories,
  };
}

function buildExtractionPrompt(arxivId: string): string {
  return `Analyze the arXiv paper ${arxivId}. Download and read the paper, extract 5 key claims, and call create_research_ontology_paper_and_claims to structure them. Do NOT call propose_dao_edit — stop after creating the structured data.`;
}

function scoreNovelty(paper: ArxivPaper, existingPapers: KfdbService.DiscoveryPaper[]): number {
  if (existingPapers.length === 0) return 1;
  let maxOverlap = 0;
  for (const existing of existingPapers) {
    maxOverlap = Math.max(maxOverlap, jaccard(paper.categories, existing.topics || []));
  }
  return round3(Math.max(0, 1 - maxOverlap));
}

function scoreGraphFit(
  paper: ArxivPaper,
  profile: KfdbService.TopicProfile,
  researchTopics: KfdbService.ResearchTopic[],
  existingPapers: KfdbService.DiscoveryPaper[],
): number {
  const text = `${paper.title} ${paper.abstract}`.toLowerCase();
  const topicHitCount = researchTopics.filter((topic) => text.includes(topic.name.toLowerCase())).length;
  const profileKeywordCoverage = scoreKeywordCoverage(text, profile.keywords);
  const categoryFit = jaccard(paper.categories, profile.categories);
  let maxExistingSimilarity = 0;
  for (const existing of existingPapers) {
    const similarity = Math.max(
      jaccard(paper.categories, existing.topics || []),
      jaccard(paper.authors, existing.authors || []),
    );
    maxExistingSimilarity = Math.max(maxExistingSimilarity, similarity);
  }

  const signal = Math.min(1, categoryFit + profileKeywordCoverage * 0.35 + topicHitCount * 0.15);
  const duplicatePenalty = maxExistingSimilarity > 0.85 ? 0.35 : 0;
  return round3(Math.max(0, Math.min(1, signal * (1 - duplicatePenalty))));
}

function composeCandidateScore(baseScore: number, noveltyScore: number, graphFitScore: number): number {
  return Math.round(baseScore * 0.65 + noveltyScore * 100 * 0.2 + graphFitScore * 100 * 0.15);
}

async function createTopicSnapshot(topicProfileId: string): Promise<void> {
  const papers = await KfdbService.listDiscoveryPapersForTopicProfile(topicProfileId, 200);
  const claims = (await Promise.all(papers.map((paper) => KfdbService.getClaimsForPaper(paper.id)))).flat();
  const topPapers = [...papers]
    .sort((a, b) => (b.claim_count || 0) - (a.claim_count || 0))
    .slice(0, 5)
    .map((paper) => paper.id);
  const topClaims = claims.slice(0, 8).map((claim) => claim.id);

  const recentPapers = papers.filter((paper) => {
    const createdAt = new Date(paper.created_at).getTime();
    return createdAt >= Date.now() - 7 * 24 * 60 * 60 * 1000;
  });

  await KfdbService.createTopicSnapshot({
    topic_profile_id: topicProfileId,
    snapshot_date: new Date().toISOString().slice(0, 10),
    paper_count: papers.length,
    new_paper_count: recentPapers.length,
    claim_count: claims.length,
    velocity_score: round3(recentPapers.length / 7),
    top_paper_ids: topPapers,
    top_claim_ids: topClaims,
  });
}

export async function executeDiscoveryRun(runId: string): Promise<KfdbService.DiscoveryRun> {
  const run = await KfdbService.getDiscoveryRun(runId);
  if (run.status === 'completed' || run.status === 'running') {
    return run;
  }

  const profile = await KfdbService.getTopicProfile(run.topic_profile_id);
  await KfdbService.updateDiscoveryRun(runId, {
    status: 'running',
    started_at: run.started_at || new Date().toISOString(),
    error_summary: '',
  });

  try {
    const arxivPapers = await searchPapers({
      categories: profile.categories,
      keyword: profile.keywords.join(' '),
      startDate: run.query_window_start,
      endDate: run.query_window_end,
      maxResults: 50,
      sortBy: 'submittedDate',
    });

    const ranked = await rankPapers(arxivPapers, buildRankingConfig(profile));
    const allExistingPapers = await KfdbService.listDiscoveryPapers(undefined, 1000);
    const existingPaperByArxivId = new Map(
      allExistingPapers
        .filter((paper) => paper.arxiv_id)
        .map((paper) => [paper.arxiv_id, paper] as const),
    );
    const existingPapers = allExistingPapers.filter((paper) => paper.topic_profile_id === profile.id);
    const researchTopics = await KfdbService.listResearchTopics({ topicProfileId: profile.id, limit: 200 });
    const existingCandidates = await KfdbService.listPaperCandidates({ topicProfileId: profile.id, limit: 500 });

    let candidateCount = 0;
    const newCandidates: KfdbService.PaperCandidate[] = [];

    for (const rankedPaper of ranked) {
      const { paper } = rankedPaper;
      if (existingPaperByArxivId.has(paper.arxivId)) continue;
      if (existingCandidates.some((candidate) => candidate.arxiv_id === paper.arxivId)) continue;

      const noveltyScore = scoreNovelty(paper, existingPapers);
      const graphFitScore = scoreGraphFit(paper, profile, researchTopics, existingPapers);
      const scoreTotal = composeCandidateScore(rankedPaper.score, noveltyScore, graphFitScore);
      if (scoreTotal < profile.min_candidate_score) continue;

      const candidate = await KfdbService.createPaperCandidate({
        arxiv_id: paper.arxivId,
        topic_profile_id: profile.id,
        source_run_id: runId,
        title: paper.title,
        abstract: paper.abstract,
        authors: paper.authors,
        categories: paper.categories,
        published_date: paper.published,
        score_total: scoreTotal,
        score_breakdown: {
          base_rank: rankedPaper.score,
          topic: round3(rankedPaper.breakdown.topicScore),
          recency: round3(rankedPaper.breakdown.recencyScore),
          author_overlap: round3(rankedPaper.breakdown.authorScore),
          category_alignment: round3(rankedPaper.breakdown.categoryScore),
          novelty: noveltyScore,
          graph_fit: graphFitScore,
        },
        novelty_score: noveltyScore,
        graph_fit_score: graphFitScore,
        status: 'pending',
        discovered_by: run.created_by || profile.owner_wallet,
        promoted_at: '',
        paper_id: '',
        error_summary: '',
      });
      newCandidates.push(candidate);
      existingCandidates.push(candidate);
      candidateCount++;
    }

    let promotedCount = 0;
    if (profile.auto_extract === 'true') {
      const today = new Date().toISOString().slice(0, 10);
      const todaysPromotions = existingCandidates.filter(
        (candidate) => candidate.promoted_at?.slice(0, 10) === today && ['promoted', 'processing', 'extracted'].includes(candidate.status),
      ).length;
      const remaining = Math.max(0, profile.max_daily_extractions - todaysPromotions);
      const toPromote = [...newCandidates]
        .sort((a, b) => b.score_total - a.score_total)
        .slice(0, remaining);

      for (const candidate of toPromote) {
        await KfdbService.updatePaperCandidate(candidate.id, {
          status: 'promoted',
          promoted_at: new Date().toISOString(),
        });
        promotedCount++;
      }
    }

    await createTopicSnapshot(profile.id);

    return KfdbService.updateDiscoveryRun(runId, {
      status: 'completed',
      finished_at: new Date().toISOString(),
      candidate_count: candidateCount,
      promoted_count: promotedCount,
    });
  } catch (err: any) {
    return KfdbService.updateDiscoveryRun(runId, {
      status: 'failed',
      finished_at: new Date().toISOString(),
      error_summary: err.message || 'Discovery run failed',
    });
  }
}

export async function promoteCandidate(candidateId: string): Promise<KfdbService.PaperCandidate> {
  const candidate = await KfdbService.getPaperCandidate(candidateId);
  if (candidate.status === 'dismissed' || candidate.status === 'failed' || candidate.status === 'extracted') {
    return candidate;
  }

  const existingPaper = await KfdbService.findPaperByArxivId(candidate.arxiv_id);
  if (existingPaper) {
    return KfdbService.updatePaperCandidate(candidate.id, {
      status: 'extracted',
      paper_id: existingPaper.id,
      promoted_at: candidate.promoted_at || new Date().toISOString(),
    });
  }

  return KfdbService.updatePaperCandidate(candidate.id, {
    status: 'promoted',
    promoted_at: new Date().toISOString(),
  });
}

export async function dismissCandidate(candidateId: string): Promise<KfdbService.PaperCandidate> {
  return KfdbService.updatePaperCandidate(candidateId, {
    status: 'dismissed',
  });
}

export async function processPromotedCandidate(candidateId: string, model = 'haiku'): Promise<KfdbService.DiscoveryPaper | null> {
  const candidate = await KfdbService.getPaperCandidate(candidateId);
  if (candidate.status !== 'promoted') return null;

  const existingPaper = await KfdbService.findPaperByArxivId(candidate.arxiv_id);
  if (existingPaper) {
    await KfdbService.updatePaperCandidate(candidate.id, {
      status: 'extracted',
      paper_id: existingPaper.id,
    });
    return existingPaper;
  }

  await KfdbService.updatePaperCandidate(candidate.id, { status: 'processing' });

  const paper = await KfdbService.createDiscoveryPaper({
    arxiv_id: candidate.arxiv_id,
    title: candidate.title || `arXiv:${candidate.arxiv_id}`,
    abstract: candidate.abstract || '',
    authors: candidate.authors || [],
    published_date: candidate.published_date || '',
    web_url: `https://arxiv.org/abs/${candidate.arxiv_id}`,
    status: 'processing',
    discovered_by: candidate.discovered_by,
    topics: candidate.categories || [],
    claim_count: 0,
    topic_profile_id: candidate.topic_profile_id,
    source_candidate_id: candidate.id,
  });

  try {
    await extractPaperWithAgent({ paperId: paper.id, arxivId: candidate.arxiv_id, model });
    await KfdbService.updatePaperCandidate(candidate.id, {
      status: 'extracted',
      paper_id: paper.id,
    });
    await createTopicSnapshot(candidate.topic_profile_id);
    return KfdbService.getDiscoveryPaper(paper.id);
  } catch (err: any) {
    await KfdbService.updateDiscoveryPaperStatus(paper.id, 'failed').catch(() => {});
    await KfdbService.updatePaperCandidate(candidate.id, {
      status: 'failed',
      paper_id: paper.id,
      error_summary: err.message || 'Extraction failed',
    });
    throw err;
  }
}

export async function extractPaperWithAgent(options: {
  paperId: string;
  arxivId: string;
  model?: string;
  onEvent?: (event: SSEEvent) => Promise<void> | void;
}): Promise<void> {
  const { paperId, arxivId, model = 'haiku', onEvent } = options;
  const sessionId = await AgentProxy.createSession('research-paper-analyst-geo-uploader', model);

  await onEvent?.({ type: 'paper_created', data: { paperId } });

  const stream = await AgentProxy.sendMessage(
    sessionId,
    buildExtractionPrompt(arxivId),
    'research-paper-analyst-geo-uploader',
    model,
  );
  if (!stream) {
    throw new Error('No response stream from agent');
  }

  let lastToolResult: any = null;
  let lastToolInput: any = null;
  let agentTextBuffer = '';
  let resultSaved = false;
  let streamTimedOut = false;

  const timeoutId = setTimeout(() => {
    streamTimedOut = true;
  }, STREAM_TIMEOUT_MS);

  try {
    for await (const event of AgentProxy.parseSSEStream(stream)) {
      if (streamTimedOut) {
        throw new Error('Agent stream timed out after 5 minutes');
      }

      await onEvent?.(event);

      if (event.type === 'text') {
        const text = typeof event.data === 'string' ? event.data : event.data?.text || '';
        agentTextBuffer += text;
      }

      if (event.type === 'tool_call' && event.data?.name?.includes('create_research_ontology')) {
        lastToolInput = event.data?.args || event.data?.input || event.data?.arguments || event.input || event.arguments;
        if (typeof lastToolInput === 'string') {
          try {
            lastToolInput = JSON.parse(lastToolInput);
          } catch {
            // Leave as-is.
          }
        }
      }

      if (event.type === 'tool_result' && event.data?.name?.includes('create_research_ontology')) {
        lastToolResult = event.data;
      }

      if ((event.type === 'done' || event.type === 'error') && lastToolResult?.result && !resultSaved) {
        resultSaved = true;
        await saveAgentResultToKfdb(paperId, lastToolResult.result, lastToolInput, agentTextBuffer);
        await onEvent?.({ type: 'extraction_complete', data: { paperId } });
      }
    }
  } finally {
    clearTimeout(timeoutId);
  }

  if (lastToolResult?.result && !resultSaved) {
    await saveAgentResultToKfdb(paperId, lastToolResult.result, lastToolInput, agentTextBuffer);
    await onEvent?.({ type: 'extraction_complete', data: { paperId } });
  }
}

export async function saveAgentResultToKfdb(
  paperId: string,
  resultText: string,
  toolInput?: any,
  agentText?: string,
): Promise<void> {
  let cleanedText = resultText;
  const paymentSuffix = cleanedText.indexOf('\n{"_payment"');
  if (paymentSuffix !== -1) {
    cleanedText = cleanedText.slice(0, paymentSuffix).trim();
  }

  let parsed: any = null;
  let parseSuccess = false;

  try {
    parsed = JSON.parse(cleanedText);
    parseSuccess = true;
  } catch {
    try {
      const jsonMatch = cleanedText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0]);
        parseSuccess = true;
      }
    } catch {
      if (shouldRetryWithRecovery(resultText)) {
        await matchAgentError(resultText, { tool: 'create_research_ontology' });
      }
      parsed = null;
    }
  }

  const existingPaper = await KfdbService.getDiscoveryPaper(paperId);
  const paperName = parsed?.paper?.name || parsed?.title || '';
  const paperAbstract = parsed?.abstract || '';
  const paperAuthors: string[] = parsed?.authors || [];
  const paperTopics: string[] = (parsed?.topics || []).map((topic: any) => (typeof topic === 'string' ? topic : topic?.name || topic?.key || '')).filter(Boolean);

  const paperForScoring: Partial<KfdbService.DiscoveryPaper> = {
    title: paperName || existingPaper.title,
    abstract: paperAbstract || existingPaper.abstract,
    authors: paperAuthors.length > 0 ? paperAuthors : existingPaper.authors,
    topics: paperTopics.length > 0 ? paperTopics : existingPaper.topics,
  };

  let claims: any[];
  const inputClaims: any[] = toolInput?.claims || [];
  let agentExtractedClaims: string[] = [];
  if (agentText && inputClaims.length === 0) {
    const claimPatterns = [
      /(?:^|\n)\s*\d+[\.\)]\s*\*{0,2}(?:Claim\s*\d*:?\s*)?(.+?)(?=\n\s*\d+[\.\)]|\n\n|$)/gs,
      /(?:^|\n)\s*[-•]\s*\*{0,2}(.+?)(?=\n\s*[-•]|\n\n|$)/gs,
    ];
    for (const pattern of claimPatterns) {
      const matches = [...agentText.matchAll(pattern)];
      if (matches.length >= 3) {
        agentExtractedClaims = matches
          .map((match) => match[1].replace(/\*{1,2}/g, '').trim())
          .filter((text) => text.length > 20);
        if (agentExtractedClaims.length >= 3) break;
      }
    }
  }

  if (Array.isArray(parsed?.claims)) {
    claims = parsed.claims;
  } else if (parsed?.claims?.ids && Array.isArray(parsed.claims.ids)) {
    let claimNameMap = new Map<string, string>();
    try {
      claimNameMap = await GeoQuery.resolveEntityNames(parsed.claims.ids);
    } catch {
      // Non-fatal.
    }
    claims = parsed.claims.ids.map((id: string, index: number) => {
      const inputClaimText = inputClaims[index]?.name || inputClaims[index]?.text || '';
      const agentClaimText = agentExtractedClaims[index] || '';
      const geoResolvedText = claimNameMap.get(id.replace(/-/g, '')) || '';
      return {
        id,
        text: inputClaimText || agentClaimText || geoResolvedText || id,
        role: inputClaims[index]?.claimType || inputClaims[index]?.role || 'contribution',
      };
    });
  } else {
    const fallbackClaims = inputClaims.length > 0 ? inputClaims : agentExtractedClaims.map((text) => ({ text }));
    claims = fallbackClaims.map((claim: any) => ({
      text: typeof claim === 'string' ? claim : claim.name || claim.text || '',
      role: typeof claim === 'string' ? 'contribution' : claim.claimType || claim.role || 'contribution',
    }));
  }

  const confidence = scorePaperExtraction(paperForScoring, claims, parseSuccess);
  console.log(`[DISCOVERY] Confidence for paper ${paperId}: ${formatConfidenceExplanation(confidence)}`);

  let status: KfdbService.DiscoveryPaper['status'];
  if (confidence.tier === 'skip') status = 'failed';
  else status = 'ready_for_review';

  const updates: Record<string, unknown> = {
    status,
    confidence_score: confidence.score,
    confidence_tier: confidence.tier,
    confidence_reason: confidence.reason,
  };
  if (paperName) updates.title = paperName;
  if (paperAbstract) updates.abstract = paperAbstract;
  if (paperAuthors.length > 0) updates.authors = JSON.stringify(paperAuthors);
  if (parsed?.publishDate || parsed?.paper?.publishDate) updates.published_date = parsed.publishDate || parsed.paper.publishDate;
  if (paperTopics.length > 0) updates.topics = JSON.stringify(paperTopics);

  await KfdbService.updateDiscoveryPaper(paperId, updates);

  let position = 1;
  const createdClaimIds: string[] = [];
  for (const claim of claims) {
    const created = await KfdbService.createExtractedClaim({
      paper_kfdb_id: paperId,
      text: claim.name || claim.text || '',
      position: position++,
      role: claim.role || 'contribution',
      source_quote: claim.quote || claim.sourceQuote || '',
      status: 'pending',
      edited_text: '',
      edited_by: '',
      evidence_type: claim.evidenceType || '',
      methodology: claim.methodology || '',
    });
    createdClaimIds.push(created.id);
  }

  if (claims.length > 0) {
    await KfdbService.updateDiscoveryPaper(paperId, { claim_count: claims.length });
  }

  try {
    await enrichPaperGraph(paperId);
  } catch (err) {
    console.warn(`[DISCOVERY] Graph enrichment failed for paper ${paperId}, continuing:`, err);
  }

  if (agentText) {
    const refs = [...new Set(agentText.match(/\d{4}\.\d{4,5}/g) || [])];
    for (const refId of refs) {
      try {
        const refPaper = await KfdbService.findPaperByArxivId(refId);
        if (refPaper && refPaper.id !== paperId) {
          await KfdbService.createPaperRelationship({
            source_paper_id: paperId,
            target_paper_id: refPaper.id,
            relationship_type: 'cites',
          });
        }
      } catch {
        // Non-fatal.
      }
    }
  }

  const finalPaper = await KfdbService.getDiscoveryPaper(paperId);
  if (finalPaper.topic_profile_id && finalPaper.topics.length > 0) {
    for (const topicName of finalPaper.topics) {
      const topic = await KfdbService.findOrCreateResearchTopic(finalPaper.topic_profile_id, topicName);
      await KfdbService.createTopicMembership({
        topic_id: topic.id,
        entity_type: 'paper',
        entity_id: paperId,
        topic_profile_id: finalPaper.topic_profile_id,
        confidence: 1,
      });

      for (const claimId of createdClaimIds) {
        await KfdbService.createTopicMembership({
          topic_id: topic.id,
          entity_type: 'claim',
          entity_id: claimId,
          topic_profile_id: finalPaper.topic_profile_id,
          confidence: 0.7,
        });
      }
    }

    const topicMemberships = await Promise.all(finalPaper.topics.map((topicName) => KfdbService.findResearchTopicByName(finalPaper.topic_profile_id!, topicName)));
    const validTopics = topicMemberships.filter(Boolean) as KfdbService.ResearchTopic[];
    for (const topic of validTopics) {
      const memberships = await KfdbService.listTopicMembershipsByTopic(topic.id, 500);
      const paperCount = memberships.filter((membership) => membership.entity_type === 'paper').length;
      const claimCount = memberships.filter((membership) => membership.entity_type === 'claim').length;
      await KfdbService.updateResearchTopic(topic.id, {
        paper_count: paperCount,
        claim_count: claimCount,
        trend_score: round3(paperCount + claimCount / 5),
        last_seen_at: new Date().toISOString(),
      });
    }
  }
}
