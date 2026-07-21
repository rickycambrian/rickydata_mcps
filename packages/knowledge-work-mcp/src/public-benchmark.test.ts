import { describe, expect, it, vi } from 'vitest';
import {
  EpochBenchClient,
  buildPublicContextPack,
  registerPublicBenchmarkTools,
  searchEpochClaims,
} from './public-benchmark.js';

const runtime = {
  schema_version: 1,
  case_id: 'case-1',
  repo: 'Textualize/rich',
  issue_number: 4000,
  repository_head_sha: 'a'.repeat(40),
  epoch: {
    epoch_id: 'epoch-1', root_hash: 'b'.repeat(64), cutoff: '2026-07-21T12:00:00.000Z',
    policy_version: 'epoch-frozen-knowledge/v1',
    claims: [
      { claim_id: 'a', claim_text: 'ANSI decoding preserves trailing newlines', page_slug: 'text-decoding', source_hash: 'c'.repeat(64), source_ref: 'github:a', verification_sources: [{ source_hash: 'e'.repeat(64) }] },
      { claim_id: 'b', claim_text: 'Console rendering uses terminal width', page_slug: 'console', source_hash: 'd'.repeat(64), source_ref: 'github:b' },
    ],
  },
};

describe('public benchmark epoch client', () => {
  it('authenticates with the process-bound runtime scope and fails closed on HTTP errors', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(runtime), { status: 200 }));
    const client = new EpochBenchClient({ baseUrl: 'https://bench.test', token: 'read-token', runtimeScopeId: 'scope-1', fetchImpl });
    await expect(client.runtimeEpoch()).resolves.toEqual(runtime);
    expect(fetchImpl).toHaveBeenCalledWith('https://bench.test/api/internal/benchmarks/prospective/runtime-epoch', expect.objectContaining({
      headers: expect.objectContaining({
        'x-internal-epoch-runtime-token': 'read-token',
        'x-rickydata-runtime-scope-id': 'scope-1',
      }),
    }));
    const broken = new EpochBenchClient({
      baseUrl: 'https://bench.test', token: 'read-token', runtimeScopeId: 'scope-2',
      fetchImpl: vi.fn().mockResolvedValue(new Response('no', { status: 404 })),
    });
    await expect(broken.runtimeEpoch()).rejects.toThrow('runtime epoch unavailable');
  });

  it('searches only frozen claims and returns content-addressed pack receipts', () => {
    expect(searchEpochClaims(runtime.epoch.claims, 'trailing newline', 5).map((claim) => claim.claim_id)).toEqual(['a']);
    const pack = buildPublicContextPack(runtime, { query: 'trailing newline', tokenBudget: 500 });
    expect(pack.case_id).toBe('case-1');
    expect(pack.epoch_hash).toBe(runtime.epoch.root_hash);
    expect(pack.selected_source_hashes).toEqual(['c'.repeat(64), 'e'.repeat(64)]);
    expect(pack.text).toContain('trailing newlines');
  });

  it('registers exactly the four read-only epoch-bound tools', () => {
    const names: string[] = [];
    const fakeServer = { tool: (name: string) => { names.push(name); } };
    registerPublicBenchmarkTools(fakeServer as never, { runtimeEpoch: async () => runtime });
    expect(names).toEqual(['session_brief', 'wiki_search', 'context_pack', 'code_context']);
  });
});
