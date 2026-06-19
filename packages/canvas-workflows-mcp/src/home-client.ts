/**
 * home-client.ts — the thin, FAIL-CLOSED client over rickydata_home's authenticated
 * `/api/canvas/*` routes. Home owns the CanvasExecutor, the durable KFDB store, and
 * the HITL bridge; this MCP is a narrow remote control, so the MCP and home's UI
 * share ONE execution + persistence path.
 *
 * Every request carries an `Authorization: Bearer <scwt_…>` minted from the operator
 * wallet (see wallet-token.ts). If there is NO wallet/private-key context, the client
 * is constructed with `signer: null` and every call throws `FailClosedError` BEFORE any
 * network egress — the wallet is the auth boundary; there is no anonymous fallback.
 *
 * `fetch` and the token minter are injected so the whole surface is unit-testable
 * without a running home.
 */
import {
  mintWalletToken as defaultMintWalletToken,
  type MintWalletTokenOptions,
  type WalletSigner,
} from './wallet-token.js';

/** Thrown when a tool is invoked with no wallet context. Surfaced as an error result. */
export class FailClosedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FailClosedError';
  }
}

/** Thrown when home returns a non-2xx; carries status + a capped body for diagnosis. */
export class HomeApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    message?: string,
  ) {
    super(message ?? `home API ${status}: ${body.slice(0, 300)}`);
    this.name = 'HomeApiError';
  }
}

// ── Home's canvas vocabulary (mirrors rickydata_home/src/canvas/types.ts) ──────

export type CanvasTarget = 'remote' | 'local';
export type CanvasRunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'canceled';
export type CanvasNodeStatus =
  | 'created'
  | 'running'
  | 'awaiting_approval'
  | 'completed'
  | 'failed';
export type ApprovalDecision = 'approve' | 'reject';

/** The single normalized event home streams from POST /api/canvas/runs. */
export type CanvasRunEvent =
  | { kind: 'run'; runId: string; status: CanvasRunStatus; at: string; error?: string; raw?: unknown }
  | {
      kind: 'node';
      runId: string;
      nodeId: string;
      nodeType?: string;
      status: CanvasNodeStatus;
      output?: unknown;
      error?: string;
      at: string;
      raw?: unknown;
    }
  | {
      kind: 'approval';
      runId: string;
      approvalId: string;
      nodeId: string;
      state: 'required' | 'resolved';
      prompt?: string;
      decision?: ApprovalDecision;
      reason?: string;
      at: string;
      raw?: unknown;
    }
  | { kind: 'text'; runId: string; nodeId?: string; text: string; at: string; raw?: unknown }
  | { kind: 'done'; runId: string; status: CanvasRunStatus; at: string; raw?: unknown };

export interface SaveWorkflowInput {
  name: string;
  nodes: unknown[];
  connections: unknown[];
  goal?: string;
  target?: CanvasTarget;
  localConfig?: Record<string, unknown>;
  remoteConfig?: Record<string, unknown>;
}

export interface RunWorkflowInput {
  workflowId: string;
  target?: CanvasTarget;
  inputs?: Record<string, unknown>;
}

/** A node's terminal-ish status, distilled from the stream for the run summary. */
export interface RunNodeSummary {
  nodeId: string;
  nodeType?: string;
  status: CanvasNodeStatus;
  error?: string;
}

/** An approval gate the run is (still) waiting on when the stream ends. */
export interface RunApprovalSummary {
  approvalId: string;
  nodeId: string;
  state: 'required' | 'resolved';
  prompt?: string;
  decision?: ApprovalDecision;
}

/** The compact result returned by run_workflow — not the raw event firehose. */
export interface RunSummary {
  runId: string;
  status: CanvasRunStatus;
  nodes: RunNodeSummary[];
  /** Gates still 'required' (awaiting a human decision) at stream end. */
  awaitingApprovals: RunApprovalSummary[];
  /** Concatenated `text` events (capped) — the human-readable run narration. */
  text: string;
  error?: string;
  eventCount: number;
}

export interface HomeClientDeps {
  /** Base URL of rickydata_home, e.g. http://localhost:8788 (no trailing slash needed). */
  baseUrl: string;
  /**
   * The operator wallet signer, or null when no wallet context is present. Null →
   * every call fails closed.
   */
  signer: WalletSigner | null;
  /** Injected for testability; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injected for testability; defaults to the real scwt_ minter. */
  mintToken?: (opts: MintWalletTokenOptions) => Promise<string>;
  /** Token lifetime override (seconds). */
  tokenTtlSeconds?: number;
  /** Cap on concatenated run text in a summary (chars). */
  textCap?: number;
}

const DEFAULT_TEXT_CAP = 8000;

export class HomeCanvasClient {
  private readonly baseUrl: string;
  private readonly signer: WalletSigner | null;
  private readonly fetchImpl: typeof fetch;
  private readonly mintToken: (opts: MintWalletTokenOptions) => Promise<string>;
  private readonly tokenTtlSeconds?: number;
  private readonly textCap: number;

  constructor(deps: HomeClientDeps) {
    this.baseUrl = deps.baseUrl.replace(/\/$/, '');
    this.signer = deps.signer;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.mintToken = deps.mintToken ?? defaultMintWalletToken;
    this.tokenTtlSeconds = deps.tokenTtlSeconds;
    this.textCap = deps.textCap ?? DEFAULT_TEXT_CAP;
  }

  /** FAIL CLOSED: refuse before any network egress when there is no wallet context. */
  private requireSigner(): WalletSigner {
    if (!this.signer) {
      throw new FailClosedError(
        'No operator wallet context: set CANVAS_MCP_PRIVATE_KEY so the MCP can mint the scwt_ wallet token rickydata_home requires. The wallet is the auth boundary; there is no anonymous fallback.',
      );
    }
    return this.signer;
  }

  /** Mint a fresh bearer for the operator wallet. */
  private async authHeader(): Promise<string> {
    const signer = this.requireSigner();
    const token = await this.mintToken({
      address: signer.address,
      signFn: (m) => signer.signMessage(m),
      ttlSeconds: this.tokenTtlSeconds,
    });
    return `Bearer ${token}`;
  }

  /** Authenticated JSON request → parsed body, or HomeApiError on non-2xx. */
  private async requestJson<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const authorization = await this.authHeader();
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        accept: 'application/json',
        authorization,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new HomeApiError(res.status, text);
    if (!text) return {} as T;
    return JSON.parse(text) as T;
  }

  // ── Workflow definitions ─────────────────────────────────────────────────

  listWorkflows(): Promise<{ workflows: unknown[] }> {
    return this.requestJson('GET', '/api/canvas/workflows');
  }

  getWorkflow(workflowId: string): Promise<{ workflow: unknown }> {
    return this.requestJson('GET', `/api/canvas/workflows/${encodeURIComponent(workflowId)}`);
  }

  saveWorkflow(input: SaveWorkflowInput): Promise<{ workflow: unknown }> {
    return this.requestJson('POST', '/api/canvas/workflows', input);
  }

  // ── Run history ──────────────────────────────────────────────────────────

  listRuns(workflowId?: string): Promise<{ runs: unknown[] }> {
    const q = workflowId ? `?workflowId=${encodeURIComponent(workflowId)}` : '';
    return this.requestJson('GET', `/api/canvas/runs${q}`);
  }

  getRun(runId: string): Promise<{ run: unknown }> {
    return this.requestJson('GET', `/api/canvas/runs/${encodeURIComponent(runId)}`);
  }

  resolveApproval(
    runId: string,
    approvalId: string,
    decision: ApprovalDecision,
    reason?: string,
  ): Promise<{ ok?: boolean; [k: string]: unknown }> {
    return this.requestJson(
      'POST',
      `/api/canvas/runs/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(approvalId)}`,
      { decision, ...(reason !== undefined ? { reason } : {}) },
    );
  }

  // ── Run a workflow: consume the SSE to completion → compact summary ───────

  async runWorkflow(input: RunWorkflowInput): Promise<RunSummary> {
    const authorization = await this.authHeader();
    const res = await this.fetchImpl(`${this.baseUrl}/api/canvas/runs`, {
      method: 'POST',
      headers: {
        accept: 'text/event-stream',
        authorization,
        'content-type': 'application/json',
      },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new HomeApiError(res.status, text);
    }
    const stream = res.body;
    if (!stream) throw new HomeApiError(res.status, '', 'home run response had no body stream');

    const events: CanvasRunEvent[] = [];
    for await (const evt of readSseEvents(stream)) events.push(evt);
    return summarizeRun(events, this.textCap);
  }
}

/**
 * Parse an SSE byte stream into the JSON `data:` frames home emits
 * (`data: {…}\n\n`). Tolerant of multi-line data fields and CRLF; ignores
 * comment/heartbeat lines and any frame whose data is not valid JSON.
 */
export async function* readSseEvents(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<CanvasRunEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true });
      if (done) buffer += decoder.decode();

      // Frames are separated by a blank line. Normalize CRLF first.
      let sepIndex: number;
      // eslint-disable-next-line no-cond-assign
      while ((sepIndex = indexOfFrameSep(buffer)) !== -1) {
        const rawFrame = buffer.slice(0, sepIndex);
        buffer = buffer.slice(sepIndex).replace(/^(\r?\n){1,2}/, '');
        const evt = parseSseFrame(rawFrame);
        if (evt) yield evt;
      }
      if (done) {
        const tail = parseSseFrame(buffer);
        if (tail) yield tail;
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Index of the first blank-line frame separator (\n\n or \r\n\r\n), or -1. */
function indexOfFrameSep(s: string): number {
  const lf = s.indexOf('\n\n');
  const crlf = s.indexOf('\r\n\r\n');
  if (lf === -1) return crlf;
  if (crlf === -1) return lf;
  return Math.min(lf, crlf);
}

/** Extract + JSON-parse the concatenated `data:` lines of one SSE frame. */
function parseSseFrame(frame: string): CanvasRunEvent | null {
  const dataLines: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
  }
  if (dataLines.length === 0) return null;
  const data = dataLines.join('\n').trim();
  if (!data) return null;
  try {
    return JSON.parse(data) as CanvasRunEvent;
  } catch {
    return null;
  }
}

/** Distill the full event stream into the compact RunSummary the tool returns. */
export function summarizeRun(events: CanvasRunEvent[], textCap = DEFAULT_TEXT_CAP): RunSummary {
  let runId = '';
  let status: CanvasRunStatus = 'pending';
  let error: string | undefined;
  const nodes = new Map<string, RunNodeSummary>();
  const approvals = new Map<string, RunApprovalSummary>();
  const textParts: string[] = [];

  for (const evt of events) {
    if (evt.runId) runId = evt.runId;
    switch (evt.kind) {
      case 'run':
        status = evt.status;
        if (evt.error) error = evt.error;
        break;
      case 'done':
        status = evt.status;
        break;
      case 'node':
        nodes.set(evt.nodeId, {
          nodeId: evt.nodeId,
          nodeType: evt.nodeType,
          status: evt.status,
          error: evt.error,
        });
        if (evt.error && !error) error = evt.error;
        break;
      case 'approval':
        approvals.set(evt.approvalId, {
          approvalId: evt.approvalId,
          nodeId: evt.nodeId,
          state: evt.state,
          prompt: evt.prompt,
          decision: evt.decision,
        });
        break;
      case 'text':
        if (evt.text) textParts.push(evt.text);
        break;
    }
  }

  let text = textParts.join('\n');
  if (text.length > textCap) {
    text = `${text.slice(0, textCap)}\n\n--- run text truncated (${text.length} chars, limit ${textCap}) ---`;
  }

  return {
    runId,
    status,
    nodes: [...nodes.values()],
    awaitingApprovals: [...approvals.values()].filter((a) => a.state === 'required'),
    text,
    error,
    eventCount: events.length,
  };
}
