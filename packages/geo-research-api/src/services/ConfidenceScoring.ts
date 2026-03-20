/**
 * Confidence scoring service for paper discovery results.
 *
 * Ported from ai_research src/routing/confidence_router.py.
 * Produces a 3-tier routing decision (auto_approve / review / skip)
 * based on the completeness and quality of the agent extraction.
 */

import type { DiscoveryPaper } from './KfdbService.js';

// ── Types ──────────────────────────────────────────────────────────────────

export interface ConfidenceFactors {
  claimCount: number;
  titlePresent: boolean;
  abstractPresent: boolean;
  authorsPresent: boolean;
  topicsPresent: boolean;
  parseSuccess: boolean;
  structuredData: boolean;
}

export type ConfidenceTier = 'auto_approve' | 'review' | 'skip';

export interface PaperConfidenceScore {
  score: number;           // 0.0 - 1.0
  tier: ConfidenceTier;
  reason: string;
  factors: ConfidenceFactors;
}

// ── Thresholds (from research: 0.70 auto, 0.40 review, <0.40 skip) ────────

const AUTO_APPROVE_THRESHOLD = 0.70;
const REVIEW_THRESHOLD = 0.40;

// ── Scoring weights ────────────────────────────────────────────────────────

const WEIGHT_TITLE = 0.15;
const WEIGHT_ABSTRACT = 0.20;
const WEIGHT_AUTHORS = 0.10;
const WEIGHT_TOPICS = 0.10;
const WEIGHT_PARSE = 0.20;
const WEIGHT_CLAIMS = 0.15;
const WEIGHT_STRUCTURED = 0.10;

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Score a paper extraction based on completeness of agent output.
 *
 * @param paper      The discovery paper record (may have updated fields)
 * @param claims     Array of extracted claims (any shape)
 * @param parseSuccess Whether the agent result was parsed successfully
 */
export function scorePaperExtraction(
  paper: Partial<DiscoveryPaper>,
  claims: unknown[],
  parseSuccess: boolean,
): PaperConfidenceScore {
  const titlePresent = Boolean(
    paper.title && paper.title.trim() !== '' && !paper.title.startsWith('arXiv:'),
  );
  const abstractPresent = Boolean(paper.abstract && paper.abstract.trim() !== '');
  const authorsPresent = Boolean(paper.authors && paper.authors.length > 0);
  const topicsPresent = Boolean(paper.topics && paper.topics.length > 0);
  const claimCount = claims.length;

  // structuredData = all primary fields present
  const structuredData = titlePresent && abstractPresent && authorsPresent && topicsPresent && parseSuccess;

  const factors: ConfidenceFactors = {
    claimCount,
    titlePresent,
    abstractPresent,
    authorsPresent,
    topicsPresent,
    parseSuccess,
    structuredData,
  };

  // Compute score: additive weights
  let score = 0;
  if (titlePresent) score += WEIGHT_TITLE;
  if (abstractPresent) score += WEIGHT_ABSTRACT;
  if (authorsPresent) score += WEIGHT_AUTHORS;
  if (topicsPresent) score += WEIGHT_TOPICS;
  if (parseSuccess) score += WEIGHT_PARSE;

  // Claims: partial credit up to 5 claims
  const claimCredit = Math.min(claimCount, 5) / 5;
  score += claimCredit * WEIGHT_CLAIMS;

  if (structuredData) score += WEIGHT_STRUCTURED;

  // Clamp to [0, 1]
  score = Math.max(0, Math.min(1, score));

  // Determine tier
  let tier: ConfidenceTier;
  let reason: string;
  if (score >= AUTO_APPROVE_THRESHOLD) {
    tier = 'auto_approve';
    reason = `High confidence (${score.toFixed(2)}) - auto-approved for review queue`;
  } else if (score >= REVIEW_THRESHOLD) {
    tier = 'review';
    reason = `Moderate confidence (${score.toFixed(2)}) - needs manual review`;
  } else {
    tier = 'skip';
    reason = `Low confidence (${score.toFixed(2)}) - extraction too incomplete`;
  }

  return { score, tier, reason, factors };
}

/**
 * Format a human-readable explanation of the confidence score.
 */
export function formatConfidenceExplanation(cs: PaperConfidenceScore): string {
  const lines: string[] = [
    `Confidence: ${cs.score.toFixed(2)} (${cs.tier})`,
    `Reason: ${cs.reason}`,
    'Factors:',
  ];
  const f = cs.factors;
  lines.push(`  title:       ${f.titlePresent ? 'yes' : 'NO'}  (+${WEIGHT_TITLE})`);
  lines.push(`  abstract:    ${f.abstractPresent ? 'yes' : 'NO'}  (+${WEIGHT_ABSTRACT})`);
  lines.push(`  authors:     ${f.authorsPresent ? 'yes' : 'NO'}  (+${WEIGHT_AUTHORS})`);
  lines.push(`  topics:      ${f.topicsPresent ? 'yes' : 'NO'}  (+${WEIGHT_TOPICS})`);
  lines.push(`  parseSuccess:${f.parseSuccess ? 'yes' : 'NO'}  (+${WEIGHT_PARSE})`);
  lines.push(`  claims:      ${f.claimCount}/5  (+${(Math.min(f.claimCount, 5) / 5 * WEIGHT_CLAIMS).toFixed(2)})`);
  lines.push(`  structured:  ${f.structuredData ? 'yes' : 'NO'}  (+${WEIGHT_STRUCTURED})`);
  return lines.join('\n');
}
