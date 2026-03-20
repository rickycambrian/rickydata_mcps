import { Router, type Request, type Response } from 'express';
import { Readable } from 'node:stream';

const router = Router();

const ARXIV_ID_RE = /^\d{4}\.\d{4,5}(v\d+)?$/;

// GET /papers/:arxivId/pdf — proxy arXiv PDF to avoid CORS issues
router.get('/:arxivId/pdf', async (req: Request, res: Response) => {
  const arxivId = req.params.arxivId as string;

  if (!ARXIV_ID_RE.test(arxivId)) {
    res.status(400).json({ error: `Invalid arXiv ID format: "${arxivId}"` });
    return;
  }

  try {
    const pdfUrl = `https://arxiv.org/pdf/${encodeURIComponent(arxivId)}`;
    const upstream = await fetch(pdfUrl, {
      headers: {
        'User-Agent': 'GeoResearchPapers/1.0',
      },
    });

    if (!upstream.ok) {
      res.status(upstream.status).json({ error: `arXiv returned ${upstream.status}` });
      return;
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Cache-Control', 'public, max-age=86400');

    // Forward Content-Length if available
    const contentLength = upstream.headers.get('content-length');
    if (contentLength) {
      res.setHeader('Content-Length', contentLength);
    }

    // Stream the response body
    if (!upstream.body) {
      res.status(502).json({ error: 'No response body from arXiv' });
      return;
    }

    // Convert web ReadableStream to Node.js Readable and pipe
    const nodeStream = Readable.fromWeb(upstream.body as import('stream/web').ReadableStream);
    nodeStream.pipe(res);

    nodeStream.on('error', (err) => {
      console.error('[PAPERS] PDF stream error:', err.message);
      if (!res.headersSent) {
        res.status(502).json({ error: 'Failed to stream PDF' });
      } else {
        res.end();
      }
    });
  } catch (err: any) {
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
});

export default router;
