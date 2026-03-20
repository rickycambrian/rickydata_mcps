/**
 * Paper Recommendation Service — Co-access graph for paper relevance.
 *
 * Research basis: Paper 6 (Context Graphs) found graph@1 neighbors provide
 * meaningful filtering (32-170 files) while graph@3 saturates (99.4% of nodes).
 * We use 1-hop topic/author overlap for recommendations.
 *
 * Scoring:
 *   - Shared topics: Jaccard similarity weighted 0.6
 *   - Shared authors: Jaccard similarity weighted 0.4
 *   - Final score capped at [0, 1]
 */

import * as KfdbService from './KfdbService.js';

export interface PaperRecommendation {
  paper: KfdbService.DiscoveryPaper;
  score: number;
  shared_topics: string[];
  shared_authors: string[];
  reason: string;
}

function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  const setA = new Set(a.map(s => s.toLowerCase()));
  const setB = new Set(b.map(s => s.toLowerCase()));
  const intersection = [...setA].filter(x => setB.has(x));
  const union = new Set([...setA, ...setB]);
  return union.size > 0 ? intersection.length / union.size : 0;
}

function findShared(a: string[], b: string[]): string[] {
  const setB = new Set(b.map(s => s.toLowerCase()));
  return a.filter(x => setB.has(x.toLowerCase()));
}

/**
 * Find papers related to a given paper via topic and author overlap.
 * Uses 1-hop graph neighbors (shared topics/authors) — not multi-hop,
 * which saturates per Paper 6 findings.
 */
export async function getRelatedPapers(
  paperId: string,
  limit = 10,
): Promise<PaperRecommendation[]> {
  const source = await KfdbService.getDiscoveryPaper(paperId);

  // Fetch candidate papers (exclude self, only ready_for_review or published)
  const allPapers = await KfdbService.listDiscoveryPapers(undefined, 500);
  const candidates = allPapers.filter(
    p => p.id !== paperId && (p.status === 'ready_for_review' || p.status === 'published'),
  );

  const scored: PaperRecommendation[] = [];

  for (const candidate of candidates) {
    const topicSim = jaccard(source.topics || [], candidate.topics || []);
    const authorSim = jaccard(source.authors || [], candidate.authors || []);
    const score = 0.6 * topicSim + 0.4 * authorSim;

    if (score > 0) {
      const sharedTopics = findShared(source.topics || [], candidate.topics || []);
      const sharedAuthors = findShared(source.authors || [], candidate.authors || []);

      const reasons: string[] = [];
      if (sharedTopics.length > 0) reasons.push(`${sharedTopics.length} shared topic(s)`);
      if (sharedAuthors.length > 0) reasons.push(`${sharedAuthors.length} shared author(s)`);

      scored.push({
        paper: candidate,
        score: Math.round(score * 1000) / 1000,
        shared_topics: sharedTopics,
        shared_authors: sharedAuthors,
        reason: reasons.join(', '),
      });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}
