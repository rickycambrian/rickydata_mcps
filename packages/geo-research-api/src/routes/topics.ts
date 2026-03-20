import { Router, type Request, type Response } from 'express';
import * as KfdbService from '../services/KfdbService.js';

const router = Router();

router.get('/:id/graph', async (req: Request, res: Response) => {
  try {
    const topicProfileId = req.params.id as string;
    const [profile, topics, papers] = await Promise.all([
      KfdbService.getTopicProfile(topicProfileId),
      KfdbService.listResearchTopics({ topicProfileId, limit: 100 }),
      KfdbService.listDiscoveryPapersForTopicProfile(topicProfileId, 100),
    ]);

    const topicIds = new Set(topics.map((topic) => topic.id));
    const memberships = (await Promise.all(topics.map((topic) => KfdbService.listTopicMembershipsByTopic(topic.id, 300)))).flat();
    const paperIds = new Set(papers.map((paper) => paper.id));

    const nodes: Array<{ id: string; label: string; type: 'topic' | 'subtopic' | 'paper' | 'claim'; connectionCount?: number }> = [];
    const edges: Array<{ source: string; target: string; type: string; similarityScore?: number }> = [];
    const nodeMap = new Map<string, { id: string; label: string; type: 'topic' | 'subtopic' | 'paper' | 'claim'; connectionCount?: number }>();

    nodeMap.set(profile.id, { id: profile.id, label: profile.name, type: 'topic', connectionCount: 0 });

    for (const topic of topics) {
      nodeMap.set(topic.id, { id: topic.id, label: topic.name, type: 'subtopic', connectionCount: 0 });
      edges.push({ source: profile.id, target: topic.id, type: 'tracks' });
    }

    for (const paper of papers) {
      nodeMap.set(paper.id, { id: paper.id, label: paper.title, type: 'paper', connectionCount: 0 });
    }

    for (const membership of memberships) {
      if (!topicIds.has(membership.topic_id)) continue;
      if (membership.entity_type === 'paper' && paperIds.has(membership.entity_id)) {
        edges.push({ source: membership.topic_id, target: membership.entity_id, type: 'contains' });
      }
      if (membership.entity_type === 'claim') {
        const claim = await KfdbService.getClaim(membership.entity_id).catch(() => null);
        if (!claim) continue;
        nodeMap.set(claim.id, { id: claim.id, label: claim.text, type: 'claim', connectionCount: 0 });
        edges.push({ source: membership.topic_id, target: claim.id, type: 'supports' });
      }
    }

    for (const paper of papers.slice(0, 20)) {
      const relationships = await KfdbService.getPaperRelationships(paper.id);
      for (const rel of relationships) {
        const target = rel.source_paper_id === paper.id ? rel.target_paper_id : rel.source_paper_id;
        if (!paperIds.has(target)) continue;
        edges.push({
          source: rel.source_paper_id,
          target: rel.target_paper_id,
          type: rel.relationship_type,
          similarityScore: rel.similarity_score,
        });
      }
    }

    for (const edge of edges) {
      const source = nodeMap.get(edge.source);
      const target = nodeMap.get(edge.target);
      if (source) source.connectionCount = (source.connectionCount || 0) + 1;
      if (target) target.connectionCount = (target.connectionCount || 0) + 1;
    }

    nodes.push(...nodeMap.values());
    res.json({ profile, nodes, edges });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.get('/:id/compare', async (req: Request, res: Response) => {
  try {
    const topicProfileId = req.params.id as string;
    const paperIds = String(req.query.paperIds || '')
      .split(',')
      .map((paperId) => paperId.trim())
      .filter(Boolean)
      .slice(0, 4);

    const profile = await KfdbService.getTopicProfile(topicProfileId);
    const papers = await Promise.all(paperIds.map((paperId) => KfdbService.getDiscoveryPaper(paperId)));
    const claimsPerPaper = await Promise.all(paperIds.map((paperId) => KfdbService.getClaimsForPaper(paperId)));
    const relationships = (await Promise.all(paperIds.map((paperId) => KfdbService.getPaperRelationships(paperId)))).flat();

    const sharedTopics = papers.reduce<string[]>((acc, paper, index) => {
      if (index === 0) return [...paper.topics];
      return acc.filter((topic) => paper.topics.includes(topic));
    }, []);

    res.json({
      profile,
      papers,
      sharedTopics,
      relationships,
      comparisons: papers.map((paper, index) => ({
        paper,
        claims: claimsPerPaper[index],
        methods: claimsPerPaper[index].map((claim) => claim.methodology).filter(Boolean),
        evidenceTypes: claimsPerPaper[index].map((claim) => claim.evidence_type).filter(Boolean),
      })),
    });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

export default router;
