/**
 * Agent Action Executor — executes confirmed agent-proposed actions.
 * Each action type delegates to existing service logic (KfdbService, GeoPublish).
 */

import * as KfdbService from './KfdbService.js';
import * as GeoPublish from './GeoPublish.js';

export type ActionType = 'approve_paper' | 'publish_paper' | 'submit_paper' | 'add_to_review' | 'edit_claim';

export interface ActionResult {
  success: boolean;
  actionType: ActionType;
  result: Record<string, unknown>;
  revalidateKeys: string[];
}

export async function executeAction(
  actionType: ActionType,
  params: Record<string, unknown>,
  walletAddress: string,
): Promise<ActionResult> {
  switch (actionType) {
    case 'approve_paper':
      return executeApprovePaper(params, walletAddress);
    case 'publish_paper':
      return executePublishPaper(params, walletAddress);
    case 'submit_paper':
      return executeSubmitPaper(params);
    case 'add_to_review':
      return executeAddToReview(params, walletAddress);
    case 'edit_claim':
      return executeEditClaim(params, walletAddress);
    default:
      throw new Error(`Unknown action type: ${actionType}`);
  }
}

async function executeApprovePaper(
  params: Record<string, unknown>,
  walletAddress: string,
): Promise<ActionResult> {
  const reviewId = String(params.reviewId || '');
  if (!reviewId) throw new Error('reviewId is required for approve_paper');

  const item = await KfdbService.getReviewItem(reviewId);
  if (item.wallet_address.toLowerCase() !== walletAddress.toLowerCase()) {
    throw new Error('You do not have access to this review item');
  }

  await KfdbService.updateReviewItem(item.id, { status: 'approved' });

  return {
    success: true,
    actionType: 'approve_paper',
    result: { reviewId: item.id, paperId: item.paper_kfdb_id, status: 'approved' },
    revalidateKeys: ['/api/v1/review', '/api/v1/discovery/stats'],
  };
}

async function executePublishPaper(
  params: Record<string, unknown>,
  walletAddress: string,
): Promise<ActionResult> {
  const paperId = String(params.paperId || '');
  if (!paperId) throw new Error('paperId is required for publish_paper');

  const paper = await KfdbService.getDiscoveryPaper(paperId);
  if (paper.status !== 'ready_for_review') {
    throw new Error(`Paper status is "${paper.status}", expected "ready_for_review"`);
  }

  const claims = await KfdbService.getClaimsForPaper(paperId);
  const finalClaims = claims.map(c => ({
    ...c,
    text: c.edited_text || c.text,
  }));

  const geoResult = await GeoPublish.publishPaperToGeo(paper, finalClaims, walletAddress);

  await KfdbService.createPublishedRecord({
    paper_kfdb_id: paperId,
    geo_paper_entity_id: geoResult.paperEntityId,
    geo_claim_entity_ids: geoResult.claimEntityIds,
    geo_proposal_id: geoResult.proposalId,
    geo_tx_hash: geoResult.txHash,
    published_by: walletAddress,
    published_at: new Date().toISOString(),
  });

  await KfdbService.updateDiscoveryPaperStatus(paperId, 'published');

  return {
    success: true,
    actionType: 'publish_paper',
    result: {
      paperId,
      proposalId: geoResult.proposalId,
      txHash: geoResult.txHash,
      paperEntityId: geoResult.paperEntityId,
      claimCount: geoResult.claimEntityIds.length,
    },
    revalidateKeys: ['/api/v1/published', '/api/v1/discovery/stats'],
  };
}

async function executeSubmitPaper(
  params: Record<string, unknown>,
): Promise<ActionResult> {
  const arxivId = String(params.arxivId || '');
  if (!arxivId) throw new Error('arxivId is required for submit_paper');

  const arxivIdRegex = /^\d{4}\.\d{4,5}(v\d+)?$/;
  if (!arxivIdRegex.test(arxivId)) {
    throw new Error(`Invalid arXiv ID format: ${arxivId}`);
  }

  // Check for existing paper to avoid duplicates
  const existing = await KfdbService.findPaperByArxivId(arxivId);
  if (existing) {
    return {
      success: true,
      actionType: 'submit_paper',
      result: { arxivId, paperId: existing.id, alreadyExists: true },
      revalidateKeys: ['/api/v1/discovery', '/api/v1/discovery/stats'],
    };
  }

  // Stub: actual extraction would be triggered via the discovery SSE flow
  return {
    success: true,
    actionType: 'submit_paper',
    result: { arxivId, stub: true, message: 'Paper submitted for discovery. Use the discovery flow for full extraction.' },
    revalidateKeys: ['/api/v1/discovery', '/api/v1/discovery/stats'],
  };
}

async function executeAddToReview(
  params: Record<string, unknown>,
  walletAddress: string,
): Promise<ActionResult> {
  const paperId = String(params.paperId || '');
  if (!paperId) throw new Error('paperId is required for add_to_review');

  const item = await KfdbService.createReviewItem(walletAddress, paperId);

  return {
    success: true,
    actionType: 'add_to_review',
    result: { reviewId: item.id, paperId },
    revalidateKeys: ['/api/v1/review', '/api/v1/discovery/stats'],
  };
}

async function executeEditClaim(
  params: Record<string, unknown>,
  walletAddress: string,
): Promise<ActionResult> {
  const claimId = String(params.claimId || '');
  const text = String(params.text || '');
  if (!claimId) throw new Error('claimId is required for edit_claim');
  if (!text) throw new Error('text is required for edit_claim');

  await KfdbService.updateClaim(claimId, {
    edited_text: text,
    edited_by: walletAddress,
    status: 'edited',
  });

  const reviewId = params.reviewId ? String(params.reviewId) : undefined;

  return {
    success: true,
    actionType: 'edit_claim',
    result: { claimId, edited: true },
    revalidateKeys: reviewId ? [`/api/v1/review/${reviewId}`] : ['/api/v1/review'],
  };
}
