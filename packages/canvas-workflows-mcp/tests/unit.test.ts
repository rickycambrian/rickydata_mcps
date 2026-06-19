import { describe, expect, it } from 'vitest';
import {
  HomeCanvasClient,
  FailClosedError,
  HomeApiError,
  summarizeRun,
  readSseEvents,
  type CanvasRunEvent,
} from '../src/home-client.js';
import { buildAuthMessage, mintWalletToken, createWalletSigner, loadSignerFromEnv } from '../src/wallet-token.js';
import { TOOL_NAMES } from '../src/tools.js';

// A throwaway, well-known test key (NOT a real wallet) so signatures are deterministic-ish.
const TEST_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const signer = createWalletSigner(TEST_KEY);

interface CapturedReq {
  url: string;
  method?: string;
  headers: Record<string, string>;
  body?: string;
}

function captureFetch(response: () => Response): { fetch: typeof fetch; calls: CapturedReq[] } {
  const calls: CapturedReq[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    const h = init?.headers as Record<string, string> | undefined;
    if (h) for (const [k, v] of Object.entries(h)) headers[k.toLowerCase()] = v;
    calls.push({ url: String(url), method: init?.method, headers, body: init?.body as string | undefined });
    return response();
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, calls };
}

// Stub minter so we assert the bearer wiring without doing real ECDSA in every test.
const stubMint = async () => 'scwt_TESTTOKEN';

function client(opts: { signer?: typeof signer | null; fetch: typeof fetch }) {
  return new HomeCanvasClient({
    baseUrl: 'http://home.test/',
    signer: opts.signer === undefined ? signer : opts.signer,
    fetchImpl: opts.fetch,
    mintToken: stubMint,
  });
}

describe('tool surface', () => {
  it('exposes exactly the seven documented tools with unique names', () => {
    expect(TOOL_NAMES).toHaveLength(7);
    expect(new Set(TOOL_NAMES).size).toBe(TOOL_NAMES.length);
    expect([...TOOL_NAMES]).toEqual([
      'list_workflows',
      'get_workflow',
      'save_workflow',
      'run_workflow',
      'resolve_approval',
      'get_run',
      'list_runs',
    ]);
  });
});

describe('wallet token (byte-compatible with rickydata_home)', () => {
  it('builds the canonical auth message in home\'s exact field order, lowercased', () => {
    const msg = buildAuthMessage({ address: '0xAbC', issuedAt: 100, expiresAt: 200 });
    expect(msg).toBe('rickydata-home wallet auth\naddress: 0xabc\nissuedAt: 100\nexpiresAt: 200');
  });

  it('mints a verifiable scwt_ token whose embedded address matches the signer', async () => {
    const token = await mintWalletToken({ address: signer.address, signFn: signer.signMessage, issuedAt: 1000 });
    expect(token.startsWith('scwt_')).toBe(true);
    const payload = JSON.parse(Buffer.from(token.slice('scwt_'.length), 'base64url').toString('utf8'));
    expect(payload.address).toBe(signer.address);
    expect(payload.issuedAt).toBe(1000);
    expect(payload.expiresAt).toBe(1000 + 24 * 60 * 60);
    expect(typeof payload.signature).toBe('string');
  });

  it('loadSignerFromEnv returns null with no key (fail-closed signal) and a signer with one', () => {
    expect(loadSignerFromEnv({})).toBeNull();
    expect(loadSignerFromEnv({ CANVAS_MCP_PRIVATE_KEY: TEST_KEY })?.address).toBe(signer.address);
  });
});

describe('fail closed: no wallet context', () => {
  it('every read/write throws FailClosedError BEFORE any network egress', async () => {
    const { fetch, calls } = captureFetch(() => new Response('{}', { status: 200 }));
    const c = client({ signer: null, fetch });
    await expect(c.listWorkflows()).rejects.toBeInstanceOf(FailClosedError);
    await expect(c.getWorkflow('w1')).rejects.toBeInstanceOf(FailClosedError);
    await expect(c.saveWorkflow({ name: 'x', nodes: [], connections: [] })).rejects.toBeInstanceOf(FailClosedError);
    await expect(c.runWorkflow({ workflowId: 'w1' })).rejects.toBeInstanceOf(FailClosedError);
    await expect(c.resolveApproval('r1', 'a1', 'approve')).rejects.toBeInstanceOf(FailClosedError);
    await expect(c.getRun('r1')).rejects.toBeInstanceOf(FailClosedError);
    await expect(c.listRuns()).rejects.toBeInstanceOf(FailClosedError);
    expect(calls).toHaveLength(0);
  });
});

describe('JSON tools hit the right path/method/body with the wallet bearer', () => {
  it('list_workflows → GET /api/canvas/workflows', async () => {
    const { fetch, calls } = captureFetch(() => new Response(JSON.stringify({ workflows: [] }), { status: 200 }));
    const res = await client({ fetch }).listWorkflows();
    expect(res).toEqual({ workflows: [] });
    expect(calls[0].url).toBe('http://home.test/api/canvas/workflows');
    expect(calls[0].method).toBe('GET');
    expect(calls[0].headers.authorization).toBe('Bearer scwt_TESTTOKEN');
  });

  it('get_workflow → GET /api/canvas/workflows/:id (url-encoded)', async () => {
    const { fetch, calls } = captureFetch(() => new Response(JSON.stringify({ workflow: { id: 'a b' } }), { status: 200 }));
    await client({ fetch }).getWorkflow('a b');
    expect(calls[0].url).toBe('http://home.test/api/canvas/workflows/a%20b');
    expect(calls[0].method).toBe('GET');
  });

  it('save_workflow → POST /api/canvas/workflows with the full body + content-type', async () => {
    const { fetch, calls } = captureFetch(() => new Response(JSON.stringify({ workflow: { id: 'w' } }), { status: 200 }));
    await client({ fetch }).saveWorkflow({
      name: 'My Flow',
      nodes: [{ id: 'n1', type: 'agent' }],
      connections: [{ source: 'n1', target: 'n2' }],
      goal: 'do a thing',
      target: 'remote',
      remoteConfig: { model: 'claude-opus-4-8' },
    });
    expect(calls[0].url).toBe('http://home.test/api/canvas/workflows');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].headers['content-type']).toBe('application/json');
    expect(calls[0].headers.authorization).toBe('Bearer scwt_TESTTOKEN');
    const body = JSON.parse(calls[0].body!);
    expect(body.name).toBe('My Flow');
    expect(body.nodes).toEqual([{ id: 'n1', type: 'agent' }]);
    expect(body.target).toBe('remote');
    expect(body.remoteConfig).toEqual({ model: 'claude-opus-4-8' });
  });

  it('resolve_approval → POST /api/canvas/runs/:runId/approvals/:approvalId with decision+reason', async () => {
    const { fetch, calls } = captureFetch(() => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const res = await client({ fetch }).resolveApproval('run 1', 'appr/1', 'reject', 'not safe');
    expect(res).toEqual({ ok: true });
    expect(calls[0].url).toBe('http://home.test/api/canvas/runs/run%201/approvals/appr%2F1');
    expect(calls[0].method).toBe('POST');
    expect(JSON.parse(calls[0].body!)).toEqual({ decision: 'reject', reason: 'not safe' });
  });

  it('get_run → GET /api/canvas/runs/:runId', async () => {
    const { fetch, calls } = captureFetch(() => new Response(JSON.stringify({ run: { runId: 'r1' } }), { status: 200 }));
    await client({ fetch }).getRun('r1');
    expect(calls[0].url).toBe('http://home.test/api/canvas/runs/r1');
    expect(calls[0].method).toBe('GET');
  });

  it('list_runs → GET /api/canvas/runs with optional workflowId query', async () => {
    const { fetch, calls } = captureFetch(() => new Response(JSON.stringify({ runs: [] }), { status: 200 }));
    const c = client({ fetch });
    await c.listRuns();
    await c.listRuns('w1');
    expect(calls[0].url).toBe('http://home.test/api/canvas/runs');
    expect(calls[1].url).toBe('http://home.test/api/canvas/runs?workflowId=w1');
  });

  it('non-2xx becomes a HomeApiError carrying status + body', async () => {
    const { fetch } = captureFetch(() => new Response('unauthorized', { status: 401 }));
    await expect(client({ fetch }).listWorkflows()).rejects.toBeInstanceOf(HomeApiError);
    const { fetch: f2 } = captureFetch(() => new Response('unauthorized', { status: 401 }));
    await client({ fetch: f2 }).listWorkflows().catch((e: HomeApiError) => {
      expect(e.status).toBe(401);
      expect(e.body).toBe('unauthorized');
    });
  });
});

// ── SSE → run summary ─────────────────────────────────────────────────────────

const SSE_STREAM = [
  'data: {"kind":"run","runId":"run-7","status":"running","at":"t0"}\n\n',
  'data: {"kind":"node","runId":"run-7","nodeId":"n1","nodeType":"agent","status":"running","at":"t1"}\n\n',
  ': heartbeat\n\n',
  'data: {"kind":"text","runId":"run-7","nodeId":"n1","text":"hello","at":"t2"}\n\n',
  'data: {"kind":"node","runId":"run-7","nodeId":"n1","nodeType":"agent","status":"completed","at":"t3"}\n\n',
  'data: {"kind":"approval","runId":"run-7","approvalId":"a1","nodeId":"n2","state":"required","prompt":"ok?","at":"t4"}\n\n',
  'data: {"kind":"done","runId":"run-7","status":"completed","at":"t5"}\n\n',
].join('');

function streamFrom(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  // Split into two chunks to exercise the buffering across reads.
  const mid = Math.floor(bytes.length / 2);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.slice(0, mid));
      controller.enqueue(bytes.slice(mid));
      controller.close();
    },
  });
}

describe('SSE parsing + run summary', () => {
  it('parses framed data: lines from a chunked stream, ignoring heartbeats', async () => {
    const events: CanvasRunEvent[] = [];
    for await (const e of readSseEvents(streamFrom(SSE_STREAM))) events.push(e);
    expect(events.map((e) => e.kind)).toEqual(['run', 'node', 'text', 'node', 'approval', 'done']);
  });

  it('summarizeRun distills final status, per-node status, awaiting approvals, and text', () => {
    const events: CanvasRunEvent[] = [];
    return (async () => {
      for await (const e of readSseEvents(streamFrom(SSE_STREAM))) events.push(e);
      const summary = summarizeRun(events);
      expect(summary.runId).toBe('run-7');
      expect(summary.status).toBe('completed');
      expect(summary.nodes).toEqual([{ nodeId: 'n1', nodeType: 'agent', status: 'completed', error: undefined }]);
      expect(summary.awaitingApprovals).toEqual([
        { approvalId: 'a1', nodeId: 'n2', state: 'required', prompt: 'ok?', decision: undefined },
      ]);
      expect(summary.text).toBe('hello');
      expect(summary.eventCount).toBe(6);
    })();
  });

  it('run_workflow POSTs the spec and returns the summary built from the SSE body', async () => {
    const { fetch, calls } = captureFetch(
      () => new Response(streamFrom(SSE_STREAM), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    );
    const summary = await client({ fetch }).runWorkflow({ workflowId: 'w1', target: 'remote', inputs: { n1: 'go' } });
    expect(calls[0].url).toBe('http://home.test/api/canvas/runs');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].headers.authorization).toBe('Bearer scwt_TESTTOKEN');
    expect(JSON.parse(calls[0].body!)).toEqual({ workflowId: 'w1', target: 'remote', inputs: { n1: 'go' } });
    expect(summary.status).toBe('completed');
    expect(summary.awaitingApprovals).toHaveLength(1);
  });

  it('caps the concatenated run text', () => {
    const big = 'x'.repeat(50);
    const events: CanvasRunEvent[] = [
      { kind: 'text', runId: 'r', text: big, at: 't' },
      { kind: 'done', runId: 'r', status: 'completed', at: 't' },
    ];
    const summary = summarizeRun(events, 10);
    expect(summary.text).toContain('run text truncated');
    expect(summary.text.length).toBeLessThan(big.length + 80);
  });
});
