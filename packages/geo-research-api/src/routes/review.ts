import { Router, type Request, type Response } from 'express';
import { authRequired } from '../middleware/auth.js';
import * as KfdbService from '../services/KfdbService.js';

const router = Router();

// All review routes require auth
router.use(authRequired);

/**
 * Verify the requesting wallet owns the review item. Returns the item or sends 403.
 */
async function verifyOwnership(req: Request, res: Response): Promise<KfdbService.ReviewItem | null> {
  const id = req.params.id as string;
  const item = await KfdbService.getReviewItem(id);
  if (item.wallet_address.toLowerCase() !== req.wallet!.address.toLowerCase()) {
    res.status(403).json({ error: 'You do not have access to this review item' });
    return null;
  }
  return item;
}

// GET /review — user's review queue
router.get('/', async (req: Request, res: Response) => {
  try {
    const items = await KfdbService.getReviewItems(req.wallet!.address);
    // Enrich with paper data
    const enriched = await Promise.all(
      items.map(async (item) => {
        try {
          const paper = await KfdbService.getDiscoveryPaper(item.paper_kfdb_id);
          return { ...item, paper };
        } catch {
          return { ...item, paper: null };
        }
      }),
    );
    // Sort by assigned_at descending (newest first)
    enriched.sort((a, b) => {
      const dateA = new Date(a.assigned_at || 0).getTime();
      const dateB = new Date(b.assigned_at || 0).getTime();
      return dateB - dateA;
    });

    res.json({ items: enriched });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /review — add paper to review queue
router.post('/', async (req: Request, res: Response) => {
  const { paperId } = req.body;
  if (!paperId) {
    res.status(400).json({ error: 'paperId required' });
    return;
  }

  try {
    const item = await KfdbService.createReviewItem(req.wallet!.address, paperId);
    res.json(item);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /review/:id — review detail (owner only)
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const item = await verifyOwnership(req, res);
    if (!item) return;

    const paper = await KfdbService.getDiscoveryPaper(item.paper_kfdb_id);
    const claims = await KfdbService.getClaimsForPaper(item.paper_kfdb_id);
    res.json({ item, paper, claims });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// POST /review/:id/approve — approve paper (owner only)
router.post('/:id/approve', async (req: Request, res: Response) => {
  try {
    const item = await verifyOwnership(req, res);
    if (!item) return;

    await KfdbService.updateReviewItem(item.id, { status: 'approved' });

    // HITL feedback: log confidence calibration data point
    try {
      const paper = await KfdbService.getDiscoveryPaper(item.paper_kfdb_id);
      console.log(
        `[HITL] Review feedback: paper=${item.paper_kfdb_id} ` +
        `confidence=${paper.confidence_score ?? 'unscored'} ` +
        `tier=${paper.confidence_tier ?? 'none'} ` +
        `verdict=approved ` +
        `reviewer=${req.wallet!.address}`,
      );
    } catch {
      // Non-fatal: paper lookup for logging may fail
    }

    res.json({ status: 'approved' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /review/:id/reject — reject paper (owner only)
router.post('/:id/reject', async (req: Request, res: Response) => {
  try {
    const item = await verifyOwnership(req, res);
    if (!item) return;

    const { feedback } = req.body;
    await KfdbService.updateReviewItem(item.id, {
      status: 'rejected',
      feedback: feedback || '',
    });

    // HITL feedback: log confidence calibration data point
    try {
      const paper = await KfdbService.getDiscoveryPaper(item.paper_kfdb_id);
      console.log(
        `[HITL] Review feedback: paper=${item.paper_kfdb_id} ` +
        `confidence=${paper.confidence_score ?? 'unscored'} ` +
        `tier=${paper.confidence_tier ?? 'none'} ` +
        `verdict=rejected ` +
        `reviewer=${req.wallet!.address} ` +
        `feedback="${(feedback || '').slice(0, 200)}"`,
      );
    } catch {
      // Non-fatal: paper lookup for logging may fail
    }

    res.json({ status: 'rejected' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /review/:id/claims/:claimId — edit claim text (review owner only)
router.put('/:id/claims/:claimId', async (req: Request, res: Response) => {
  try {
    const item = await verifyOwnership(req, res);
    if (!item) return;

    const { text } = req.body;
    if (!text) {
      res.status(400).json({ error: 'text required' });
      return;
    }

    await KfdbService.updateClaim(req.params.claimId as string, {
      edited_text: text,
      edited_by: req.wallet!.address,
      status: 'edited',
    });
    res.json({ status: 'updated' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
