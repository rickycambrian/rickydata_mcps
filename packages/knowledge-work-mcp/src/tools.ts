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
}

function requireKfdb(client: KfdbKnowledgeClient | null): KfdbKnowledgeClient {
  if (!client) {
    throw new FailClosedError('KFDB_API_URL and KFDB_API_KEY are required for knowledge-work-mcp KFDB-backed tools.');
  }
  return client;
}

const labelsSchema = z
  .array(z.string())
  .optional()
  .default(['WikiPage', 'OpenQuestion', 'HomeDecision', 'RoadmapItem'])
  .describe('Graph labels to search. Defaults to WikiPage, OpenQuestion, HomeDecision, RoadmapItem.');

export function registerTools(server: McpServer, deps: RegisterToolsDeps): void {
  const { home, kfdb } = deps;

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
    'Query-focused Tier-1 compiled knowledge bundle from KFDB private wiki.',
    {
      query: z.string().describe('Focus query.'),
      token_budget: z.number().int().min(200).max(32000).optional().default(2500),
      page_limit: z.number().int().min(1).max(200).optional().default(40),
      claim_limit: z.number().int().min(1).max(500).optional().default(120),
    },
    async ({ query, token_budget, page_limit, claim_limit }) => {
      try {
        return ok(await requireKfdb(kfdb).knowledgeBundle({ query, token_budget, page_limit, claim_limit, include_questions: true }));
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
      repo: z.string().optional().describe('Optional repo UUID/scope accepted by KFDB get_context_bundle.'),
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
    'Read provenance trace receipts for a wiki page, claim, assertion, context pack, or HomeDecision.',
    {
      kind: z.string().describe('Trace kind, e.g. wiki-page, wiki-claim, assertion, context-pack, home-decision.'),
      id: z.string().describe('Trace subject id.'),
    },
    async ({ kind, id }) => {
      try {
        return ok(await home.trace(kind, id));
      } catch (err) {
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
        return ok(await home.nextQuestions({ topic, limit }));
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
        return ok(await home.reviewPending(limit));
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
