import { describe, expect, it, vi } from 'vitest';
import { buildDiscoveryCapture, buildOpenQuestionCapture } from './atoms.js';
import { FailClosedError } from './errors.js';
import { HomeKnowledgeClient } from './home-client.js';
import { KfdbKnowledgeClient } from './kfdb-client.js';
import { deriveOpenQuestionId } from './ids.js';
import { shouldPreferKfdbTrace, shouldUseKfdbTraceFallback } from './tools.js';

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
});

describe('trace fallback detection', () => {
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
