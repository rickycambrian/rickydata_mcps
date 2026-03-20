import { Router, type Request, type Response } from 'express';
import { authRequired, authOptional } from '../middleware/auth.js';
import { AppError } from '../middleware/errors.js';
import * as KfdbService from '../services/KfdbService.js';
import * as AgentProxy from '../services/AgentProxy.js';
import * as GeoQuery from '../services/GeoQuery.js';
import { getRelatedPapers } from '../services/PaperRecommendation.js';
import { searchPapers } from '../services/ArxivClient.js';
import { rankAndFilter, type RankingConfig } from '../services/PaperRanking.js';
import { enrichPaperGraph, getGraphStats as computeGraphStats } from '../services/GraphEnrichment.js';
import { extractPaperWithAgent } from '../services/DiscoveryOrchestrator.js';

const router = Router();

// arXiv ID pattern — used to detect when a param is an arXiv ID vs KFDB UUID
const ARXIV_ID_PATTERN = /^\d{4}\.\d{4,5}(v\d+)?$/;

/** Resolve a param that may be a KFDB UUID or arXiv ID to a KFDB paper ID */
async function resolveToKfdbId(idOrArxiv: string): Promise<string> {
  if (ARXIV_ID_PATTERN.test(idOrArxiv)) {
    const paper = await KfdbService.findPaperByArxivId(idOrArxiv);
    if (!paper) throw new AppError(404, `Paper not found for arXiv ID: ${idOrArxiv}`);
    return paper.id;
  }
  return idOrArxiv;
}

// In-memory lock to prevent duplicate concurrent submissions for the same arXiv ID
const processingArxivIds = new Set<string>();

// GET /discovery — global feed (public), supports ?search=, ?status=, ?sort=, ?limit=
router.get('/', authOptional, async (req: Request, res: Response) => {
  try {
    const status = req.query.status as string | undefined;
    const search = req.query.search as string | undefined;
    const sort = req.query.sort as string | undefined;
    const limit = parseInt(req.query.limit as string) || 50;
    let papers = await KfdbService.listDiscoveryPapers(status, limit);

    // Client-side search filter (title, abstract, arxiv_id, authors)
    if (search) {
      const q = search.toLowerCase();
      papers = papers.filter(p =>
        p.title.toLowerCase().includes(q) ||
        p.abstract.toLowerCase().includes(q) ||
        p.arxiv_id.toLowerCase().includes(q) ||
        (p.authors || []).some(a => a.toLowerCase().includes(q))
      );
    }

    // Sort
    if (sort === 'oldest') {
      papers.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    } else if (sort === 'most_claims') {
      papers.sort((a, b) => (b.claim_count || 0) - (a.claim_count || 0));
    } else {
      // Default: newest first
      papers.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    }

    // Resolve author entity IDs to names for the feed
    const allAuthorIds = new Set<string>();
    for (const p of papers) {
      for (const a of p.authors || []) {
        if (GeoQuery.looksLikeEntityId(a)) allAuthorIds.add(a);
      }
    }
    let authorNameMap = new Map<string, string>();
    if (allAuthorIds.size > 0) {
      try {
        authorNameMap = await GeoQuery.resolveEntityNames([...allAuthorIds]);
      } catch {
        // Non-fatal
      }
    }
    const resolvedPapers = papers.map(p => ({
      ...p,
      authors: (p.authors || []).map(a =>
        GeoQuery.looksLikeEntityId(a)
          ? authorNameMap.get(a.replace(/-/g, '')) || a
          : a,
      ),
    }));

    res.json({ papers: resolvedPapers });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /discovery/stats — aggregate counts + confidence distribution
router.get('/stats', async (_req: Request, res: Response) => {
  try {
    const all = await KfdbService.listDiscoveryPapers(undefined, 1000);

    // Confidence distribution buckets
    const scored = all.filter(p => typeof p.confidence_score === 'number');
    const confidenceDistribution = {
      auto_approve: scored.filter(p => p.confidence_tier === 'auto_approve').length,
      review: scored.filter(p => p.confidence_tier === 'review').length,
      skip: scored.filter(p => p.confidence_tier === 'skip').length,
      unscored: all.length - scored.length,
      avg_score: scored.length > 0
        ? Number((scored.reduce((sum, p) => sum + (p.confidence_score || 0), 0) / scored.length).toFixed(3))
        : null,
    };

    const stats = {
      total: all.length,
      processing: all.filter(p => p.status === 'processing').length,
      ready_for_review: all.filter(p => p.status === 'ready_for_review').length,
      published: all.filter(p => p.status === 'published').length,
      failed: all.filter(p => p.status === 'failed').length,
      confidence: confidenceDistribution,
    };
    res.json(stats);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /discovery/graph-stats — knowledge graph density and edge statistics
// NOTE: Must be defined BEFORE /:id routes to avoid Express matching "graph-stats" as an ID
router.get('/graph-stats', async (_req: Request, res: Response) => {
  try {
    const stats = await computeGraphStats();
    res.json(stats);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /discovery/config — get discovery configuration
// NOTE: Must be defined BEFORE /:id routes to avoid Express matching "config" as an ID
router.get('/config', authRequired, async (_req: Request, res: Response) => {
  try {
    const config = await KfdbService.getDiscoveryConfig();
    res.json({ config: config || { categories: 'cs.AI', keywords: '', min_relevance_score: 50, enabled: 'false' } });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /discovery/:id — delete a paper (admin cleanup)
router.delete('/:id', authRequired, async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    await KfdbService.deleteDiscoveryPaper(id);
    res.json({ deleted: true, id });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// GET /discovery/:id/related — papers related by topic and author overlap (graph@1)
router.get('/:id/related', async (req: Request, res: Response) => {
  try {
    const id = await resolveToKfdbId(req.params.id as string);
    const limit = parseInt(req.query.limit as string) || 10;
    const recommendations = await getRelatedPapers(id, limit);
    res.json({
      paper_id: id,
      related: recommendations.map(r => ({
        id: r.paper.id,
        arxiv_id: r.paper.arxiv_id,
        title: r.paper.title,
        score: r.score,
        shared_topics: r.shared_topics,
        shared_authors: r.shared_authors,
        reason: r.reason,
        status: r.paper.status,
        confidence_score: r.paper.confidence_score,
      })),
      count: recommendations.length,
    });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// GET /discovery/:id — paper detail + claims (resolves Geo entity IDs to names)
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const kfdbId = await resolveToKfdbId(req.params.id as string);
    const paper = await KfdbService.getDiscoveryPaper(kfdbId);
    const claims = await KfdbService.getClaimsForPaper(kfdbId);

    // Collect entity IDs that need resolution (claims text + author names)
    const idsToResolve = new Set<string>();
    for (const claim of claims) {
      if (GeoQuery.looksLikeEntityId(claim.text)) idsToResolve.add(claim.text);
    }
    for (const author of paper.authors || []) {
      if (GeoQuery.looksLikeEntityId(author)) idsToResolve.add(author);
    }

    // Batch resolve from Geo
    let nameMap = new Map<string, string>();
    if (idsToResolve.size > 0) {
      try {
        nameMap = await GeoQuery.resolveEntityNames([...idsToResolve]);
      } catch {
        // Geo resolution is non-fatal — show IDs as fallback
      }
    }

    // Resolve claim text
    const resolvedClaims = claims.map(c => ({
      ...c,
      text: GeoQuery.looksLikeEntityId(c.text)
        ? nameMap.get(c.text.replace(/-/g, '')) || c.text
        : c.text,
    }));

    // Resolve author names
    const resolvedAuthors = (paper.authors || []).map(a =>
      GeoQuery.looksLikeEntityId(a)
        ? nameMap.get(a.replace(/-/g, '')) || a
        : a,
    );

    res.json({
      paper: { ...paper, authors: resolvedAuthors },
      claims: resolvedClaims,
    });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// POST /discovery/cleanup — mark stuck processing papers as failed
router.post('/cleanup', authRequired, async (_req: Request, res: Response) => {
  try {
    const processing = await KfdbService.listDiscoveryPapers('processing', 200);
    let cleaned = 0;
    for (const paper of processing) {
      await KfdbService.updateDiscoveryPaperStatus(paper.id, 'failed');
      cleaned++;
    }
    res.json({ cleaned, papers: processing.map(p => ({ id: p.id, arxiv_id: p.arxiv_id, title: p.title })) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /discovery/auto-discover — auto-discover papers from arXiv based on config
router.post('/auto-discover', authRequired, async (req: Request, res: Response) => {
  try {
    // Read discovery config from KFDB
    const config = await KfdbService.getDiscoveryConfig();
    const categories = config?.categories?.split(',').map(c => c.trim()).filter(Boolean) || ['cs.AI'];
    const keywords = config?.keywords || '';
    const minScore = config?.min_relevance_score ?? 50;

    // Query arXiv
    const arxivPapers = await searchPapers({
      categories,
      keyword: keywords || undefined,
      maxResults: 50,
      sortBy: 'submittedDate',
    });

    // Build ranking config from discovery config
    const rankingConfig: RankingConfig = {
      topicKeywords: keywords.split(',').map(k => k.trim()).filter(Boolean),
      preferredCategories: categories,
    };

    // Rank and filter
    const ranked = await rankAndFilter(arxivPapers, minScore, rankingConfig);

    // Deduplicate against existing KFDB papers
    let discovered = 0;
    let skipped = 0;
    const newPapers: any[] = [];

    for (const { paper, score } of ranked) {
      const existing = await KfdbService.findPaperByArxivId(paper.arxivId);
      if (existing) {
        skipped++;
        continue;
      }

      const created = await KfdbService.createDiscoveryPaper({
        arxiv_id: paper.arxivId,
        title: paper.title,
        abstract: paper.abstract,
        authors: paper.authors,
        published_date: paper.published,
        web_url: `https://arxiv.org/abs/${paper.arxivId}`,
        status: 'ready_for_review',
        discovered_by: req.wallet!.address,
        topics: paper.categories,
        claim_count: 0,
      });

      newPapers.push({ ...created, relevance_score: score });
      discovered++;
    }

    res.json({ discovered, skipped, papers: newPapers });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /discovery/config — update discovery configuration
router.put('/config', authRequired, async (req: Request, res: Response) => {
  try {
    const { categories, keywords, min_relevance_score, enabled } = req.body;
    const config = await KfdbService.updateDiscoveryConfig({
      ...(categories !== undefined && { categories }),
      ...(keywords !== undefined && { keywords }),
      ...(min_relevance_score !== undefined && { min_relevance_score }),
      ...(enabled !== undefined && { enabled }),
    });
    res.json({ config });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /discovery/:id/relationships — get paper relationships
router.get('/:id/relationships', async (req: Request, res: Response) => {
  try {
    const id = await resolveToKfdbId(req.params.id as string);
    const relationships = await KfdbService.getPaperRelationships(id);
    res.json({ relationships });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// POST /discovery/:id/enrich — trigger graph enrichment for a paper
router.post('/:id/enrich', authRequired, async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const stats = await enrichPaperGraph(id);
    res.json({ paper_id: id, ...stats });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// arXiv ID format: 2301.07041 or 2301.07041v2
const ARXIV_ID_RE = /^\d{4}\.\d{4,5}(v\d+)?$/;

const STREAM_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// POST /discovery — submit arXiv ID, triggers agent
router.post('/', authRequired, async (req: Request, res: Response) => {
  const { arxivId, model } = req.body;

  // 1. Validate arXiv ID format
  if (!arxivId) {
    res.status(400).json({ error: 'arxivId required' });
    return;
  }
  if (!ARXIV_ID_RE.test(arxivId)) {
    res.status(400).json({ error: `Invalid arXiv ID format: "${arxivId}". Expected format like 2301.07041 or 2301.07041v2` });
    return;
  }

  try {
    // 2. Dedup check — if paper already exists and isn't failed, return it
    const existing = await KfdbService.findPaperByArxivId(arxivId);
    if (existing && existing.status !== 'failed') {
      res.json({ paper: existing, deduplicated: true });
      return;
    }

    // In-memory lock to prevent race condition with concurrent requests
    if (processingArxivIds.has(arxivId)) {
      res.status(409).json({ error: `Paper ${arxivId} is already being processed` });
      return;
    }
    processingArxivIds.add(arxivId);

    // Create paper record in KFDB as "processing"
    const paper = await KfdbService.createDiscoveryPaper({
      arxiv_id: arxivId,
      title: `arXiv:${arxivId}`,
      abstract: '',
      authors: [],
      published_date: '',
      web_url: `https://arxiv.org/abs/${arxivId}`,
      status: 'processing',
      discovered_by: req.wallet!.address,
      topics: [],
      claim_count: 0,
    });

    // Set SSE headers for streaming
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    try {
      let toolCallCount = 0;
      await extractPaperWithAgent({
        paperId: paper.id,
        arxivId,
        model: model || 'haiku',
        onEvent: async (event) => {
          if (event.type === 'tool_call') {
            toolCallCount++;
            res.write(`data: ${JSON.stringify({ type: 'progress', data: { message: `Tool call ${toolCallCount}`, toolIndex: toolCallCount } })}\n\n`);
          }
          if (event.type === 'paper_created' || event.type === 'extraction_complete' || event.type === 'progress' || event.type === 'error' || event.type === 'stream_end') {
            res.write(`data: ${JSON.stringify(event)}\n\n`);
            return;
          }
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        },
      });
    } catch (err: any) {
      await KfdbService.updateDiscoveryPaperStatus(paper.id, 'failed').catch(() => {});
      res.write(`data: ${JSON.stringify({ type: 'error', data: { message: err.message } })}\n\n`);
    } finally {
      res.write(`data: ${JSON.stringify({ type: 'stream_end' })}\n\n`);
      res.end();
    }
  } catch (err: any) {
    // 5. Pre-header errors return JSON; post-header errors go via SSE
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    } else {
      res.write(`data: ${JSON.stringify({ type: 'error', data: { message: err.message } })}\n\n`);
      res.end();
    }
  } finally {
    processingArxivIds.delete(arxivId);
  }
});

// ── Claim CRUD endpoints ─────────────────────────────────────────────────

// POST /discovery/:id/extract-claims — trigger claim extraction via agent
router.post('/:id/extract-claims', authRequired, async (req: Request, res: Response) => {
  const id = req.params.id as string;
  const { model } = req.body || {};

  try {
    const paper = await KfdbService.getDiscoveryPaper(id);
    if (!paper.arxiv_id) {
      res.status(400).json({ error: 'Paper has no arXiv ID' });
      return;
    }

    // Switch to SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    res.write(`data: ${JSON.stringify({ type: 'extraction_started', data: { paperId: id } })}\n\n`);

    try {
      await extractPaperWithAgent({
        paperId: id,
        arxivId: paper.arxiv_id,
        model: model || 'sonnet',
        onEvent: async (event) => {
          if (event.type === 'paper_created') return;
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        },
      });
    } catch (err: any) {
      res.write(`data: ${JSON.stringify({ type: 'error', data: { message: err.message } })}\n\n`);
    } finally {
      res.write(`data: ${JSON.stringify({ type: 'stream_end' })}\n\n`);
      res.end();
    }
  } catch (err: any) {
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    } else {
      res.write(`data: ${JSON.stringify({ type: 'error', data: { message: err.message } })}\n\n`);
      res.end();
    }
  }
});

// PUT /discovery/:id/claims/:claimId — update claim text/role
router.put('/:id/claims/:claimId', authRequired, async (req: Request, res: Response) => {
  try {
    const claimId = req.params.claimId as string;
    const { text, role } = req.body as { text?: string; role?: string };

    if (!text && !role) {
      res.status(400).json({ error: 'At least one of text or role is required' });
      return;
    }

    const updates: Record<string, unknown> = {};
    if (text !== undefined) {
      updates.edited_text = text;
      updates.status = 'edited';
      updates.edited_by = req.wallet!.address;
    }
    if (role !== undefined) {
      updates.role = role;
    }

    await KfdbService.updateClaim(claimId, updates as Partial<KfdbService.ExtractedClaim>);
    const updated = await KfdbService.getClaim(claimId);
    res.json({ claim: updated });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// POST /discovery/:id/claims/:claimId/refine — conversational claim refinement via agent
router.post('/:id/claims/:claimId/refine', authRequired, async (req: Request, res: Response) => {
  const claimId = req.params.claimId as string;
  const { message, sessionId } = req.body as { message?: string; sessionId?: string };

  if (!message) {
    res.status(400).json({ error: 'message is required' });
    return;
  }
  if (!sessionId) {
    res.status(400).json({ error: 'sessionId is required' });
    return;
  }

  try {
    const claim = await KfdbService.getClaim(claimId);

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const refinementPrompt = `The user wants to refine this claim:\n\nCurrent claim text: "${claim.edited_text || claim.text}"\nClaim role: ${claim.role}\n\nUser's request: ${message}\n\nPlease suggest an improved version of the claim based on the user's feedback.`;

    const stream = await AgentProxy.sendMessage(sessionId, refinementPrompt, 'research-paper-analyst-geo-uploader');
    if (!stream) {
      res.write(`data: ${JSON.stringify({ type: 'error', data: { message: 'No response stream from agent' } })}\n\n`);
      res.end();
      return;
    }

    let streamTimedOut = false;
    const timeoutId = setTimeout(() => {
      streamTimedOut = true;
      res.write(`data: ${JSON.stringify({ type: 'error', data: { message: 'Agent stream timed out' } })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'stream_end' })}\n\n`);
      res.end();
    }, STREAM_TIMEOUT_MS);

    try {
      for await (const event of AgentProxy.parseSSEStream(stream)) {
        if (streamTimedOut) break;
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    } finally {
      clearTimeout(timeoutId);
    }

    if (!streamTimedOut) {
      res.write(`data: ${JSON.stringify({ type: 'stream_end' })}\n\n`);
      res.end();
    }
  } catch (err: any) {
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    } else {
      res.write(`data: ${JSON.stringify({ type: 'error', data: { message: err.message } })}\n\n`);
      res.end();
    }
  }
});

// POST /discovery/:id/claims/add — manually add a new claim
router.post('/:id/claims/add', authRequired, async (req: Request, res: Response) => {
  try {
    const paperId = req.params.id as string;
    const { text, role } = req.body as { text?: string; role?: string };

    if (!text) {
      res.status(400).json({ error: 'text is required' });
      return;
    }

    // Get existing claims to determine next position
    const existingClaims = await KfdbService.getClaimsForPaper(paperId);
    const nextPosition = existingClaims.length + 1;

    const claim = await KfdbService.createExtractedClaim({
      paper_kfdb_id: paperId,
      text,
      position: nextPosition,
      role: role || 'contribution',
      source_quote: '',
      status: 'pending',
      edited_text: '',
      edited_by: req.wallet!.address,
    });

    // Update claim count on the paper
    await KfdbService.updateDiscoveryPaper(paperId, { claim_count: nextPosition });

    res.json({ claim });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// DELETE /discovery/:id/claims/:claimId — delete a claim
router.delete('/:id/claims/:claimId', authRequired, async (req: Request, res: Response) => {
  try {
    const paperId = req.params.id as string;
    const claimId = req.params.claimId as string;

    await KfdbService.deleteClaim(claimId);

    // Update claim count
    const remaining = await KfdbService.getClaimsForPaper(paperId);
    await KfdbService.updateDiscoveryPaper(paperId, { claim_count: remaining.length });

    res.json({ deleted: true, claimId });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

export default router;
