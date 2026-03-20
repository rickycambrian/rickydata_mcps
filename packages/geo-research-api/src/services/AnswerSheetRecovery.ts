/**
 * Answer Sheet recovery service.
 *
 * When the agent encounters errors during discovery, match against the
 * KFDB answer sheet database for known solutions. Uses the existing
 * /api/v1/answer-sheets/match endpoint deployed in the Agent Gateway.
 */

import { config } from '../config/index.js';

const KFDB_URL = config.kfdb.url;

const HEADERS: Record<string, string> = {
  'Content-Type': 'application/json',
  Accept: 'application/json',
  ...(config.kfdb.apiKey ? { Authorization: `Bearer ${config.kfdb.apiKey}` } : {}),
};

// Error patterns that are worth retrying with answer sheet guidance
const RETRYABLE_PATTERNS = [
  /timeout/i,
  /rate.?limit/i,
  /parse.*error/i,
  /json.*invalid/i,
  /connection.*refused/i,
  /econnreset/i,
  /fetch.*failed/i,
  /agent.*failed/i,
];

export interface AnswerSheetMatch {
  id: string;
  category: string;
  error_signature: string;
  solution_steps: unknown[];
  confidence: number;
  match_score: number;
}

/**
 * Match an agent error against known answer sheets in KFDB.
 *
 * @param errorText  The error message or stack trace
 * @param context    Optional context (tool name, language, etc.)
 * @returns          Matched answer sheets sorted by relevance, or empty array
 */
export async function matchAgentError(
  errorText: string,
  context?: { tool?: string; language?: string },
): Promise<AnswerSheetMatch[]> {
  try {
    const body: Record<string, unknown> = {
      error_text: errorText,
      limit: 3,
    };
    if (context?.tool) body.tool = context.tool;
    if (context?.language) body.language = context.language;

    const res = await fetch(`${KFDB_URL}/api/v1/answer-sheets/match`, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      console.warn(`[ANSWER_SHEET] Match endpoint returned ${res.status}`);
      return [];
    }

    const data = await res.json();
    return (data.matches || data.sheets || []) as AnswerSheetMatch[];
  } catch (err) {
    // Answer sheet matching is best-effort; never block the main flow
    console.warn('[ANSWER_SHEET] Match request failed:', (err as Error).message);
    return [];
  }
}

/**
 * Determine whether an error is worth retrying with answer sheet recovery.
 */
export function shouldRetryWithRecovery(errorText: string): boolean {
  return RETRYABLE_PATTERNS.some(pattern => pattern.test(errorText));
}
