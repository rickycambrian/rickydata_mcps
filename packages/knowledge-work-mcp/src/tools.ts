import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { FailClosedError } from './errors.js';
import { ok, fail } from './response.js';
import type { HomeKnowledgeClient } from './home-client.js';
import type { KfdbKnowledgeClient } from './kfdb-client.js';
import { buildDiscoveryCapture, buildOpenQuestionCapture } from './atoms.js';

export interface RegisterToolsDeps {
  home: HomeKnowledgeClient;
  kfdb: KfdbKnowledgeClient | null;
  operatorTools?: boolean;
}

function requireKfdb(client: KfdbKnowledgeClient | null): KfdbKnowledgeClient {
  if (!client) {
    throw new FailClosedError('KFDB_API_URL and KFDB_API_KEY are required for knowledge-work-mcp KFDB-backed tools.');
  }
  return client;
}

function fallbackReason(err: unknown): Record<string, unknown> {
  return {
    home_error: err instanceof Error ? err.message : String(err),
  };
}

function rankedCount(result: unknown): number {
  if (!result || typeof result !== 'object') return 0;
  const ranked = (result as Record<string, unknown>)['ranked'];
  return Array.isArray(ranked) ? ranked.length : 0;
}

interface NextQuestionReader {
  nextQuestions(input: { topic?: string; limit: number }): Promise<unknown>;
}

interface ReviewPendingReader {
  reviewPending(limit: number): Promise<unknown>;
}

export async function resolveNextQuestions(
  home: NextQuestionReader,
  kfdb: NextQuestionReader | null,
  input: { topic?: string; limit: number },
): Promise<unknown> {
  const kfdbQuestions = kfdb
    ? kfdb
      .nextQuestions(input)
      .then((value) => ({ ok: true as const, value }))
      .catch((error: unknown) => ({ ok: false as const, error }))
    : null;

  if (input.topic?.trim() && kfdbQuestions) {
    const focused = await kfdbQuestions;
    if (focused.ok && rankedCount(focused.value) > 0) {
      return {
        ...(focused.value as Record<string, unknown>),
        topic_scoped_fast_path: true,
      };
    }
  }

  try {
    const homeQuestions = await home.nextQuestions(input);
    if (rankedCount(homeQuestions) > 0 || !kfdbQuestions) return homeQuestions;
    const fallback = await kfdbQuestions;
    if (fallback.ok) {
      return {
        ...(fallback.value as Record<string, unknown>),
        home_next_questions_empty: true,
        home_total_ranked: (homeQuestions as Record<string, unknown>)['total_ranked'] ?? 0,
      };
    }
    return {
      ...(homeQuestions as Record<string, unknown>),
      kfdb_fallback_error: fallback.error instanceof Error ? fallback.error.message : String(fallback.error),
    };
  } catch (err) {
    if (kfdbQuestions) {
      const fallback = await kfdbQuestions;
      if (fallback.ok) return { ...(fallback.value as Record<string, unknown>), ...fallbackReason(err) };
    }
    throw err;
  }
}

async function readReviewPendingWithin(
  home: ReviewPendingReader,
  limit: number,
  timeoutMs: number,
): Promise<{ ok: true; value: unknown } | { ok: false; error: unknown; timedOut: boolean }> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      home.reviewPending(limit)
        .then((value) => ({ ok: true as const, value }))
        .catch((error: unknown) => ({ ok: false as const, error, timedOut: false as const })),
      new Promise<{ ok: false; error: Error; timedOut: true }>((resolve) => {
        timer = setTimeout(() => resolve({
          ok: false,
          error: new Error(`home review_pending timed out after ${timeoutMs}ms`),
          timedOut: true,
        }), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function queueItemCount(result: unknown): number {
  if (!result || typeof result !== 'object') return 0;
  const items = (result as Record<string, unknown>)['items'];
  return Array.isArray(items) ? items.length : 0;
}

function queueItems(result: unknown): Array<Record<string, unknown>> {
  if (!result || typeof result !== 'object') return [];
  const items = (result as Record<string, unknown>)['items'];
  return Array.isArray(items)
    ? items.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    : [];
}

function mergeReviewPendingResults(kfdb: unknown, home: unknown, limit: number): Record<string, unknown> {
  const kfdbItems = queueItems(kfdb);
  const homeItems = queueItems(home);
  const freshPending = kfdbItems.filter((item) => item['kind'] !== 'open_question');
  const kfdbQuestions = kfdbItems.filter((item) => item['kind'] === 'open_question');
  const byId = new Map<string, Record<string, unknown>>();
  for (const item of [...freshPending, ...homeItems, ...kfdbQuestions]) {
    const id = String(item['id'] ?? '').trim();
    if (id && !byId.has(id)) byId.set(id, item);
  }
  const items = [...byId.values()].slice(0, Math.max(1, limit));
  const counts: Record<string, number> = {};
  for (const item of items) {
    const kind = String(item['kind'] ?? 'unknown');
    counts[kind] = (counts[kind] ?? 0) + 1;
  }
  const kfdbValue = kfdb && typeof kfdb === 'object' ? kfdb as Record<string, unknown> : {};
  const homeValue = home && typeof home === 'object' ? home as Record<string, unknown> : {};
  return {
    ...homeValue,
    ...(kfdbValue['fallback'] ? { fallback: kfdbValue['fallback'] } : {}),
    counts,
    items,
    home_counts: homeValue['counts'] ?? {},
    merged_pending_sources: true,
  };
}

export function reviewPendingFallbackFromQuestions(result: unknown, limit: number): Record<string, unknown> {
  const value = result && typeof result === 'object' ? result as Record<string, unknown> : {};
  const ranked = Array.isArray(value['ranked']) ? value['ranked'] as Array<Record<string, unknown>> : [];
  const items = ranked.slice(0, limit).map((question) => {
    const id = String(question['id'] ?? '').trim();
    const title = String(question['question'] ?? '').trim() || `Open question ${id || 'unknown'}`;
    const reason = String(question['whyItMatters'] ?? question['why_it_matters'] ?? '').trim() || 'Open question awaiting an operator answer.';
    return {
      id,
      kind: 'open_question',
      title,
      reason,
      sourceRef: { label: 'OpenQuestion', nodeId: id, scope: 'private' },
    };
  }).filter((item) => item.id);
  return {
    counts: items.length > 0 ? { open_question: items.length } : {},
    items,
    fallback: {
      source: 'kfdb_open_questions',
      reason: 'home review_pending unavailable or empty',
      total_open: typeof value['total_ranked'] === 'number' ? value['total_ranked'] : ranked.length,
      ranking: 'value = blocking x gap x freshness x answerability; blocking and gap default to baseline in MCP fallback',
    },
  };
}

export async function resolveReviewPending(
  home: ReviewPendingReader,
  kfdb: ReviewPendingReader | null,
  limit: number,
  homeTimeoutMs = 900,
): Promise<unknown> {
  const kfdbPending = kfdb
    ? kfdb
      .reviewPending(limit)
      .then((value) => ({ ok: true as const, value }))
      .catch((error: unknown) => ({ ok: false as const, error }))
    : null;
  const pending = await readReviewPendingWithin(home, limit, homeTimeoutMs);
  if (pending.ok) {
    if (!kfdbPending) return pending.value;
    const fallback = await kfdbPending;
    if (fallback.ok) {
      if (queueItemCount(pending.value) > 0) {
        return mergeReviewPendingResults(fallback.value, pending.value, limit);
      }
      return {
        ...(fallback.value as Record<string, unknown>),
        home_review_pending_empty: true,
        home_counts: (pending.value as Record<string, unknown>)['counts'] ?? {},
      };
    }
    if (queueItemCount(pending.value) > 0) {
      return {
        ...(pending.value as Record<string, unknown>),
        kfdb_fallback_error: fallback.error instanceof Error ? fallback.error.message : String(fallback.error),
      };
    }
    return {
      ...(pending.value as Record<string, unknown>),
      kfdb_fallback_error: fallback.error instanceof Error ? fallback.error.message : String(fallback.error),
    };
  }
  if (kfdbPending) {
    const fallback = await kfdbPending;
    if (fallback.ok) {
      return {
        ...(fallback.value as Record<string, unknown>),
        ...fallbackReason(pending.error),
        ...(pending.timedOut ? { home_review_pending_timed_out: true } : {}),
      };
    }
  }
  throw pending.error;
}

const labelsSchema = z
  .array(z.string())
  .optional()
  .default(['WikiPage', 'OpenQuestion', 'HomeDecision', 'RoadmapItem'])
  .describe('Graph labels to search. Defaults to WikiPage, OpenQuestion, HomeDecision, RoadmapItem.');

export function shouldUseKfdbTraceFallback(trace: unknown): boolean {
  if (!trace || typeof trace !== 'object') return false;
  const value = trace as Record<string, unknown>;
  const nodes = Array.isArray(value['nodes']) ? value['nodes'] : null;
  const omissions = Array.isArray(value['omissions']) ? value['omissions'] as Array<Record<string, unknown>> : [];
  if (nodes && nodes.length > 0) return false;
  return omissions.some((omission) => {
    const reason = String(omission['reason'] ?? '');
    const detail = String(omission['detail'] ?? '');
    return /read-failed/i.test(reason) || /\b401\b|invalid api key/i.test(detail);
  });
}

export function shouldPreferKfdbTrace(kind: string, id: string): boolean {
  const traceKind = kind.trim().toLowerCase();
  const target = id.trim().toLowerCase();
  return ['wiki-claim', 'wikiclaim', 'knowledge-assertion', 'assertion'].includes(traceKind) || /^(evidence|roadmap):/.test(target);
}

export function withAssertionVoiceAnswer(kind: string, id: string, trace: unknown): unknown {
  const traceKind = kind.trim().toLowerCase();
  if (!['knowledge-assertion', 'assertion'].includes(traceKind) || !trace || typeof trace !== 'object') return trace;
  const value = trace as Record<string, unknown>;
  if (typeof value['answer'] === 'string' && value['answer'].trim()) return trace;
  const nodes = Array.isArray(value['nodes']) ? value['nodes'] as Array<Record<string, unknown>> : [];
  const assertionNode = nodes.find((node) => {
    const ref = node['ref'];
    return node['type'] === 'knowledge-assertion' || (ref && typeof ref === 'object' && (ref as Record<string, unknown>)['kind'] === 'knowledge-assertion');
  });
  const data = assertionNode?.['data'];
  if (!data || typeof data !== 'object') return trace;
  const fields = data as Record<string, unknown>;
  const comparator = String(fields['comparator'] ?? '').trim();
  const expectJson = String(fields['expectJson'] ?? '').trim();
  const anchorJson = String(fields['anchorJson'] ?? '').trim();
  const oracleJson = String(fields['oracleJson'] ?? '').trim();
  if (!comparator || !expectJson || !anchorJson || !oracleJson) return trace;
  const edges = Array.isArray(value['edges']) ? value['edges'] as Array<Record<string, unknown>> : [];
  const evaluated = edges.find((edge) => edge['relation'] === 'evaluated_by');
  const edgeData = evaluated?.['data'];
  const lintStatus = edgeData && typeof edgeData === 'object'
    ? String((edgeData as Record<string, unknown>)['status'] ?? '').trim()
    : '';
  const answer = `Assertion slug ${id}: comparator ${comparator}; expect ${expectJson}; anchor ${anchorJson}; oracle ${oracleJson}${lintStatus ? `; latest lint status ${lintStatus}` : ''}.`;
  return { ...value, answer };
}

export function registerTools(server: McpServer, deps: RegisterToolsDeps): void {
  const { home, kfdb, operatorTools = false } = deps;

  server.tool(
    'session_brief',
    'Tier-0 warm-start knowledge bundle. Call first in every voice session; includes verified-first wiki claims, open questions, reproducibility_hash, and S2D diagnostics.',
    {},
    async () => {
      try {
        return ok(
          await requireKfdb(kfdb).knowledgeBundle({
            token_budget: 2500,
            include_questions: true,
          }),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    'knowledge_bundle',
    'Voice-capped Tier-1 knowledge bundle. Summarize this result directly; never open engine tool-result files.',
    {
      query: z.string().describe('Focus query.'),
      token_budget: z.number().int().min(200).max(4000).optional().default(2500),
      page_limit: z.number().int().min(1).max(20).optional().default(15),
      claim_limit: z.number().int().min(1).max(40).optional().default(30),
    },
    async ({ query, token_budget, page_limit, claim_limit }) => {
      try {
        return ok(await requireKfdb(kfdb).knowledgeBundle({
          query,
          ...capKnowledgeBundleArgs({ token_budget, page_limit, claim_limit }),
          include_questions: true,
        }));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    'semantic_search',
    'Semantic HNSW search over private graph labels. Uses S2D when available.',
    {
      query: z.string().describe('Natural-language query.'),
      labels: labelsSchema,
      min_similarity: z.number().min(0).max(1).optional().default(0.45),
      limit: z.number().int().min(1).max(50).optional().default(8),
    },
    async ({ query, labels, min_similarity, limit }) => {
      try {
        return ok(await requireKfdb(kfdb).semanticSearch({ query, labels, minSimilarity: min_similarity, limit }));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    'wiki_search',
    'Hybrid rickydata_home wiki search; returns slugs, titles, summaries, and scores.',
    {
      query: z.string().describe('Search query.'),
      limit: z.number().int().min(1).max(20).optional().default(5),
    },
    async ({ query, limit }) => {
      try {
        return ok(await home.wikiSearch(query, limit));
      } catch (err) {
        if (kfdb) {
          try {
            return ok({ ...(await kfdb.wikiSearch(query, limit) as Record<string, unknown>), ...fallbackReason(err) });
          } catch {
            /* Preserve the original home failure; the fallback is best-effort for read availability. */
          }
        }
        return fail(err);
      }
    },
  );

  server.tool(
    'wiki_page',
    'Read one full wiki page with claims, verified claim ids, history, and backlinks.',
    { slug: z.string().describe('Wiki page slug.') },
    async ({ slug }) => {
      try {
        return ok(await home.wikiPage(slug));
      } catch (err) {
        if (kfdb) {
          try {
            return ok({ ...(await kfdb.wikiPage(slug) as Record<string, unknown>), ...fallbackReason(err) });
          } catch {
            /* Preserve the original home failure; the fallback is best-effort for read availability. */
          }
        }
        return fail(err);
      }
    },
  );

  server.tool(
    'context_pack',
    'Tier-2 compiled context pack. Cold compiles can take seconds; use for narrated deep dives, not fast per-turn retrieval.',
    {
      surface: z.string().optional().describe('Surface key. Exactly one of surface/task/repo is required.'),
      task: z.string().optional().describe('Roadmap task slug. Exactly one of surface/task/repo is required.'),
      repo: z.string().optional().describe('Repo id. Exactly one of surface/task/repo is required.'),
      budget: z.number().int().min(500).max(12000).optional().default(2000),
    },
    async ({ surface, task, repo, budget }) => {
      try {
        return ok(await home.contextPack({ surface, task, repo, budget }));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    'code_context',
    'KFDB code-evidence bundle for questions about how code works.',
    {
      task: z.string().describe('Code question or task.'),
      repo: z.string().optional().describe('Optional repo UUID, GitHub owner/name, or comma-separated list. Human names resolve against the KFDB imported-repository inventory; unavailable scopes return an honest diagnostic instead of broad results.'),
    },
    async ({ task, repo }) => {
      try {
        return ok(await requireKfdb(kfdb).codeContext({ task, repo }));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    'trace',
    'Read provenance trace receipts for a wiki page, claim, assertion, context pack, or HomeDecision. For exact source refs like evidence:* or roadmap:*, use kind wiki-claim and id equal to the source_ref.',
    {
      kind: z.string().describe('Trace kind, e.g. wiki-page, wiki-claim, assertion, context-pack, home-decision.'),
      id: z.string().describe('Trace subject id.'),
    },
    async ({ kind, id }) => {
      if (kfdb && shouldPreferKfdbTrace(kind, id)) {
        try {
          return ok(withAssertionVoiceAnswer(kind, id, await kfdb.trace(kind, id)));
        } catch (err) {
          try {
            return ok({ ...(await home.trace(kind, id) as Record<string, unknown>), kfdb_trace_error: err instanceof Error ? err.message : String(err) });
          } catch {
            return fail(err);
          }
        }
      }

      try {
        const homeTrace = withAssertionVoiceAnswer(kind, id, await home.trace(kind, id));
        if (kfdb && shouldUseKfdbTraceFallback(homeTrace)) {
          try {
            return ok({
              ...(await kfdb.trace(kind, id) as Record<string, unknown>),
              home_trace_confidence: (homeTrace as Record<string, unknown>)['confidence'],
              home_trace_omissions: (homeTrace as Record<string, unknown>)['omissions'],
            });
          } catch {
            /* Preserve the original home partial trace; the fallback is best-effort for read availability. */
          }
        }
        return ok(homeTrace);
      } catch (err) {
        if (kfdb) {
          try {
            return ok({ ...(await kfdb.trace(kind, id) as Record<string, unknown>), ...fallbackReason(err) });
          } catch {
            /* Preserve the original home failure; the fallback is best-effort for read availability. */
          }
        }
        return fail(err);
      }
    },
  );

  server.tool(
    'capture_open_question',
    'Capture a new voice-origin OpenQuestion atom via the memory-v1 write contract. Writes fail closed without S2D.',
    {
      question: z.string().describe('The concrete question to add to the backlog.'),
      why_it_matters: z.string().describe('Why answering this changes the outcome.'),
      category: z.string().describe('Canonical problem category or topic bucket.'),
    },
    async ({ question, why_it_matters, category }) => {
      try {
        const req = buildOpenQuestionCapture({ question, whyItMatters: why_it_matters, category });
        return ok({ nodeId: req.nodeId, sourceRef: req.sourceRef, write: await requireKfdb(kfdb).writeData(req) });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    'capture_idea',
    'Capture a voice-origin Discovery atom for the wiki compiler/HITL loop. Writes fail closed without S2D.',
    {
      idea: z.string().describe('The exact idea or lesson to capture.'),
      session_id: z.string().optional().describe('Voice session id, when available.'),
    },
    async ({ idea, session_id }) => {
      try {
        const req = buildDiscoveryCapture({ idea, sessionId: session_id });
        return ok({ nodeId: req.nodeId, write: await requireKfdb(kfdb).writeData(req) });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    'capture_decision',
    'Record an operator steer as a HomeDecision-compatible voice decision through the existing home HITL decision seam.',
    {
      decision: z.string().describe('The exact decision/steer to record.'),
      context: z.string().optional().describe('Short subject/context for the decision.'),
      session_id: z.string().optional().describe('Voice session id, when available.'),
    },
    async ({ decision, context, session_id }) => {
      try {
        return ok(await home.captureDecision({ decision, context, sessionId: session_id }));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    'next_questions',
    'Read the SPEC-021 ranked OpenQuestion feed with value breakdown and Mom-Test rewrite hints.',
    {
      topic: z.string().optional().describe('Optional topic filter.'),
      limit: z.number().int().min(1).max(10).optional().default(3),
    },
    async ({ topic, limit }) => {
      try {
        return ok(await resolveNextQuestions(home, kfdb, { topic, limit }));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    'record_answer',
    'Record the operator answer to an OpenQuestion through the existing Today-inbox answer flow.',
    {
      question_id: z.string().describe('OpenQuestion node id.'),
      answer: z.string().describe("The operator's confirmed answer."),
    },
    async ({ question_id, answer }) => {
      try {
        return ok(await home.recordAnswer(question_id, answer));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    'review_pending',
    'Spoken-friendly digest of the live HITL queue: counts and top pending items.',
    {
      limit: z.number().int().min(1).max(20).optional().default(5),
    },
    async ({ limit }) => {
      try {
        const pending = await resolveReviewPending(home, kfdb, limit);
        home.rememberQueueItems(queueItems(pending));
        return ok(pending);
      } catch (err) {
        return fail(err);
      }
    },
  );

  // Operator sessions may opt into the queue-drain surface. The voice partner
  // defaults to the exact 15-tool SPEC-026 contract.
  if (operatorTools) server.tool(
    'queue_census',
    'Full-depth HITL queue census: per-kind counts over the whole ranked queue (not a display page) plus a small sample, optionally filtered to one kind. Use before/after bulk operations to verify drains actually landed.',
    {
      limit: z.number().int().min(1).max(5000).optional().default(2000).describe('Underlying fetch depth — keep above the real queue size or the census undercounts (truncated=true flags this).'),
      kind: z.string().optional().describe("Optional kind filter for the sample, e.g. 'wiki_update', 'open_question', 'knowledge_lint'."),
      top: z.number().int().min(1).max(50).optional().default(10).describe('How many sample items to return.'),
    },
    async ({ limit, kind, top }) => {
      try {
        return ok(await home.queueCensus({ limit, kind, top }));
      } catch (err) {
        return fail(err);
      }
    },
  );

  if (operatorTools) server.tool(
    'bulk_decide',
    'Bulk park/reject up to 100 HITL queue items in one verified write (the cockpit bulk-triage route). Approve is intentionally unsupported in bulk — wiki diffs must resolve individually. Chunk and repeat for larger drains, re-running queue_census between chunks.',
    {
      item_ids: z.array(z.string()).min(1).max(100).describe('Live HITL item ids.'),
      action: z.enum(['park', 'reject']).describe('Bulk verdict.'),
    },
    async ({ item_ids, action }) => {
      try {
        return ok(await home.bulkDecide(item_ids, action));
      } catch (err) {
        return fail(err);
      }
    },
  );

  if (operatorTools) server.tool(
    'batch_approve_wiki_diffs',
    'Apply every pending LOW-RISK wiki diff through the same recordDecision+apply path the queue uses (contradictions are never batch-approved). Long-running: on client timeout the server KEEPS applying — poll queue_census (kind wiki_update) to zero instead of re-firing.',
    {},
    async () => {
      try {
        return ok(await home.batchApproveWikiDiffs());
      } catch (err) {
        return fail(err);
      }
    },
  );

  if (operatorTools) server.tool(
    'knowledge_lint',
    'Knowledge CI status: knownGood verdict + findings census (high-severity details included). knownGood=true is the gate the auto-apply lane and other consumers key on. With refresh=true the 16-check run recomputes (can take minutes; a client timeout means it continues server-side — re-read with refresh=false).',
    {
      refresh: z.boolean().optional().default(false).describe('Recompute the lint run instead of reading the latest stored one.'),
    },
    async ({ refresh }) => {
      try {
        return ok(await home.lintStatus(refresh));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    'resolve_item',
    'Resolve a pending HITL queue item by id after the agent has read it aloud and heard an explicit verdict.',
    {
      item_id: z.string().describe('Live HITL item id.'),
      verdict: z.enum(['approve', 'reject']).describe('Explicit operator verdict.'),
      note: z.string().optional().describe('Optional spoken rationale or contradiction ruling.'),
    },
    async ({ item_id, verdict, note }) => {
      try {
        return ok(await home.resolveItem(item_id, verdict, note));
      } catch (err) {
        return fail(err);
      }
    },
  );
}

export function capKnowledgeBundleArgs(args: {
  token_budget: number;
  page_limit: number;
  claim_limit: number;
}): { token_budget: number; page_limit: number; claim_limit: number } {
  return {
    token_budget: Math.min(args.token_budget, 4000),
    page_limit: Math.min(args.page_limit, 20),
    claim_limit: Math.min(args.claim_limit, 40),
  };
}
