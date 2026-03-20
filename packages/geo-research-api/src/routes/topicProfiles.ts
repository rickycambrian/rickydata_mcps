import { Router, type Request, type Response } from 'express';
import { authOptional, authRequired } from '../middleware/auth.js';
import * as KfdbService from '../services/KfdbService.js';

const router = Router();

router.get('/', authOptional, async (req: Request, res: Response) => {
  try {
    const ownerOnly = req.query.ownerOnly === 'true';
    const profiles = await KfdbService.listTopicProfiles(ownerOnly ? req.wallet?.address : undefined, 100);
    profiles.sort((a, b) => new Date(b.updated_at || b.created_at).getTime() - new Date(a.updated_at || a.created_at).getTime());
    res.json({ profiles });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.post('/', authRequired, async (req: Request, res: Response) => {
  try {
    const { name, description = '', categories = [], keywords = [], enabled = 'true', auto_extract = 'false', min_candidate_score = 65, max_daily_extractions = 3 } = req.body;
    const profile = await KfdbService.createTopicProfile({
      name,
      description,
      categories,
      keywords,
      enabled,
      auto_extract,
      min_candidate_score,
      max_daily_extractions,
      owner_wallet: req.wallet!.address,
    });
    res.json({ profile });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.put('/:id', authRequired, async (req: Request, res: Response) => {
  try {
    const profile = await KfdbService.updateTopicProfile(req.params.id as string, req.body || {});
    res.json({ profile });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.get('/:id/dashboard', authOptional, async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const profile = await KfdbService.getTopicProfile(id);
    const [runs, candidates, papers, topics, snapshots] = await Promise.all([
      KfdbService.listDiscoveryRunsForTopicProfile(id, 30),
      KfdbService.listPaperCandidates({ topicProfileId: id, limit: 100 }),
      KfdbService.listDiscoveryPapersForTopicProfile(id, 100),
      KfdbService.listResearchTopics({ topicProfileId: id, limit: 100 }),
      KfdbService.listTopicSnapshots(id, 30),
    ]);

    runs.sort((a, b) => new Date(b.started_at || b.finished_at || 0).getTime() - new Date(a.started_at || a.finished_at || 0).getTime());
    candidates.sort((a, b) => b.score_total - a.score_total);
    papers.sort((a, b) => (b.claim_count || 0) - (a.claim_count || 0));
    topics.sort((a, b) => b.trend_score - a.trend_score);
    snapshots.sort((a, b) => new Date(a.snapshot_date).getTime() - new Date(b.snapshot_date).getTime());

    const claims = (await Promise.all(papers.slice(0, 10).map((paper) => KfdbService.getClaimsForPaper(paper.id)))).flat();
    const claimsByRole = claims.reduce<Record<string, number>>((acc, claim) => {
      acc[claim.role] = (acc[claim.role] || 0) + 1;
      return acc;
    }, {});

    res.json({
      profile,
      runs,
      candidates,
      papers,
      topics,
      snapshots,
      topClaims: claims.slice(0, 12),
      claimsByRole,
    });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

export default router;
