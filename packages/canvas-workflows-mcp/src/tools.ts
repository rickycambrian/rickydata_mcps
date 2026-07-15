/**
 * tools.ts — the narrow, wallet-scoped tool surface. Every tool is backed by
 * rickydata_home's `/api/canvas/*` routes through HomeCanvasClient, so the MCP and
 * home's UI share one execution + persistence path. Tools NEVER touch the gateway
 * or KFDB directly.
 *
 * FAIL CLOSED: the client is built with the env signer (or null). When no wallet
 * context is present, every call throws FailClosedError, which we surface as an MCP
 * error result (`isError: true`) — never a silent success. The wallet is the auth
 * boundary.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  HomeCanvasClient,
  FailClosedError,
  DecisionContextRequiredError,
  HomeApiError,
  type CanvasTarget,
  type ConnectToSpec,
} from './home-client.js';

/** Cap tool text payloads so a large run/list can't blow the model's context. */
export const RESPONSE_MAX_LENGTH = parseInt(process.env.RESPONSE_MAX_LENGTH || '120000', 10);

function truncate(result: unknown): string {
  const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  if (text.length <= RESPONSE_MAX_LENGTH) return text;
  return `${text.slice(0, RESPONSE_MAX_LENGTH)}\n\n--- Response truncated (${text.length} chars, limit ${RESPONSE_MAX_LENGTH}) ---`;
}

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

function ok(result: unknown): ToolResult {
  return { content: [{ type: 'text', text: truncate(result) }] };
}

/**
 * Map a thrown error to an MCP error result. FailClosedError (no wallet) and
 * HomeApiError (home rejected/unreachable) both become explicit, non-silent error
 * results — the operator sees WHY, never a fake success.
 */
function fail(err: unknown): ToolResult {
  if (err instanceof FailClosedError) {
    return { content: [{ type: 'text', text: truncate({ error: 'fail_closed', message: err.message }) }], isError: true };
  }
  if (err instanceof DecisionContextRequiredError) {
    return {
      content: [{ type: 'text', text: truncate({ error: 'decision_context_required', message: err.message }) }],
      isError: true,
    };
  }
  if (err instanceof HomeApiError) {
    return {
      content: [{ type: 'text', text: truncate({ error: 'home_api_error', status: err.status, message: err.message }) }],
      isError: true,
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: 'text', text: truncate({ error: 'tool_error', message }) }], isError: true };
}

const targetSchema = z.enum(['remote', 'local']).describe("Execution target: 'remote' (Agent Gateway) or 'local' (rickydata_code). Defaults to the workflow's saved target.");

/** Loose JSON: accept already-parsed arrays/objects OR a JSON string and parse it. */
const jsonArraySchema = z
  .union([z.array(z.unknown()), z.string()])
  .describe('Array of nodes/connections — pass JSON (array) or a JSON string.');

const jsonObjectSchema = z
  .union([z.record(z.unknown()), z.string()])
  .describe('Free-form config object — pass JSON (object) or a JSON string.');

function coerceArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) throw new Error('expected a JSON array');
    return parsed;
  }
  return [];
}

function coerceObject(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string' && value.trim()) {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('expected a JSON object');
    return parsed as Record<string, unknown>;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/**
 * Small first read for a model/human: exact identities, question, score, and
 * source closure without duplicating the potentially large dossier/pack body.
 */
export function compactDecisionIntelligence(response: unknown): unknown {
  const intelligence = asRecord(asRecord(response)['intelligence']);
  const pack = asRecord(intelligence['decisionPack']);
  const sources = Array.isArray(pack['sources'])
    ? pack['sources'].map(asRecord)
    : [];
  const missingSources = sources
    .filter((source) => source['required'] === true && source['status'] !== 'completed')
    .map((source) => ({
      source: source['source'],
      status: source['status'],
      ...(typeof source['reason'] === 'string' && source['reason'] ? { reason: source['reason'] } : {}),
      ...(typeof source['returned'] === 'number' ? { returned: source['returned'] } : {}),
      ...(typeof source['totalMatched'] === 'number' ? { totalMatched: source['totalMatched'] } : {}),
    }));
  return {
    provider: intelligence['provider'],
    advisory: intelligence['advisory'],
    available: intelligence['available'],
    cached: intelligence['cached'],
    display: intelligence['display'],
    decisionPackId: pack['decisionPackId'],
    decisionPackHash: pack['decisionPackHash'],
    renderedContextHash: intelligence['renderedContextHash'],
    completeness: pack['completeness'],
    missingSources,
    sources: sources.map((source) => ({
      source: source['source'], required: source['required'], status: source['status'],
      returned: source['returned'], totalMatched: source['totalMatched'],
      cursorExhausted: source['cursorExhausted'], scanLimitHit: source['scanLimitHit'],
    })),
    score: intelligence['score'],
    scheduled: intelligence['scheduled'],
    unavailableReason: intelligence['unavailableReason'],
    next: 'Use expand_decision_pack with this runId/approvalId to inspect the full immutable DecisionPack before resolving. Pass the observed decisionPackHash to resolve_approval.',
  };
}

/** Full Home-authored pack projection. No consumer-side identity is minted. */
export function expandDecisionIntelligence(response: unknown): unknown {
  const intelligence = asRecord(asRecord(response)['intelligence']);
  const pack = asRecord(intelligence['decisionPack']);
  return {
    decisionPackId: pack['decisionPackId'],
    decisionPackHash: pack['decisionPackHash'],
    renderedContextHash: intelligence['renderedContextHash'],
    decisionPack: intelligence['decisionPack'],
    score: intelligence['score'],
    display: intelligence['display'],
    unavailableReason: intelligence['unavailableReason'],
  };
}

export interface RegisterToolsDeps {
  /** The home client (built fail-closed from the env signer). Injected for tests. */
  client: HomeCanvasClient;
}

/** The sixteen tools (fourteen canvas/decision + two issue-triage), all backed by home's authenticated routes. */
export function registerTools(server: McpServer, deps: RegisterToolsDeps): void {
  const { client } = deps;

  server.tool(
    'list_workflows',
    'List the operator wallet\'s saved canvas workflows (from rickydata_home\'s private KFDB store).',
    {},
    async () => {
      try {
        return ok(await client.listWorkflows());
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    'get_workflow',
    'Fetch one saved canvas workflow (nodes, connections, target, configs) by id.',
    { workflowId: z.string().describe('The workflow id.') },
    async ({ workflowId }) => {
      try {
        return ok(await client.getWorkflow(workflowId));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    'save_workflow',
    'Create or update a canvas workflow definition in the operator wallet\'s private store. Returns the saved workflow (with its id).',
    {
      name: z.string().describe('Human-readable workflow name (also seeds the id when none exists).'),
      nodes: jsonArraySchema,
      connections: jsonArraySchema,
      goal: z.string().optional().describe('Optional natural-language goal for the workflow.'),
      target: targetSchema.optional(),
      localConfig: jsonObjectSchema.optional().describe('Per-workflow local-target config (model/provider/servers/skills).'),
      remoteConfig: jsonObjectSchema.optional().describe('Per-workflow remote-target config (model/provider/servers/skills).'),
    },
    async ({ name, nodes, connections, goal, target, localConfig, remoteConfig }) => {
      try {
        return ok(
          await client.saveWorkflow({
            name,
            nodes: coerceArray(nodes),
            connections: coerceArray(connections),
            goal,
            target: target as CanvasTarget | undefined,
            localConfig: coerceObject(localConfig),
            remoteConfig: coerceObject(remoteConfig),
          }),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    'run_workflow',
    'Start a run of a saved workflow and consume the live event stream to completion. Returns a compact summary: final run status, per-node statuses, any approval gates still awaiting a human decision, and the run narration. Use resolve_approval to unblock awaiting gates.',
    {
      workflowId: z.string().describe('The workflow id to run.'),
      target: targetSchema.optional(),
      inputs: jsonObjectSchema.optional().describe('Initial inputs keyed by node id (text-input nodes etc.).'),
    },
    async ({ workflowId, target, inputs }) => {
      try {
        return ok(
          await client.runWorkflow({
            workflowId,
            target: target as CanvasTarget | undefined,
            inputs: coerceObject(inputs),
          }),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  // ── Typed authoring tools (SPEC-005 §4) ──────────────────────────────────
  // Surgical, validated construction — never resend-the-whole-graph. Home
  // validates BEFORE persisting (DAG acyclicity, known node types, tool-policy
  // sanity, guard reachability) and enforces optimistic concurrency: pass the
  // expectedVersion you last saw; a mismatch returns home's 409 with currentRev
  // — reload with get_workflow and retry. The incremental agent loop is
  // canvas_add_node → canvas_connect_nodes → canvas_validate_workflow → run_workflow.

  const expectedVersionSchema = z
    .number()
    .int()
    .optional()
    .describe(
      'Optimistic concurrency token: the workflow rev you last read. Mismatch → 409 with currentRev (someone else saved in between — reload and retry). Omit to skip the check (last-write-wins).',
    );

  server.tool(
    'canvas_add_node',
    'Add ONE node to a saved workflow (validated before persisting), optionally wiring it in the same step. Node shape: {id, type, data?, position?}. Known types include text-input, agent, mcp-tool, approval-gate, code-gate, output. Returns {nodeId, rev, warnings}.',
    {
      workflowId: z.string().describe('The workflow to mutate.'),
      node: jsonObjectSchema.describe('The node: {id, type, data?, position?} — JSON object or string.'),
      connectTo: jsonObjectSchema
        .optional()
        .describe('Optional one-step wiring: {from?: nodeId, to?: nodeId, fromPort?, toPort?}.'),
      expectedVersion: expectedVersionSchema,
    },
    async ({ workflowId, node, connectTo, expectedVersion }) => {
      try {
        const nodeObj = coerceObject(node);
        if (!nodeObj || typeof nodeObj['id'] !== 'string' || typeof nodeObj['type'] !== 'string') {
          throw new Error('node needs string id and type');
        }
        return ok(await client.addNode(workflowId, nodeObj, coerceObject(connectTo) as ConnectToSpec | undefined, expectedVersion));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    'canvas_connect_nodes',
    'Connect two existing nodes in a saved workflow (validated: endpoints must exist, no cycles, no duplicates). Returns {connectionId, rev, warnings}.',
    {
      workflowId: z.string().describe('The workflow to mutate.'),
      from: z.string().describe('Source node id.'),
      to: z.string().describe('Target node id.'),
      fromPort: z.string().optional().describe('Optional source port (handle) id.'),
      toPort: z.string().optional().describe('Optional target port (handle) id.'),
      expectedVersion: expectedVersionSchema,
    },
    async ({ workflowId, from, to, fromPort, toPort, expectedVersion }) => {
      try {
        return ok(await client.connectNodes(workflowId, from, to, { fromPort, toPort, expectedRev: expectedVersion }));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    'canvas_remove_node',
    'Remove a node (its edges detach). REFUSES to remove an approval-gate/code-gate that is the last guard upstream of a side-effect node (orphaned_guard). Returns {ok, removed, rev, warnings}.',
    {
      workflowId: z.string().describe('The workflow to mutate.'),
      nodeId: z.string().describe('The node to remove.'),
      expectedVersion: expectedVersionSchema,
    },
    async ({ workflowId, nodeId, expectedVersion }) => {
      try {
        return ok(await client.removeNode(workflowId, nodeId, expectedVersion));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    'canvas_update_node',
    "Surgically merge config into one node's data (objects merge one level deep, null deletes a key, everything else replaces) — no resend-the-whole-graph. Returns {node, rev, warnings}.",
    {
      workflowId: z.string().describe('The workflow to mutate.'),
      nodeId: z.string().describe('The node whose config to merge.'),
      configMerge: jsonObjectSchema.describe(
        "Partial config, e.g. {agent: {model: 'sonnet', disallowedTools: ['Write']}} or {gateSet: 'evidence-kinds'}.",
      ),
      expectedVersion: expectedVersionSchema,
    },
    async ({ workflowId, nodeId, configMerge, expectedVersion }) => {
      try {
        const merge = coerceObject(configMerge);
        if (!merge) throw new Error('configMerge must be a JSON object');
        return ok(await client.updateNode(workflowId, nodeId, merge, expectedVersion));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    'canvas_validate_workflow',
    'Full validation of a saved workflow WITHOUT mutating it: DAG acyclicity, endpoint existence, known node types, tool-policy sanity, code-gate config, guard reachability for side-effect nodes. Returns {valid, errors[], warnings[]} with machine-actionable codes.',
    { workflowId: z.string().describe('The workflow to validate.') },
    async ({ workflowId }) => {
      try {
        return ok(await client.validateWorkflow(workflowId));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    'get_decision_intelligence',
    'Get the compact, canonical rickydata_home DecisionPack/Levanto summary for a paused approval. Returns the exact pack hash, rendered-context hash, score, completeness, and missing sources. Read this before resolve_approval; Home remains the only pack/decision authority.',
    {
      runId: z.string().describe('The paused run id.'),
      approvalId: z.string().describe('The approval gate id.'),
    },
    async ({ runId, approvalId }) => {
      try {
        return ok(compactDecisionIntelligence(await client.getDecisionIntelligence(runId, approvalId)));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    'expand_decision_pack',
    'Expand the exact immutable DecisionPack authored by rickydata_home for a paused approval, including its complete dossier, source receipts, artifacts, completeness gaps, and Levanto receipt. This MCP never mints a separate pack identity.',
    {
      runId: z.string().describe('The paused run id.'),
      approvalId: z.string().describe('The approval gate id.'),
    },
    async ({ runId, approvalId }) => {
      try {
        return ok(expandDecisionIntelligence(await client.expandDecisionPack(runId, approvalId)));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    'resolve_approval',
    'Approve or reject a paused HITL gate only after observing Home decision intelligence. Requires the exact decisionPackHash returned by get_decision_intelligence/expand_decision_pack, or an explicit incompleteContextOverride reason. Home validates freshness, records the durable decision, then unblocks the run.',
    {
      runId: z.string().describe('The run id that is paused at an approval gate.'),
      approvalId: z.string().describe('The approval gate id (from run_workflow\'s awaitingApprovals).'),
      decision: z.enum(['approve', 'reject']).describe('The human verdict.'),
      reason: z.string().optional().describe('Optional reason captured as feedback for self-refinement.'),
      decisionPackId: z.string().optional().describe('The Home DecisionPack id shown by the decision-intelligence read.'),
      decisionPackHash: z.string().regex(/^[a-f0-9]{64}$/i).optional().describe('Required observed SHA-256 pack hash unless incompleteContextOverride is supplied.'),
      levantoScoreId: z.string().optional().describe('The Levanto score id shown to the operator, when one was displayed.'),
      renderedContextHash: z.string().regex(/^[a-f0-9]{64}$/i).optional().describe('Hash of the exact compact decision context shown to the operator.'),
      scoreViewedAt: z.string().optional().describe('RFC3339 time when the operator/model saw the Levanto score.'),
      sessionId: z.string().optional().describe('The consuming MCP/agent session id for the observation receipt.'),
      incompleteContextOverride: z.object({
        reason: z.string().min(1).describe('Why it is safe/necessary to decide with incomplete context.'),
        missingSources: z.array(z.string()).optional().describe('Named incomplete sources acknowledged by the operator.'),
      }).optional().describe('Explicit, durable override used only when the pack cannot be complete.'),
    },
    async ({
      runId, approvalId, decision, reason, decisionPackId, decisionPackHash,
      levantoScoreId, renderedContextHash, scoreViewedAt, sessionId, incompleteContextOverride,
    }) => {
      try {
        return ok(await client.resolveApproval(runId, approvalId, decision, {
          reason, decisionPackId, decisionPackHash, levantoScoreId,
          renderedContextHash, scoreViewedAt, sessionId, incompleteContextOverride,
        }));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    'get_run',
    'Replay one run from rickydata_home\'s durable store: status, per-node steps, and approval history.',
    { runId: z.string().describe('The run id.') },
    async ({ runId }) => {
      try {
        return ok(await client.getRun(runId));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    'list_runs',
    'List recent canvas runs from the durable store, optionally filtered to one workflow.',
    { workflowId: z.string().optional().describe('Optional: only runs of this workflow.') },
    async ({ workflowId }) => {
      try {
        return ok(await client.listRuns(workflowId));
      } catch (err) {
        return fail(err);
      }
    },
  );

  // ── Issue triage (SPEC-014 W4b) — the fleet's read/act seam over home's ──
  // durable PRIVATE PriorityScoreSnapshots (rickydata_home is the sole writer).

  server.tool(
    'issue_triage_list',
    'The scored GitHub-issue triage list from rickydata_home: latest PRIVATE PriorityScoreSnapshot per issue, deterministic priority_rank ASC (work-this-first). topCandidates:true narrows to ready + tractability ≥ 0.6.',
    {
      repo: z.string().optional().describe("Filter to one repo (repo_id like 'rickydata_home' or full 'owner/name')."),
      readinessStatus: z.enum(['ready', 'marginal', 'needs_info', 'unscored']).optional(),
      difficulty: z.string().optional().describe('simple | medium | large | complex'),
      limit: z.number().int().positive().max(500).optional().describe('Max rows (default 50).'),
      topCandidates: z.boolean().optional().describe('true → only ready issues with tractability ≥ 0.6.'),
    },
    async ({ repo, readinessStatus, difficulty, limit, topCandidates }) => {
      try {
        const { issues } = await client.listScoredIssues({
          repo,
          readinessStatus,
          difficulty,
          limit: topCandidates ? 500 : (limit ?? 50),
        });
        const rows = topCandidates
          ? issues
              .filter(
                (r) => r['readinessStatus'] === 'ready' && typeof r['tractability'] === 'number' && (r['tractability'] as number) >= 0.6,
              )
              .slice(0, limit ?? 50)
          : issues;
        return ok({ count: rows.length, issues: rows });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    'issue_triage_promote',
    "Promote one scored issue into rickydata_home's Mission Control backlog (records a durable HomeDecision, creates/merges the RoadmapItem, links CAPTURES_PRIORITY). Idempotent per issue — the decision suppresses the inbox item.",
    {
      repoFullName: z.string().describe("The repo in 'owner/name' form."),
      issueNumber: z.number().int().positive().describe('The GitHub issue number.'),
    },
    async ({ repoFullName, issueNumber }) => {
      try {
        // Resolve the issue's latest snapshot first so the decision carries the
        // real title + snapshot node id (the CAPTURES_PRIORITY edge source).
        const { issues } = await client.listScoredIssues({ repo: repoFullName, limit: 500 });
        const row = issues.find((r) => r['issueNumber'] === issueNumber);
        if (!row) {
          throw new Error(
            `no scored snapshot for ${repoFullName}#${issueNumber} — run a scan in home first (the triage list only covers scanned issues)`,
          );
        }
        return ok(
          await client.promoteIssue({
            repoFullName,
            issueNumber,
            title: `[${repoFullName}#${issueNumber}] ${String(row['title'] ?? '')}`,
            snapshotNodeId: typeof row['nodeId'] === 'string' ? (row['nodeId'] as string) : undefined,
          }),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );
}

/** The tool names this MCP exposes — single source of truth for tests/docs. */
export const TOOL_NAMES = [
  'list_workflows',
  'get_workflow',
  'save_workflow',
  'run_workflow',
  'canvas_add_node',
  'canvas_connect_nodes',
  'canvas_remove_node',
  'canvas_update_node',
  'canvas_validate_workflow',
  'get_decision_intelligence',
  'expand_decision_pack',
  'resolve_approval',
  'get_run',
  'list_runs',
  'issue_triage_list',
  'issue_triage_promote',
] as const;
