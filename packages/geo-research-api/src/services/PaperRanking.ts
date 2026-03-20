/**
 * Paper Ranking Service — Scores discovered papers by relevance.
 *
 * Scoring factors (weighted sum → 0-100):
 *   - Topic keyword match in title + abstract (weight: 0.40)
 *   - Recency — newer papers score higher (weight: 0.25)
 *   - Author overlap with existing KFDB papers (weight: 0.20)
 *   - Category alignment with configured interests (weight: 0.15)
 *
 * Reuses Jaccard similarity pattern from PaperRecommendation.ts.
 */

import type { ArxivPaper } from './ArxivClient.js';
import * as KfdbService from './KfdbService.js';

// ── Types ──────────────────────────────────────────────────────────────────

export interface RankedPaper {
  paper: ArxivPaper;
  score: number;
  breakdown: ScoreBreakdown;
}

export interface ScoreBreakdown {
  topicScore: number;
  recencyScore: number;
  authorScore: number;
  categoryScore: number;
}

export interface RankingConfig {
  /** Keywords that indicate relevance (matched against title + abstract) */
  topicKeywords: string[];
  /** Preferred arXiv categories */
  preferredCategories: string[];
  /** Weight overrides (all default to standard weights) */
  weights?: Partial<ScoringWeights>;
}

interface ScoringWeights {
  topic: number;
  recency: number;
  author: number;
  category: number;
}

// ── Defaults ───────────────────────────────────────────────────────────────

const DEFAULT_WEIGHTS: ScoringWeights = {
  topic: 0.40,
  recency: 0.25,
  author: 0.20,
  category: 0.15,
};

const DEFAULT_CONFIG: RankingConfig = {
  topicKeywords: [
    'knowledge graph', 'ontology', 'linked data', 'semantic web',
    'information extraction', 'named entity', 'relation extraction',
    'graph neural network', 'knowledge base',
  ],
  preferredCategories: ['cs.AI', 'cs.CL', 'cs.IR', 'cs.DB', 'cs.LG'],
};

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'by', 'for', 'from', 'in', 'into', 'is', 'of', 'on', 'or', 'the', 'to', 'with',
]);

// ── Similarity Helpers (from PaperRecommendation pattern) ──────────────────

function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  const setA = new Set(a.map(s => s.toLowerCase()));
  const setB = new Set(b.map(s => s.toLowerCase()));
  const intersection = [...setA].filter(x => setB.has(x));
  const union = new Set([...setA, ...setB]);
  return union.size > 0 ? intersection.length / union.size : 0;
}

function tokenizeKeyword(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 4 && !STOP_WORDS.has(token));
}

// ── Scoring Functions ──────────────────────────────────────────────────────

/**
 * Score keyword relevance in title + abstract.
 * Returns 0-1 based on fraction of topic keywords found.
 */
function scoreTopicMatch(paper: ArxivPaper, keywords: string[]): number {
  if (keywords.length === 0) return 0;

  const text = `${paper.title} ${paper.abstract}`.toLowerCase();
  const keywordScores = keywords.map((kw) => {
    const normalized = kw.toLowerCase();
    if (text.includes(normalized)) return 1;

    const tokens = tokenizeKeyword(kw);
    if (tokens.length === 0) return 0;
    const matchedTokens = tokens.filter((token) => text.includes(token)).length;
    return matchedTokens / tokens.length;
  });

  const strongestMatch = Math.max(...keywordScores, 0);
  const averageMatch = keywordScores.reduce((sum, score) => sum + score, 0) / keywordScores.length;

  // Strong single-keyword matches matter, but we still reward broader coverage.
  return Math.min(1, strongestMatch * 0.7 + averageMatch * 0.3);
}

/**
 * Score recency — papers from the last 7 days score 1.0,
 * decaying to 0.0 at 180 days.
 */
function scoreRecency(paper: ArxivPaper): number {
  const published = new Date(paper.published).getTime();
  const now = Date.now();
  const daysOld = (now - published) / (1000 * 60 * 60 * 24);

  if (daysOld <= 7) return 1.0;
  if (daysOld >= 180) return 0.0;

  // Linear decay from 7 to 180 days
  return 1.0 - (daysOld - 7) / (180 - 7);
}

/**
 * Score author overlap with existing KFDB papers.
 * Uses Jaccard similarity between paper authors and known authors.
 */
function scoreAuthorOverlap(paper: ArxivPaper, knownAuthors: string[]): number {
  return jaccard(paper.authors, knownAuthors);
}

/**
 * Score category alignment with preferred categories.
 * Uses Jaccard similarity between paper categories and preferred set.
 */
function scoreCategoryAlignment(paper: ArxivPaper, preferredCategories: string[]): number {
  return jaccard(paper.categories, preferredCategories);
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Rank a list of arXiv papers by relevance.
 * Returns papers sorted by score (highest first) with breakdown.
 */
export async function rankPapers(
  papers: ArxivPaper[],
  config: RankingConfig = DEFAULT_CONFIG,
): Promise<RankedPaper[]> {
  const weights: ScoringWeights = { ...DEFAULT_WEIGHTS, ...config.weights };

  // Collect known authors from existing KFDB papers
  let knownAuthors: string[] = [];
  try {
    const existing = await KfdbService.listDiscoveryPapers(undefined, 200);
    knownAuthors = existing.flatMap(p => p.authors || []);
  } catch {
    // KFDB may be unavailable; rank without author overlap
    console.warn('[PaperRanking] Could not fetch KFDB papers for author overlap, continuing without');
  }

  const ranked: RankedPaper[] = papers.map(paper => {
    const topicScore = scoreTopicMatch(paper, config.topicKeywords);
    const recencyScore = scoreRecency(paper);
    const authorScore = scoreAuthorOverlap(paper, knownAuthors);
    const categoryScore = scoreCategoryAlignment(paper, config.preferredCategories);

    const rawScore =
      weights.topic * topicScore +
      weights.recency * recencyScore +
      weights.author * authorScore +
      weights.category * categoryScore;

    // Scale to 0-100 and clamp
    const score = Math.round(Math.max(0, Math.min(100, rawScore * 100)));

    return {
      paper,
      score,
      breakdown: { topicScore, recencyScore, authorScore, categoryScore },
    };
  });

  ranked.sort((a, b) => b.score - a.score);
  return ranked;
}

/**
 * Rank papers and return only those above a minimum score threshold.
 */
export async function rankAndFilter(
  papers: ArxivPaper[],
  minScore = 20,
  config: RankingConfig = DEFAULT_CONFIG,
): Promise<RankedPaper[]> {
  const ranked = await rankPapers(papers, config);
  return ranked.filter(r => r.score >= minScore);
}

/**
 * Get the default ranking configuration.
 * Useful for UI to display/edit current settings.
 */
export function getDefaultConfig(): RankingConfig {
  return { ...DEFAULT_CONFIG };
}

/**
 * Get the default scoring weights.
 */
export function getDefaultWeights(): ScoringWeights {
  return { ...DEFAULT_WEIGHTS };
}
