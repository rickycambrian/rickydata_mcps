import { describe, expect, it, vi } from 'vitest';
import { buildDiscoveryCapture, buildOpenQuestionCapture } from './atoms.js';
import { FailClosedError } from './errors.js';
import { HomeKnowledgeClient } from './home-client.js';
import { KfdbKnowledgeClient } from './kfdb-client.js';
import { deriveOpenQuestionId } from './ids.js';

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
