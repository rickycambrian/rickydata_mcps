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
  HomeApiError,
  type CanvasTarget,
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

export interface RegisterToolsDeps {
  /** The home client (built fail-closed from the env signer). Injected for tests. */
  client: HomeCanvasClient;
}

/** The seven canvas tools, all backed by home's authenticated routes. */
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

  server.tool(
    'resolve_approval',
    'Approve or reject a HITL approval gate that a run paused on. Records a durable human decision in rickydata_home AND unblocks the still-open run on its target.',
    {
      runId: z.string().describe('The run id that is paused at an approval gate.'),
      approvalId: z.string().describe('The approval gate id (from run_workflow\'s awaitingApprovals).'),
      decision: z.enum(['approve', 'reject']).describe('The human verdict.'),
      reason: z.string().optional().describe('Optional reason captured as feedback for self-refinement.'),
    },
    async ({ runId, approvalId, decision, reason }) => {
      try {
        return ok(await client.resolveApproval(runId, approvalId, decision, reason));
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
}

/** The tool names this MCP exposes — single source of truth for tests/docs. */
export const TOOL_NAMES = [
  'list_workflows',
  'get_workflow',
  'save_workflow',
  'run_workflow',
  'resolve_approval',
  'get_run',
  'list_runs',
] as const;
