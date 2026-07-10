import { describe, expect, it, vi } from 'vitest';
import { buildDiscoveryCapture, buildOpenQuestionCapture } from './atoms.js';
import { FailClosedError } from './errors.js';
import { HomeKnowledgeClient } from './home-client.js';
import { KfdbKnowledgeClient } from './kfdb-client.js';
import { deriveOpenQuestionId } from './ids.js';
import { resolveNextQuestions, resolveReviewPending, reviewPendingFallbackFromQuestions, shouldPreferKfdbTrace, shouldUseKfdbTraceFallback, withAssertionVoiceAnswer } from './tools.js';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, ...init, headers: { 'content-type': 'application/json' } });
}

describe('home auth fail-closed', () => {
  it('refuses home-backed tools before fetch when no signer is configured', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const home = new HomeKnowledgeClient({ baseUrl: 'https://home.test', signer: null, fetchImpl });

    await expect(home.wikiSearch('hitl')).rejects.toBeInstanceOf(FailClosedError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses home-backed tools before fetch when no S2D session provider is configured', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const home = new HomeKnowledgeClient({
      baseUrl: 'https://home.test',
      signer: { address: '0x1111111111111111111111111111111111111111', signMessage: async () => '0xsig' },
      mintToken: async () => 'scwt_test',
      s2d: null,
      fetchImpl,
    });

    await expect(home.wikiSearch('hitl')).rejects.toBeInstanceOf(FailClosedError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('adds S2D headers to home-backed requests', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ results: [] }));
    const home = new HomeKnowledgeClient({
      baseUrl: 'https://home.test',
      signer: { address: '0x1111111111111111111111111111111111111111', signMessage: async () => '0xsig' },
      mintToken: async () => 'scwt_test',
      s2d: {
        ensure: async () => ({ sessionId: 's2d-session', keyHex: 'a'.repeat(64), walletAddress: '0x1111111111111111111111111111111111111111' }),
      },
      fetchImpl,
    });

    await home.wikiSearch('hitl');
    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    expect(init.headers).toMatchObject({
      authorization: 'Bearer scwt_test',
      'x-derive-session-id': 's2d-session',
      'x-derive-key': 'a'.repeat(64),
    });
  });
});

describe('KFDB read/write auth split', () => {
  it('allows knowledge reads without S2D headers so KFDB can report honest diagnostics', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        pages: [],
        claims: [],
        open_questions: [],
        reproducibility_hash: 'hash',
        diagnostics: { s2d_active: false, undecrypted_skipped: 12 },
      }),
    );
    const kfdb = new KfdbKnowledgeClient({
      baseUrl: 'https://kfdb.test',
      apiKey: 'key',
      walletAddress: '0xb3e6',
      s2d: null,
      fetchImpl,
    });

    await expect(kfdb.knowledgeBundle({ token_budget: 2500 })).resolves.toMatchObject({
      diagnostics: { s2d_active: false, undecrypted_skipped: 12 },
    });
    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    expect(init.headers).toMatchObject({ authorization: 'Bearer key', 'x-wallet-address': '0xb3e6' });
    expect(init.headers).not.toHaveProperty('x-derive-session-id');
  });

  it('refuses capture writes before fetch when S2D is unavailable', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const kfdb = new KfdbKnowledgeClient({
      baseUrl: 'https://kfdb.test',
      apiKey: 'key',
      walletAddress: '0xb3e6',
      s2d: null,
      fetchImpl,
    });

    await expect(kfdb.writeData(buildDiscoveryCapture({ idea: 'Use voice for question triage.' }))).rejects.toBeInstanceOf(
      FailClosedError,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('adds S2D headers to capture writes when a session is available', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ operations_executed: 1, affected_ids: ['x'] }));
    const kfdb = new KfdbKnowledgeClient({
      baseUrl: 'https://kfdb.test',
      apiKey: 'key',
      walletAddress: '0xbad',
      s2d: {
        ensure: async () => ({ sessionId: 's2d-session', keyHex: 'abc123', walletAddress: '0xb3e6' }),
      },
      fetchImpl,
    });

    await kfdb.writeData(buildDiscoveryCapture({ idea: 'Use voice for question triage.' }));
    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    expect(init.headers).toMatchObject({
      authorization: 'Bearer key',
      'x-wallet-address': '0xb3e6',
      'x-derive-session-id': 's2d-session',
      'x-derive-key': 'abc123',
    });
  });

  it('maps direct KFDB knowledge bundle pages into wiki search hits', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        pages: [
          {
            slug: 'voice-guide',
            title: 'The VoiceGuide overlay',
            summary: 'Voice overlay facts.',
            kind: 'subsystem',
            score: 1,
            verified_claim_count: 2,
            claim_count: 3,
          },
        ],
        claims: [],
        diagnostics: { s2d_active: true, total_ms: 20 },
        reproducibility_hash: 'hash',
      }),
    );
    const kfdb = new KfdbKnowledgeClient({
      baseUrl: 'https://kfdb.test',
      apiKey: 'key',
      walletAddress: '0xb3e6',
      s2d: null,
      fetchImpl,
    });

    await expect(kfdb.wikiSearch('voice guide', 5)).resolves.toMatchObject({
      hits: [{ slug: 'voice-guide', source: 'kfdb_bundle', verifiedClaimCount: 2 }],
      fallback: { source: 'kfdb_agent_knowledge', reproducibility_hash: 'hash' },
    });
  });

  it('reads direct KFDB wiki page rows and overlays verified claim flags from the bundle', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const body = JSON.parse(String((init as RequestInit).body ?? '{}')) as { query?: string };
      if (body.query?.includes('WikiPage')) {
        return jsonResponse({
          data: [
            {
              _id: { String: 'wiki-page:voice-guide' },
              slug: { String: 'voice-guide' },
              kind: { String: 'subsystem' },
              title: { String: 'The VoiceGuide overlay' },
              summary: { String: 'Voice overlay facts.' },
              body_md: { String: '# VoiceGuide' },
              status: { String: 'active' },
              source_count: { Integer: 3 },
              last_compiled_at: { String: '2026-07-08T12:00:00.000Z' },
              compiler_version: { String: 'test' },
              rickydata_wiki_schema_version: { String: 'v1' },
            },
          ],
        });
      }
      if (body.query?.includes('WikiClaim')) {
        return jsonResponse({
          data: [
            {
              _id: { String: 'claim:voice-guide:1' },
              page_slug: { String: 'voice-guide' },
              text: { String: 'VoiceGuide uses home companion events.' },
              confidence_tier: { String: 'EXTRACTED' },
              confidence_score: { Float: 1 },
              status: { String: 'active' },
              source_ref: { String: 'wiki-page:voice-guide' },
              updated_at: { String: '2026-07-08T12:00:00.000Z' },
              rickydata_wiki_schema_version: { String: 'v1' },
            },
          ],
        });
      }
      return jsonResponse({
        pages: [],
        claims: [{ id: 'claim:voice-guide:1', page_slug: 'voice-guide', verified: true }],
        diagnostics: { s2d_active: true },
        reproducibility_hash: 'hash',
      });
    });
    const kfdb = new KfdbKnowledgeClient({
      baseUrl: 'https://kfdb.test',
      apiKey: 'key',
      walletAddress: '0xb3e6',
      s2d: null,
      fetchImpl,
    });

    await expect(kfdb.wikiPage('voice-guide')).resolves.toMatchObject({
      page: { slug: 'voice-guide', body_md: '# VoiceGuide' },
      claims: [{ id: 'claim:voice-guide:1', verified: true }],
      verifiedClaimIds: ['claim:voice-guide:1'],
      fallback: { source: 'kfdb_query', reproducibility_hash: 'hash' },
    });
  });

  it('traces WikiClaim rows by source_ref and returns the exact verified claim', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const body = JSON.parse(String((init as RequestInit).body ?? '{}')) as { query?: string; query_text?: string };
      if (body.query?.includes('WikiPage')) {
        return jsonResponse({
          data: [
            {
              _id: { String: 'wiki-page:agentic-knowledge-compiler' },
              slug: { String: 'agentic-knowledge-compiler' },
              kind: { String: 'program' },
              title: { String: 'The Agentic Knowledge Compiler' },
              summary: { String: 'AKC facts.' },
              body_md: { String: '# AKC' },
              status: { String: 'active' },
              source_count: { Integer: 3 },
              last_compiled_at: { String: '2026-07-08T12:00:00.000Z' },
              compiler_version: { String: 'test' },
              rickydata_wiki_schema_version: { String: 'v1' },
            },
          ],
        });
      }
      if (body.query?.includes('WikiClaim')) {
        return jsonResponse({
          data: [
            {
              _id: { String: 'claim:wrong' },
              page_slug: { String: 'agentic-knowledge-compiler' },
              text: { String: 'Nearby but wrong claim.' },
              confidence_tier: { String: 'EXTRACTED' },
              confidence_score: { Float: 1 },
              status: { String: 'active' },
              source_ref: { String: 'roadmap:other' },
              updated_at: { String: '2026-07-08T12:00:00.000Z' },
              rickydata_wiki_schema_version: { String: 'v1' },
            },
            {
              _id: { String: 'claim:target' },
              page_slug: { String: 'agentic-knowledge-compiler' },
              text: { String: 'Phase 10 passed build gate in 1.93s.' },
              confidence_tier: { String: 'EXTRACTED' },
              confidence_score: { Float: 1 },
              status: { String: 'active' },
              source_ref: { String: 'evidence:akc-p10-code-integration:build:50cb7f' },
              updated_at: { String: '2026-07-08T12:00:00.000Z' },
              rickydata_wiki_schema_version: { String: 'v1' },
            },
          ],
        });
      }
      return jsonResponse({
        pages: [],
        claims: [{ id: 'claim:target', page_slug: 'agentic-knowledge-compiler', verified: true }],
        diagnostics: { s2d_active: true },
        reproducibility_hash: 'hash',
      });
    });
    const kfdb = new KfdbKnowledgeClient({
      baseUrl: 'https://kfdb.test',
      apiKey: 'key',
      walletAddress: '0xb3e6',
      s2d: null,
      fetchImpl,
    });

    await expect(kfdb.trace('wiki-claim', 'evidence:akc-p10-code-integration:build:50cb7f')).resolves.toMatchObject({
      answer: 'Phase 10 passed build gate in one point nine three seconds. (page agentic-knowledge-compiler; claim claim:target; verified).',
      rawAnswer: 'Phase 10 passed build gate in 1.93s. (page agentic-knowledge-compiler; claim claim:target; verified).',
      claimText: 'Phase 10 passed build gate in 1.93s.',
      spokenClaimText: 'Phase 10 passed build gate in one point nine three seconds.',
      claimId: 'claim:target',
      pageSlug: 'agentic-knowledge-compiler',
      kind: 'wiki-claim',
      id: 'claim:target',
      sourceRef: 'evidence:akc-p10-code-integration:build:50cb7f',
      verified: true,
      citation: { pageSlug: 'agentic-knowledge-compiler', claimId: 'claim:target', verified: true },
      page: { slug: 'agentic-knowledge-compiler', title: 'The Agentic Knowledge Compiler' },
      fallback: { source: 'kfdb_trace' },
    });
    const trace = await kfdb.trace('wiki-claim', 'evidence:akc-p10-code-integration:build:50cb7f') as {
      page?: Record<string, unknown>;
    };
    expect(trace.page).not.toHaveProperty('bodyMd');
    expect(trace.page).not.toHaveProperty('body_md');
  });

  it('traces knowledge assertions directly from the KFDB assertion projection', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      const body = JSON.parse(String((init as RequestInit).body ?? '{}')) as Record<string, unknown>;
      if (String(url).endsWith('/api/v1/query') && String(body['query']).includes('RickydataKnowledgeAssertion')) {
        return jsonResponse({ data: [{
          slug: 'zero-schema-law',
          title: 'Zero schema law',
          origin: 'repo',
          status: 'active',
          severity: 'hard',
          comparator: 'atLeast',
          expect_json: '{"n":1}',
          anchor_json: '{"kind":"page","key":"dev-tycoon"}',
          oracle_json: '{"kind":"wiki-query","claimTextRegex":"does not add schema"}',
          source_sha256: 'abc',
          created_by: 'repo:test',
          updated_at: '2026-07-10T00:00:00.000Z',
          rationale: 'Keep the invariant visible.',
        }] });
      }
      return jsonResponse({}, { status: 404 });
    });
    const kfdb = new KfdbKnowledgeClient({
      baseUrl: 'https://kfdb.test',
      apiKey: 'key',
      walletAddress: '0xb3e6',
      s2d: null,
      fetchImpl,
    });

    await expect(kfdb.trace('knowledge-assertion', 'zero-schema-law')).resolves.toMatchObject({
      subject: { kind: 'knowledge-assertion', id: 'zero-schema-law' },
      confidence: 'recorded',
      nodes: [{
        type: 'knowledge-assertion',
        data: {
          comparator: 'atLeast',
          expectJson: '{"n":1}',
          anchorJson: '{"kind":"page","key":"dev-tycoon"}',
          oracleJson: '{"kind":"wiki-query","claimTextRegex":"does not add schema"}',
        },
      }],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('ranks the fast KFDB knowledge-bundle OpenQuestion projection for next_questions', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      const body = JSON.parse(String((init as RequestInit).body ?? '{}')) as Record<string, unknown>;
      if (String(url).endsWith('/api/v1/agent/knowledge')) {
        expect(body).toMatchObject({
          page_limit: 1,
          claim_limit: 1,
          include_questions: true,
        });
        return jsonResponse({
          open_questions: [
            {
              id: 'oq-live',
              question: 'Which voice-relay commit last streamed from the Core2 device?',
              question_kind: 'question',
              why_it_matters: 'Blocks the device proof.',
              category: 'voice',
              source_ref: 'voice-proof:t4',
              created_at: '2026-01-01T00:00:00.000Z',
              priority: 7,
              status: 'open',
            },
            {
              id: 'oq-answered',
              question: 'Which stale question is already answered?',
              answer: 'Already answered.',
              status: 'answered',
            },
          ],
          diagnostics: { scanned_questions: 2, pruned_questions: 0 },
          reproducibility_hash: 'questions-hash',
        });
      }
      return jsonResponse({}, { status: 404 });
    });
    const kfdb = new KfdbKnowledgeClient({
      baseUrl: 'https://kfdb.test',
      apiKey: 'key',
      walletAddress: '0xb3e6',
      s2d: null,
      fetchImpl,
    });

    await expect(kfdb.nextQuestions({ limit: 3 })).resolves.toMatchObject({
      ranked: [
        {
          id: 'oq-live',
          question: 'Which voice-relay commit last streamed from the Core2 device?',
          questionKind: 'question',
          value: 0.1,
          components: { blocking: 0.2, gap: 0.5, freshness: 1, answerability: 1 },
          answerability: { phrasing: 'specific', rewriteHint: null },
          blockingRefs: [],
          whyItMatters: 'Blocks the device proof.',
          category: 'voice',
          sourceRef: 'voice-proof:t4',
        },
      ],
      total_ranked: 1,
      fallback: { source: 'kfdb_agent_knowledge', total_open: 1 },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('projects pending WikiDiffs ahead of OpenQuestions for review_pending', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      if (String(url).endsWith('/api/v1/query')) {
        return jsonResponse({
          data: [{
            _id: 'run-node-1',
            run_id: 'run-1',
            started_at: '2026-07-10T05:38:24.390Z',
            diffs_json: JSON.stringify([{
              kind: 'wiki_update',
              status: 'pending',
              diff: {
                pageSlug: 'rickydata-main-branch-policy',
                op: 'create',
                title: 'rickydata Main-Branch Policy',
                rationale: 'The operator answered the branch-policy question.',
              },
            }]),
          }],
        });
      }
      if (String(url).endsWith('/api/v1/agent/knowledge')) {
        return jsonResponse({
          open_questions: [{
            id: 'oq-core2',
            question: 'Has the physical Core2 streaming proof passed?',
            status: 'open',
          }],
        });
      }
      return jsonResponse({}, { status: 404 });
    });
    const kfdb = new KfdbKnowledgeClient({
      baseUrl: 'https://kfdb.test',
      apiKey: 'key',
      walletAddress: '0xb3e6',
      s2d: null,
      fetchImpl,
    });

    await expect(kfdb.reviewPending(3)).resolves.toMatchObject({
      counts: { wiki_update: 1, open_question: 1 },
      items: [
        {
          id: 'wiki-update:rickydata-main-branch-policy:run-1',
          kind: 'wiki_update',
          title: 'Wiki create: rickydata Main-Branch Policy',
          sourceRef: { label: 'RickydataWikiCompilerRun', nodeId: 'run-node-1', scope: 'private' },
        },
        {
          id: 'oq-core2',
          kind: 'open_question',
          title: 'Has the physical Core2 streaming proof passed?',
        },
      ],
      fallback: { source: 'kfdb_pending_projection' },
    });
  });

  it('returns a nonempty topic-scoped KFDB projection without waiting for Home', async () => {
    const home = {
      nextQuestions: vi.fn(async () => {
        throw new Error('topic-scoped fast path should not call Home');
      }),
    };
    const kfdb = {
      nextQuestions: vi.fn(async () => ({
        ranked: [{ id: 'core2' }],
        total_ranked: 1,
      })),
    };

    await expect(
      resolveNextQuestions(home, kfdb, { topic: 'Core2', limit: 3 }),
    ).resolves.toMatchObject({
      ranked: [{ id: 'core2' }],
      topic_scoped_fast_path: true,
    });
    expect(home.nextQuestions).not.toHaveBeenCalled();
    expect(kfdb.nextQuestions).toHaveBeenCalledWith({ topic: 'Core2', limit: 3 });
  });

  it('maps KFDB OpenQuestions into a spoken review_pending fallback digest', () => {
    expect(
      reviewPendingFallbackFromQuestions(
        {
          ranked: [
            {
              id: 'oq-live',
              question: 'Which voice-relay commit last streamed from the Core2 device?',
              whyItMatters: 'Blocks the device proof.',
            },
            {
              id: 'oq-second',
              question: 'Which pending item should stay second?',
            },
          ],
          total_ranked: 12,
        },
        1,
      ),
    ).toMatchObject({
      counts: { open_question: 1 },
      items: [
        {
          id: 'oq-live',
          kind: 'open_question',
          title: 'Which voice-relay commit last streamed from the Core2 device?',
          reason: 'Blocks the device proof.',
          sourceRef: { label: 'OpenQuestion', nodeId: 'oq-live', scope: 'private' },
        },
      ],
      fallback: { source: 'kfdb_open_questions', total_open: 12 },
    });
  });

  it('returns the KFDB review digest when Home exceeds the voice budget', async () => {
    const home = {
      reviewPending: vi.fn(() => new Promise<unknown>(() => {})),
    };
    const kfdb = {
      reviewPending: vi.fn(async () => ({
        items: [{ id: 'core2', kind: 'open_question', title: 'Has the physical Core2 streaming proof passed?' }],
        counts: { open_question: 1 },
        fallback: { source: 'kfdb_pending_projection' },
      })),
    };

    await expect(resolveReviewPending(home, kfdb, 5, 0)).resolves.toMatchObject({
      items: [{ id: 'core2', title: 'Has the physical Core2 streaming proof passed?' }],
      home_review_pending_timed_out: true,
      fallback: { source: 'kfdb_pending_projection' },
    });
    expect(home.reviewPending).toHaveBeenCalledWith(5);
    expect(kfdb.reviewPending).toHaveBeenCalledWith(5);
  });

  it('merges fresh KFDB pending diffs ahead of a nonempty Home queue', async () => {
    const home = {
      reviewPending: vi.fn(async () => ({
        items: [{ id: 'issue-1', kind: 'issue', title: 'Review issue one' }],
        counts: { issue: 1 },
      })),
    };
    const kfdb = {
      reviewPending: vi.fn(async () => ({
        items: [{ id: 'wiki-update:policy:run-1', kind: 'wiki_update', title: 'Wiki create: Policy' }],
        counts: { wiki_update: 1 },
        fallback: { source: 'kfdb_pending_projection' },
      })),
    };

    await expect(resolveReviewPending(home, kfdb, 5)).resolves.toMatchObject({
      items: [
        { id: 'wiki-update:policy:run-1' },
        { id: 'issue-1' },
      ],
      counts: { wiki_update: 1, issue: 1 },
      home_counts: { issue: 1 },
      merged_pending_sources: true,
    });
  });
});

describe('trace fallback detection', () => {
  it('adds a canonical exact answer to knowledge-assertion traces', () => {
    expect(withAssertionVoiceAnswer('knowledge-assertion', 'zero-schema-law', {
      nodes: [{
        type: 'knowledge-assertion',
        data: {
          comparator: 'atLeast',
          expectJson: '{"n":1}',
          anchorJson: '{"kind":"page","key":"dev-tycoon"}',
          oracleJson: '{"kind":"wiki-query","claimTextRegex":"does not add schema"}',
        },
      }],
      edges: [{ relation: 'evaluated_by', data: { status: 'pass' } }],
    })).toMatchObject({
      answer: 'Assertion slug zero-schema-law: comparator atLeast; expect {"n":1}; anchor {"kind":"page","key":"dev-tycoon"}; oracle {"kind":"wiki-query","claimTextRegex":"does not add schema"}; latest lint status pass.',
    });
  });

  it('falls back when home trace returns a partial read-failed omission with no nodes', () => {
    expect(shouldUseKfdbTraceFallback({
      confidence: 'partial',
      nodes: [],
      omissions: [{ reason: 'wiki-claim-read-failed', detail: 'Failed to query KQL: 401 Invalid API key' }],
    })).toBe(true);
  });

  it('keeps complete home traces even when stale omissions exist', () => {
    expect(shouldUseKfdbTraceFallback({
      confidence: 'high',
      nodes: [{ id: 'claim:1' }],
      omissions: [{ reason: 'old-warning', detail: '401 Invalid API key' }],
    })).toBe(false);
  });

  it('prefers KFDB for exact wiki-claim and source-ref traces', () => {
    expect(shouldPreferKfdbTrace('wiki-claim', 'claim-id')).toBe(true);
    expect(shouldPreferKfdbTrace('knowledge-assertion', 'zero-schema-law')).toBe(true);
    expect(shouldPreferKfdbTrace('anything', 'evidence:akc:build:abc')).toBe(true);
    expect(shouldPreferKfdbTrace('anything', 'roadmap:akc-p10')).toBe(true);
    expect(shouldPreferKfdbTrace('wiki-page', 'agentic-knowledge-compiler')).toBe(false);
  });
});

describe('compiler-safe capture atoms', () => {
  it('derives memory-v1 OpenQuestion ids from source_ref + question and writes no wiki labels', () => {
    const a = buildOpenQuestionCapture({
      question: 'Which Core2 relay URL actually streamed last time?',
      whyItMatters: 'Blocks device bring-up proof.',
      category: 'environment',
      now: '2026-07-08T12:00:00.000Z',
    });
    const b = buildOpenQuestionCapture({
      question: 'Which Core2 relay URL actually streamed last time?',
      whyItMatters: 'Blocks device bring-up proof.',
      category: 'environment',
      now: '2026-07-08T12:00:00.000Z',
    });
    const c = buildOpenQuestionCapture({
      question: 'Which Cartesia voice UUID worked last time?',
      whyItMatters: 'Blocks marketplace audio.',
      category: 'environment',
      now: '2026-07-08T12:00:00.000Z',
    });

    expect(a.nodeId).toBe(b.nodeId);
    expect(a.nodeId).not.toBe(c.nodeId);
    const firstProps = (a.operations[0] as { properties: { question: { String: string } } }).properties;
    expect(a.nodeId).toBe(deriveOpenQuestionId('voice-open-question:environment', firstProps.question.String));
    expect(a.operations.map((op) => op['label'])).toEqual(['OpenQuestion']);
    expect(a.operations.map((op) => op['label'])).not.toContain('WikiPage');
    expect(a.operations.map((op) => op['label'])).not.toContain('WikiClaim');
  });

  it('captures ideas as Discovery atoms with voice provenance', () => {
    const req = buildDiscoveryCapture({
      idea: 'Ask only one ranked open question at a time.',
      sessionId: 'voice-session-1',
      now: '2026-07-08T12:00:00.000Z',
    });
    const op = req.operations[0]!;

    expect(op['label']).toBe('Discovery');
    expect(op['properties']).toMatchObject({
      finding: { String: 'Ask only one ranked open question at a time.' },
      source: { String: 'voice' },
      origin: { String: 'voice' },
      session_id: { String: 'voice-session-1' },
    });
  });
});

describe('operator lane', () => {
  function authedHome(fetchImpl: typeof fetch): HomeKnowledgeClient {
    return new HomeKnowledgeClient({
      baseUrl: 'https://home.test',
      signer: { address: '0x1111111111111111111111111111111111111111', signMessage: async () => '0xsig' },
      mintToken: async () => 'scwt_test',
      s2d: {
        ensure: async () => ({ sessionId: 's2d-session', keyHex: 'a'.repeat(64), walletAddress: '0x1111111111111111111111111111111111111111' }),
      },
      fetchImpl,
    });
  }

  function timeoutError(): TypeError {
    const err = new TypeError('fetch failed');
    (err as { cause?: { code: string } }).cause = { code: 'UND_ERR_HEADERS_TIMEOUT' };
    return err;
  }

  it('queue_census counts the whole fetch, filters the sample, and flags truncation', async () => {
    const items = [
      { id: 'a', kind: 'wiki_update', title: 'A', sourceRef: { label: 'X', scope: 'private' } },
      { id: 'b', kind: 'open_question', title: 'B', sourceRef: { label: 'X', scope: 'private' } },
      { id: 'c', kind: 'open_question', title: 'C', sourceRef: { label: 'X', scope: 'private' } },
    ];
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ items }));
    const census = (await authedHome(fetchImpl).queueCensus({ limit: 3, kind: 'open_question', top: 1 })) as Record<string, unknown>;

    expect(String(fetchImpl.mock.calls[0]![0])).toContain('/api/hitl/queue?limit=3');
    expect(census['total']).toBe(3);
    expect(census['truncated']).toBe(true); // items.length === limit → the census may undercount
    expect(census['counts']).toEqual({ wiki_update: 1, open_question: 2 });
    expect((census['sample'] as unknown[]).length).toBe(1);
    expect((census['sample'] as Array<{ kind: string }>)[0]!.kind).toBe('open_question');
  });

  it('resolve_item reuses a recently read queue item instead of rebuilding the live queue', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ decision: { verified: true } }));
    const home = authedHome(fetchImpl);
    home.rememberQueueItems([{
      id: 'wiki-update:policy:run-1',
      kind: 'wiki_update',
      title: 'Wiki update: Policy',
      sourceRef: { label: 'RickydataWikiCompilerRun', nodeId: 'run-1', scope: 'private' },
    }]);

    await home.resolveItem('wiki-update:policy:run-1', 'approve', 'Operator approved.');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]![0])).toBe('https://home.test/api/hitl/decision');
    expect(JSON.parse(String((fetchImpl.mock.calls[0]![1] as RequestInit).body))).toEqual({
      item: {
        id: 'wiki-update:policy:run-1',
        kind: 'wiki_update',
        title: 'Wiki update: Policy',
        sourceRef: { label: 'RickydataWikiCompilerRun', nodeId: 'run-1', scope: 'private' },
      },
      action: 'approve',
      answer: 'Operator approved.',
      confidence: 1,
    });
  });

  it('bulk_decide enforces the 100-id chunk cap before any network egress', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const home = authedHome(fetchImpl);
    await expect(home.bulkDecide(Array.from({ length: 101 }, (_, i) => `id-${i}`), 'reject')).rejects.toThrow(/100 ids/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('batch-approve converts a client timeout into started:true (server keeps applying)', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(timeoutError());
    const result = (await authedHome(fetchImpl).batchApproveWikiDiffs()) as Record<string, unknown>;
    expect(result['started']).toBe(true);
    expect(result['client_timeout']).toBe(true);
  });

  it('lint refresh converts a client timeout into refresh_started:true, but a plain read rethrows', async () => {
    const timeoutFetch = vi.fn<typeof fetch>().mockRejectedValue(timeoutError());
    const refreshed = (await authedHome(timeoutFetch).lintStatus(true)) as Record<string, unknown>;
    expect(refreshed['refresh_started']).toBe(true);

    await expect(authedHome(timeoutFetch).lintStatus(false)).rejects.toThrow('fetch failed');
  });

  it('lint status summarizes findings and surfaces only high-severity details', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        run: { id: 'run-1', knownGood: true, startedAt: '2026-07-09T00:00:00Z' },
        findings: [
          { check: 'stale_claims', severity: 'med', subjectRef: 'wiki-page:x', detail: 'old' },
          { check: 'shipped_without_evidence', severity: 'high', subjectRef: 'roadmap-item:y', detail: 'no commit satisfies' },
        ],
      }),
    );
    const status = (await authedHome(fetchImpl).lintStatus(false)) as Record<string, unknown>;
    expect(status['knownGood']).toBe(true);
    expect(status['findings_total']).toBe(2);
    expect(status['findings_by_check']).toEqual({ stale_claims: 1, shipped_without_evidence: 1 });
    expect(status['high_findings']).toEqual([
      { check: 'shipped_without_evidence', subjectRef: 'roadmap-item:y', detail: 'no commit satisfies' },
    ]);
  });
});
