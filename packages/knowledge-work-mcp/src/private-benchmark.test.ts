import { describe, expect, it, vi } from 'vitest';
import {
  PrivateBenchmarkClient,
  registerPrivateBenchmarkTools,
  type PrivateRuntimeEpoch,
} from './private-benchmark.js';

const runtime: PrivateRuntimeEpoch = {
  schema_version: 1,
  trial_id: 'trial-391',
  repo: 'rickycambrian/knowledgeflow_db',
  issue_number: 391,
  repository_head_sha: 'a'.repeat(40),
  epoch: {
    epoch_id: 'epoch-391',
    root_hash: 'b'.repeat(64),
    cutoff: '2026-07-23T12:00:00.000Z',
    policy_version: 'private-live-work/v1',
    claims: [{
      claim_id: 'claim-1',
      claim_text: 'Encrypted label search must remain bounded.',
      page_slug: 'encrypted-search',
      source_hash: 'c'.repeat(64),
      source_ref: 'github:knowledgeflow_db#391-prior-independent-source',
    }],
    pages: [{
      slug: 'encrypted-search',
      page_hash: 'd'.repeat(64),
      content_known_at: '2026-07-22T12:00:00.000Z',
      markdown: '# Encrypted search\n\nKeep candidate hydration bounded.',
    }],
  },
  code_index: {
    index_hash: 'e'.repeat(64),
    repository_head_sha: 'a'.repeat(40),
    entries: [{
      path: 'src/search.rs',
      symbol: 'search_private_label',
      snippet: 'hydrate only ANN candidates',
      source_hash: 'f'.repeat(64),
    }],
  },
};

describe('private benchmark epoch client', () => {
  it('uses only process-bound service authority and fails closed on an unavailable scope', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(runtime), { status: 200 }));
    const client = new PrivateBenchmarkClient({
      baseUrl: 'https://home.test',
      token: 'service-token',
      runtimeScopeId: 'scope-391',
      fetchImpl,
    });

    await expect(client.runtimeEpoch()).resolves.toEqual(runtime);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://home.test/internal/live-work/runtime-epoch',
      expect.objectContaining({
        headers: expect.objectContaining({
          'x-internal-live-work-runtime-token': 'service-token',
          'x-rickydata-runtime-scope-id': 'scope-391',
        }),
      }),
    );

    const broken = new PrivateBenchmarkClient({
      baseUrl: 'https://home.test',
      token: 'service-token',
      runtimeScopeId: 'missing',
      fetchImpl: vi.fn().mockResolvedValue(new Response('no', { status: 404 })),
    });
    await expect(broken.runtimeEpoch()).rejects.toThrow('private runtime epoch unavailable');
  });

  it('registers exactly four read-only tools without an epoch argument', () => {
    const registrations: Array<{ name: string; schema: Record<string, unknown> }> = [];
    const fakeServer = {
      tool: (name: string, _description: string, schema: Record<string, unknown>) => {
        registrations.push({ name, schema });
      },
    };

    registerPrivateBenchmarkTools(fakeServer as never, { runtimeEpoch: async () => runtime });

    expect(registrations.map(({ name }) => name)).toEqual([
      'session_brief',
      'wiki_search',
      'context_pack',
      'code_context',
    ]);
    expect(registrations.every(({ schema }) => !('epoch_id' in schema))).toBe(true);
  });
});
