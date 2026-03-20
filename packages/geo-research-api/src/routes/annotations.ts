import { Router, type Request, type Response } from 'express';
import { authRequired } from '../middleware/auth.js';
import * as KfdbService from '../services/KfdbService.js';

const router = Router();

// GET /annotations/:paperId — get all annotations for a paper (public)
router.get('/:paperId', async (req: Request, res: Response) => {
  try {
    const annotations = await KfdbService.getAnnotations(req.params.paperId as string);
    res.json({ annotations });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// POST /annotations — create annotation (auth required)
router.post('/', authRequired, async (req: Request, res: Response) => {
  const { paperId, page, rects, text, annotationType, claimId } = req.body;
  if (!paperId || page === undefined || !rects || !annotationType) {
    res.status(400).json({ error: 'paperId, page, rects, and annotationType are required' });
    return;
  }

  try {
    const annotation = await KfdbService.createAnnotation({
      paper_id: paperId,
      page: Number(page),
      rects_json: typeof rects === 'string' ? rects : JSON.stringify(rects),
      text: text || '',
      annotation_type: annotationType,
      claim_id: claimId || '',
    });
    res.json(annotation);
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// DELETE /annotations/:id — delete annotation (auth required)
router.delete('/:id', authRequired, async (req: Request, res: Response) => {
  try {
    await KfdbService.deleteAnnotation(req.params.id as string);
    res.json({ status: 'deleted' });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

export default router;
