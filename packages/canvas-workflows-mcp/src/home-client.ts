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

/**
 * Thrown before network egress when an approval write is not bound to context
 * the operator actually observed. The MCP is a consumer only: Home remains the
 * pack/decision authority and re-validates the supplied hash on write.
 */
export class DecisionContextRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecisionContextRequiredError';
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
  | 'failed'
  | 'blocked';
export type ApprovalDecision = 'approve' | 'reject';

export interface IncompleteContextOverride {
  reason: string;
  missingSources?: string[];
}

export interface ResolveApprovalContext {
  reason?: string;
  decisionPackId?: string;
  /** Bare SHA-256 hash shown by get_decision_intelligence/expand_decision_pack. */
  decisionPackHash?: string;
  levantoScoreId?: string;
  renderedContextHash?: string;
  scoreViewedAt?: string;
  sessionId?: string;
  incompleteContextOverride?: IncompleteContextOverride;
}

export interface DecisionIntelligenceResponse {
  intelligence: {
    provider?: string;
    advisory?: boolean;
    available?: boolean;
    cached?: boolean;
    dossier?: unknown;
    decisionPack?: unknown;
    score?: unknown;
    display?: unknown;
    renderedContextHash?: string;
    scheduled?: unknown;
    unavailableReason?: string;
    [key: string]: unknown;
  };
}

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
  /** Optimistic concurrency (SPEC-005 §4): mismatch ⇒ home 409s with currentRev. */
  expectedRev?: number;
}

/** Optional one-step wiring when adding a node (SPEC-005 §4). */
export interface ConnectToSpec {
  from?: string;
  to?: string;
  fromPort?: string;
  toPort?: string;
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

  // ── Typed authoring ops (SPEC-005 §4) — surgical, validated construction ──
  // Home validates BEFORE persisting (bad DAGs 400 with machine-actionable
  // codes) and enforces optimistic concurrency (expectedRev mismatch → 409
  // carrying currentRev). The agent loop is add → connect → validate → run.

  addNode(
    workflowId: string,
    node: Record<string, unknown>,
    connectTo?: ConnectToSpec,
    expectedRev?: number,
  ): Promise<{ nodeId: string; rev: number; warnings: unknown[] }> {
    return this.requestJson('POST', `/api/canvas/workflows/${encodeURIComponent(workflowId)}/nodes`, {
      node,
      ...(connectTo ? { connectTo } : {}),
      ...(expectedRev !== undefined ? { expectedRev } : {}),
    });
  }

  connectNodes(
    workflowId: string,
    from: string,
    to: string,
    opts: { fromPort?: string; toPort?: string; expectedRev?: number } = {},
  ): Promise<{ connectionId: string; rev: number; warnings: unknown[] }> {
    return this.requestJson('POST', `/api/canvas/workflows/${encodeURIComponent(workflowId)}/connections`, {
      from,
      to,
      ...(opts.fromPort ? { fromPort: opts.fromPort } : {}),
      ...(opts.toPort ? { toPort: opts.toPort } : {}),
      ...(opts.expectedRev !== undefined ? { expectedRev: opts.expectedRev } : {}),
    });
  }

  removeNode(
    workflowId: string,
    nodeId: string,
    expectedRev?: number,
  ): Promise<{ ok: boolean; removed: string; rev: number; warnings: unknown[] }> {
    const q = expectedRev !== undefined ? `?expectedRev=${expectedRev}` : '';
    return this.requestJson(
      'DELETE',
      `/api/canvas/workflows/${encodeURIComponent(workflowId)}/nodes/${encodeURIComponent(nodeId)}${q}`,
    );
  }

  updateNode(
    workflowId: string,
    nodeId: string,
    configMerge: Record<string, unknown>,
    expectedRev?: number,
  ): Promise<{ node: unknown; rev: number; warnings: unknown[] }> {
    return this.requestJson(
      'PATCH',
      `/api/canvas/workflows/${encodeURIComponent(workflowId)}/nodes/${encodeURIComponent(nodeId)}`,
      { configMerge, ...(expectedRev !== undefined ? { expectedRev } : {}) },
    );
  }

  validateWorkflow(workflowId: string): Promise<{ valid: boolean; errors: unknown[]; warnings: unknown[] }> {
    return this.requestJson('GET', `/api/canvas/workflows/${encodeURIComponent(workflowId)}/validate`);
  }

  // ── Issue triage (SPEC-014 W4b) ──────────────────────────────────────────
  // Home is the SOLE writer/reader of the PRIVATE PriorityScoreSnapshots; these
  // just drive its authed routes — the same fail-closed wallet boundary.

  listScoredIssues(
    filters: { repo?: string; difficulty?: string; readinessStatus?: string; limit?: number } = {},
  ): Promise<{ issues: Array<Record<string, unknown>>; count: number }> {
    const qs = new URLSearchParams();
    if (filters.repo) qs.set('repo', filters.repo);
    if (filters.difficulty) qs.set('difficulty', filters.difficulty);
    if (filters.readinessStatus) qs.set('readiness_status', filters.readinessStatus);
    if (filters.limit) qs.set('limit', String(filters.limit));
    const suffix = qs.size > 0 ? `?${qs.toString()}` : '';
    return this.requestJson('GET', `/api/issues/scored${suffix}`);
  }

  /** Approve the scored-issue HITL item → home promotes it to a RoadmapItem. */
  promoteIssue(input: {
    repoFullName: string;
    issueNumber: number;
    title: string;
    snapshotNodeId?: string;
  }): Promise<Record<string, unknown>> {
    return this.requestJson('POST', '/api/hitl/decision', {
      item: {
        id: `issue:${input.repoFullName}#${input.issueNumber}`,
        kind: 'issue',
        title: input.title,
        sourceRef: {
          label: 'PriorityScoreSnapshot',
          ...(input.snapshotNodeId ? { nodeId: input.snapshotNodeId } : {}),
          scope: 'private',
        },
      },
      action: 'approve',
    });
  }

  // ── Run history ──────────────────────────────────────────────────────────

  listRuns(workflowId?: string): Promise<{ runs: unknown[] }> {
    const q = workflowId ? `?workflowId=${encodeURIComponent(workflowId)}` : '';
    return this.requestJson('GET', `/api/canvas/runs${q}`);
  }

  getRun(runId: string): Promise<{ run: unknown }> {
    return this.requestJson('GET', `/api/canvas/runs/${encodeURIComponent(runId)}`);
  }

  /**
   * Read Home's canonical immutable DecisionPack + Levanto receipt for one
   * paused gate. This client never derives or persists a competing pack.
   */
  getDecisionIntelligence(runId: string, approvalId: string): Promise<DecisionIntelligenceResponse> {
    return this.requestJson(
      'GET',
      `/api/canvas/runs/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(approvalId)}/intelligence`,
    );
  }

  /** Same Home read, exposed separately so callers explicitly request the full pack. */
  expandDecisionPack(runId: string, approvalId: string): Promise<DecisionIntelligenceResponse> {
    return this.getDecisionIntelligence(runId, approvalId);
  }

  async resolveApproval(
    runId: string,
    approvalId: string,
    decision: ApprovalDecision,
    context: ResolveApprovalContext,
  ): Promise<{ ok?: boolean; [k: string]: unknown }> {
    const observedPackHash = context.decisionPackHash?.trim();
    const overrideReason = context.incompleteContextOverride?.reason?.trim();
    if (!observedPackHash && !overrideReason) {
      throw new DecisionContextRequiredError(
        'Approval resolution requires the decisionPackHash returned by get_decision_intelligence, or an explicit incompleteContextOverride with a non-empty reason. No request was sent.',
      );
    }
    if (observedPackHash && !/^[a-f0-9]{64}$/i.test(observedPackHash)) {
      throw new DecisionContextRequiredError('decisionPackHash must be the 64-character SHA-256 value returned by Home. No request was sent.');
    }
    const body = {
      decision,
      ...(context.reason !== undefined ? { reason: context.reason } : {}),
      ...(context.decisionPackId ? { decisionPackId: context.decisionPackId } : {}),
      ...(observedPackHash ? { decisionPackHash: observedPackHash } : {}),
      ...(context.levantoScoreId ? { levantoScoreId: context.levantoScoreId } : {}),
      ...(context.renderedContextHash ? { renderedContextHash: context.renderedContextHash } : {}),
      ...(context.scoreViewedAt ? { scoreViewedAt: context.scoreViewedAt } : {}),
      ...(context.sessionId ? { sessionId: context.sessionId } : {}),
      ...(overrideReason ? {
        incompleteContextOverride: {
          reason: overrideReason,
          ...(context.incompleteContextOverride?.missingSources?.length
            ? { missingSources: context.incompleteContextOverride.missingSources }
            : {}),
        },
      } : {}),
    };
    return await this.requestJson(
      'POST',
      `/api/canvas/runs/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(approvalId)}`,
      body,
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
