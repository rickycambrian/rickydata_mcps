import { Router, type Request, type Response } from 'express';
import { authOptional, authOrSchedulerRequired, authRequired } from '../middleware/auth.js';
import { AppError } from '../middleware/errors.js';
import * as KfdbService from '../services/KfdbService.js';
import { dismissCandidate, executeDiscoveryRun, promoteCandidate } from '../services/DiscoveryOrchestrator.js';

const router = Router();

function defaultWindow(): { start: string; end: string } {
  const end = new Date();
  const start = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  };
}

router.get('/candidates', authOptional, async (req: Request, res: Response) => {
  try {
    const status = req.query.status as KfdbService.PaperCandidate['status'] | undefined;
    const topicProfileId = req.query.topicProfileId as string | undefined;
    const limit = parseInt(req.query.limit as string) || 100;
    const candidates = await KfdbService.listPaperCandidates({ status, topicProfileId, limit });
    candidates.sort((a, b) => {
      const scoreDelta = b.score_total - a.score_total;
      if (scoreDelta !== 0) return scoreDelta;
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    });
    res.json({ candidates });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.post('/candidates/:id/promote', authRequired, async (req: Request, res: Response) => {
  try {
    const candidate = await promoteCandidate(req.params.id as string);
    res.json({ candidate });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.post('/candidates/:id/dismiss', authRequired, async (req: Request, res: Response) => {
  try {
    const candidate = await dismissCandidate(req.params.id as string);
    res.json({ candidate });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.get('/runs', authOptional, async (req: Request, res: Response) => {
  try {
    const topicProfileId = req.query.topicProfileId as string | undefined;
    const status = req.query.status as KfdbService.DiscoveryRun['status'] | undefined;
    const limit = parseInt(req.query.limit as string) || 50;
    const runs = topicProfileId
      ? await KfdbService.listDiscoveryRunsForTopicProfile(topicProfileId, limit)
      : await KfdbService.listDiscoveryRuns(status, limit);
    runs.sort((a, b) => new Date(b.started_at || b.finished_at || 0).getTime() - new Date(a.started_at || a.finished_at || 0).getTime());
    res.json({ runs });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.post('/runs/execute', authOrSchedulerRequired, async (req: Request, res: Response) => {
  try {
    const { topicProfileId, queryWindowStart, queryWindowEnd, mode } = req.body as {
      topicProfileId?: string;
      queryWindowStart?: string;
      queryWindowEnd?: string;
      mode?: 'queued' | 'inline';
      force?: boolean;
    };
    const force = Boolean((req.body as { force?: boolean }).force);

    if (!topicProfileId) {
      throw new AppError(400, 'topicProfileId is required');
    }

    await KfdbService.getTopicProfile(topicProfileId);

    const fallbackWindow = defaultWindow();
    const start = queryWindowStart || fallbackWindow.start;
    const end = queryWindowEnd || fallbackWindow.end;
    const existing = await KfdbService.findDiscoveryRunByWindow(topicProfileId, start, end);
    if (existing) {
      if (force && mode === 'inline' && existing.status !== 'running') {
        const rerun = await KfdbService.updateDiscoveryRun(existing.id, {
          status: 'pending',
          started_at: '',
          finished_at: '',
          candidate_count: 0,
          promoted_count: 0,
          error_summary: '',
          created_by: req.wallet?.address || existing.created_by || 'scheduler',
        });
        const run = await executeDiscoveryRun(rerun.id);
        res.json({ run, deduplicated: true, executed: true, retried: true, forced: true });
        return;
      }

      if (existing.status === 'failed') {
        if (mode === 'inline') {
          const run = await executeDiscoveryRun(existing.id);
          res.json({ run, deduplicated: true, executed: true, retried: true });
          return;
        }

        const run = await KfdbService.updateDiscoveryRun(existing.id, {
          status: 'pending',
          started_at: '',
          finished_at: '',
          candidate_count: 0,
          promoted_count: 0,
          error_summary: '',
          created_by: req.wallet?.address || existing.created_by || 'scheduler',
        });
        res.json({ run, deduplicated: true, executed: false, retried: true });
        return;
      }

      if (mode === 'inline' && existing.status === 'pending') {
        const run = await executeDiscoveryRun(existing.id);
        res.json({ run, deduplicated: true, executed: true });
        return;
      }
      res.json({ run: existing, deduplicated: true, executed: false });
      return;
    }

    const run = await KfdbService.createDiscoveryRun({
      topic_profile_id: topicProfileId,
      status: 'pending',
      started_at: '',
      finished_at: '',
      query_window_start: start,
      query_window_end: end,
      candidate_count: 0,
      promoted_count: 0,
      error_summary: '',
      created_by: req.wallet?.address || 'scheduler',
    });

    if (mode === 'inline') {
      const executedRun = await executeDiscoveryRun(run.id);
      res.json({ run: executedRun, executed: true });
      return;
    }

    res.json({ run, executed: false });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

export default router;
