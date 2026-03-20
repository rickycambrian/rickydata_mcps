/**
 * Graph Enrichment Service — Creates SHARES_TOPIC, SHARES_AUTHOR, and CONTAINS
 * edges between papers and claims in KFDB for knowledge graph visualization.
 *
 * Idempotent: checks existing relationships before creating duplicates.
 * Non-fatal: edge creation failures are logged but do not propagate.
 */

import * as KfdbService from './KfdbService.js';

export interface EnrichmentStats {
  topicEdges: number;
  authorEdges: number;
  containsEdges: number;
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
 * Enrich a paper's knowledge graph by creating topic/author similarity edges
 * to other papers and CONTAINS edges to its claims.
 */
export async function enrichPaperGraph(paperId: string): Promise<EnrichmentStats> {
  const stats: EnrichmentStats = { topicEdges: 0, authorEdges: 0, containsEdges: 0 };

  const source = await KfdbService.getDiscoveryPaper(paperId);

  // Load existing relationships for idempotency check
  const existingRels = await KfdbService.getPaperRelationships(paperId);
  const existingPairs = new Set(
    existingRels.map(r => `${r.source_paper_id}:${r.target_paper_id}:${r.relationship_type}`),
  );

  // Fetch candidate papers (exclude self, only ready_for_review or published)
  const allPapers = await KfdbService.listDiscoveryPapers(undefined, 500);
  const candidates = allPapers.filter(
    p => p.id !== paperId && (p.status === 'ready_for_review' || p.status === 'published'),
  );

  for (const candidate of candidates) {
    const topicSim = jaccard(source.topics || [], candidate.topics || []);
    const authorSim = jaccard(source.authors || [], candidate.authors || []);

    // Create topic edge if similarity above threshold
    if (topicSim > 0.3) {
      const key = `${paperId}:${candidate.id}:shares_topic`;
      if (!existingPairs.has(key)) {
        try {
          await KfdbService.createTopicEdge(paperId, candidate.id, Math.round(topicSim * 1000) / 1000);
          stats.topicEdges++;
        } catch (err) {
          console.warn(`[ENRICHMENT] Failed to create topic edge ${paperId} -> ${candidate.id}:`, err);
        }
      }
    }

    // Create author edge if similarity above threshold
    if (authorSim > 0.3) {
      const key = `${paperId}:${candidate.id}:shares_author`;
      if (!existingPairs.has(key)) {
        const sharedAuthors = findShared(source.authors || [], candidate.authors || []);
        try {
          await KfdbService.createAuthorEdge(paperId, candidate.id, sharedAuthors);
          stats.authorEdges++;
        } catch (err) {
          console.warn(`[ENRICHMENT] Failed to create author edge ${paperId} -> ${candidate.id}:`, err);
        }
      }
    }
  }

  // Create CONTAINS edges for all claims
  const claims = await KfdbService.getClaimsForPaper(paperId);
  for (const claim of claims) {
    try {
      await KfdbService.createContainsEdge(paperId, claim.id);
      stats.containsEdges++;
    } catch (err) {
      console.warn(`[ENRICHMENT] Failed to create CONTAINS edge for claim ${claim.id}:`, err);
    }
  }

  if (source.topic_profile_id && source.topics.length > 0) {
    for (const topicName of source.topics) {
      const topic = await KfdbService.findOrCreateResearchTopic(source.topic_profile_id, topicName);
      await KfdbService.createTopicMembership({
        topic_id: topic.id,
        entity_type: 'paper',
        entity_id: paperId,
        topic_profile_id: source.topic_profile_id,
        confidence: 1,
      });

      for (const claim of claims) {
        await KfdbService.createTopicMembership({
          topic_id: topic.id,
          entity_type: 'claim',
          entity_id: claim.id,
          topic_profile_id: source.topic_profile_id,
          confidence: 0.7,
        });
      }

      const memberships = await KfdbService.listTopicMembershipsByTopic(topic.id, 500);
      await KfdbService.updateResearchTopic(topic.id, {
        paper_count: memberships.filter((membership) => membership.entity_type === 'paper').length,
        claim_count: memberships.filter((membership) => membership.entity_type === 'claim').length,
        trend_score: Math.round((memberships.length / 3) * 1000) / 1000,
        last_seen_at: new Date().toISOString(),
      });
    }
  }

  console.log(
    `[ENRICHMENT] Paper ${paperId}: ${stats.topicEdges} topic edges, ${stats.authorEdges} author edges, ${stats.containsEdges} contains edges`,
  );

  return stats;
}

/**
 * Compute graph density and edge statistics.
 */
export async function getGraphStats(): Promise<{
  totalPapers: number;
  totalEdges: number;
  edgesByType: Record<string, number>;
  avgEdgesPerPaper: number;
  density: number;
}> {
  const totalPapers = await KfdbService.countAllDiscoveryPapers();
  const edgesByType = await KfdbService.countRelationshipsByType();
  const totalEdges = Object.values(edgesByType).reduce((sum, count) => sum + count, 0);
  const avgEdgesPerPaper = totalPapers > 0 ? Math.round((totalEdges / totalPapers) * 100) / 100 : 0;
  // Graph density = 2 * |E| / (|V| * (|V| - 1)) for undirected graph
  const maxEdges = totalPapers * (totalPapers - 1);
  const density = maxEdges > 0 ? Math.round((totalEdges / maxEdges) * 10000) / 10000 : 0;

  return { totalPapers, totalEdges, edgesByType, avgEdgesPerPaper, density };
}
