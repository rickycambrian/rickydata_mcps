import { Router, type Request, type Response } from 'express';
import { authRequired } from '../middleware/auth.js';
import * as KfdbService from '../services/KfdbService.js';
import * as GeoPublish from '../services/GeoPublish.js';
import * as GeoQuery from '../services/GeoQuery.js';
import * as PublishedPaperContextService from '../services/PublishedPaperContextService.js';

const router = Router();

// POST /publish/:paperId — publish approved paper to Geo
router.post('/:paperId', authRequired, async (req: Request, res: Response) => {
  try {
    const paperId = req.params.paperId as string;
    const paper = await KfdbService.getDiscoveryPaper(paperId);

    if (paper.status !== 'ready_for_review') {
      res.status(400).json({ error: `Paper status is "${paper.status}", expected "ready_for_review"` });
      return;
    }

    const claims = await KfdbService.getClaimsForPaper(paperId);

    // Apply edits: use edited_text if available
    const finalClaims = claims.map(c => ({
      ...c,
      text: c.edited_text || c.text,
    }));

    // Publish to Geo
    const result = await GeoPublish.publishPaperToGeo(paper, finalClaims, req.wallet!.address);

    // Record in KFDB
    await KfdbService.createPublishedRecord({
      paper_kfdb_id: paperId,
      geo_paper_entity_id: result.paperEntityId,
      geo_claim_entity_ids: result.claimEntityIds,
      geo_proposal_id: result.proposalId,
      geo_tx_hash: result.txHash,
      published_by: req.wallet!.address,
      published_at: new Date().toISOString(),
    });

    // Update paper status
    await KfdbService.updateDiscoveryPaperStatus(paperId, 'published');

    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /published — papers from Geo GraphQL, with KFDB fallback
router.get('/', async (_req: Request, res: Response) => {
  try {
    // Try Geo entities first
    let geoEntities: GeoQuery.GeoEntity[] = [];
    try {
      geoEntities = await GeoQuery.listPublishedPapers();
    } catch {
      // Geo query failed, continue with KFDB-only
    }

    // Always fetch KFDB records for metadata (proposal ID, tx hash, published_at, etc.)
    let kfdbRecords: KfdbService.PublishedRecord[] = [];
    try {
      kfdbRecords = await KfdbService.getPublishedRecords();
    } catch {
      // KFDB may not have the entity type yet if nothing has been published
    }

    // Build a lookup of KFDB records by geo_paper_entity_id
    const kfdbByEntityId = new Map(
      kfdbRecords.map(r => [r.geo_paper_entity_id, r]),
    );

    if (geoEntities.length > 0) {
      // Merge Geo entities with KFDB metadata, deduplicate by name
      const seen = new Set<string>();
      const papers = geoEntities
        .map(entity => {
          const kfdb = kfdbByEntityId.get(entity.id.replace(/-/g, ''));
          return {
            ...entity,
            source: 'geo' as const,
            geo_proposal_id: kfdb?.geo_proposal_id || null,
            geo_tx_hash: kfdb?.geo_tx_hash || null,
            published_by: kfdb?.published_by || null,
            published_at: kfdb?.published_at || null,
            claim_count: kfdb?.geo_claim_entity_ids?.length || 0,
          };
        })
        .filter(p => {
          if (seen.has(p.name)) return false;
          seen.add(p.name);
          return true;
        });
      res.json({ papers });
    } else {
      // Fallback: show KFDB records with their metadata
      const papers = kfdbRecords.map(record => ({
        id: record.geo_paper_entity_id || record.id,
        name: `Paper ${record.paper_kfdb_id}`,
        description: '',
        types: ['Paper'],
        source: 'kfdb' as const,
        geo_proposal_id: record.geo_proposal_id,
        geo_tx_hash: record.geo_tx_hash,
        published_by: record.published_by,
        published_at: record.published_at,
        claim_count: record.geo_claim_entity_ids?.length || 0,
      }));
      res.json({ papers });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /published/:entityId — single paper from Geo, with optional claims
router.get('/:entityId/context', async (req: Request, res: Response) => {
  try {
    const entityId = req.params.entityId as string;
    const context = await PublishedPaperContextService.getPublishedPaperContext(entityId);
    res.json(context);
  } catch (err: any) {
    if (err?.message === 'Published entity not found') {
      res.status(404).json({ error: 'Entity not found' });
      return;
    }
    res.status(500).json({ error: err.message });
  }
});

// GET /published/:entityId — single paper from Geo, with optional claims
router.get('/:entityId', async (req: Request, res: Response) => {
  try {
    const entityId = req.params.entityId as string;
    let entity;
    try {
      entity = await GeoQuery.getGeoEntity(entityId);
    } catch {
      // GraphQL returns 400 for malformed entity IDs
      res.status(404).json({ error: 'Entity not found' });
      return;
    }
    if (!entity) {
      res.status(404).json({ error: 'Entity not found' });
      return;
    }

    // Also fetch KFDB metadata for this entity
    let kfdbMeta: any = null;
    try {
      const records = await KfdbService.getPublishedRecords();
      kfdbMeta = records.find(r =>
        r.geo_paper_entity_id.replace(/-/g, '') === entityId.replace(/-/g, '')
      ) || null;
    } catch {
      // KFDB lookup is non-fatal
    }

    // Fetch claims for this paper — try KFDB IDs first, then fall back to Geo query
    let claims: GeoQuery.GeoEntity[] = [];
    try {
      if (kfdbMeta?.geo_claim_entity_ids?.length) {
        const claimPromises = kfdbMeta.geo_claim_entity_ids.map((cid: string) =>
          GeoQuery.getGeoEntity(cid).catch(() => null)
        );
        claims = (await Promise.all(claimPromises)).filter(Boolean) as GeoQuery.GeoEntity[];
      }
      // Fallback: query Geo for claims that reference this paper
      if (claims.length === 0) {
        claims = await GeoQuery.listClaimsForPaperEntity(entityId);
      }
    } catch {
      // Claims fetch is non-fatal
    }

    res.json({
      ...entity,
      claims,
      geo_proposal_id: kfdbMeta?.geo_proposal_id || null,
      geo_tx_hash: kfdbMeta?.geo_tx_hash || null,
      published_by: kfdbMeta?.published_by || null,
      published_at: kfdbMeta?.published_at || null,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
