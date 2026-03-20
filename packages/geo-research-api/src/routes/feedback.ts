import { Router, type Request, type Response } from 'express';
import { authRequired } from '../middleware/auth.js';
import * as KfdbService from '../services/KfdbService.js';
import * as GatewayFeedbackProxy from '../services/GatewayFeedbackProxy.js';

const router = Router();

// POST /feedback/claim — submit per-claim feedback (thumbs up/down + optional comment)
router.post('/claim', authRequired, async (req: Request, res: Response) => {
  const { paperId, claimIndex, claimText, rating, comment } = req.body as {
    paperId?: string;
    claimIndex?: number;
    claimText?: string;
    rating?: string;
    comment?: string;
  };

  if (!paperId || claimIndex === undefined || !rating) {
    res.status(400).json({ error: 'paperId, claimIndex, and rating are required' });
    return;
  }
  if (rating !== 'positive' && rating !== 'negative') {
    res.status(400).json({ error: 'rating must be "positive" or "negative"' });
    return;
  }

  try {
    // 1. Store feedback locally in KFDB
    const feedback = await KfdbService.createClaimFeedback({
      paper_id: paperId,
      claim_index: claimIndex,
      rating,
      comment: comment || '',
      timestamp: new Date().toISOString(),
    });

    // 2. Forward to gateway (non-fatal — local tracking is the source of truth)
    try {
      await GatewayFeedbackProxy.submitOutcomeFeedback({
        paperId,
        claimIndex,
        claimText: claimText || '',
        rating,
        comment,
      });
    } catch (gwErr: any) {
      console.warn('[FEEDBACK] Gateway feedback submission failed (non-fatal):', gwErr.message);
    }

    res.json({ success: true, feedbackId: feedback.id });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /feedback/paper/:paperId — get all feedback for a paper
router.get('/paper/:paperId', async (req: Request, res: Response) => {
  try {
    const feedbacks = await KfdbService.getClaimFeedbacks(req.params.paperId as string);
    res.json({ feedbacks });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /feedback/trigger-improvement — trigger gateway self-improvement cycle
router.post('/trigger-improvement', authRequired, async (_req: Request, res: Response) => {
  try {
    const result = await GatewayFeedbackProxy.triggerSelfImprovement();
    res.json({ triggerId: result.id || result.triggerId, status: 'started', ...result });
  } catch (err: any) {
    res.status(502).json({ error: `Self-improvement trigger failed: ${err.message}` });
  }
});

// GET /feedback/improvement-status — poll improvement cycle status
router.get('/improvement-status', authRequired, async (_req: Request, res: Response) => {
  try {
    const status = await GatewayFeedbackProxy.getImprovementStatus();
    res.json(status);
  } catch (err: any) {
    res.status(502).json({ error: `Failed to get improvement status: ${err.message}` });
  }
});

// GET /feedback/skills — get current agent skills
router.get('/skills', authRequired, async (_req: Request, res: Response) => {
  try {
    const skills = await GatewayFeedbackProxy.getSkills();
    res.json(skills);
  } catch (err: any) {
    res.status(502).json({ error: `Failed to get skills: ${err.message}` });
  }
});

export default router;
