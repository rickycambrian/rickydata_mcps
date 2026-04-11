import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { ethers } from "ethers";
import {
  getAuthenticatedSDK,
  getReadOnlySDK,
  hasAuthentication,
  resolvePrivateKey,
} from "../auth/sdk-client.js";
import { getChainName } from "../utils/chains.js";

// ============================================================================
// WALLET TOKEN GENERATION (mcpwt_)
// ============================================================================
//
// Generates a self-signed, self-verifying wallet token from the locally-held
// private key. Used for Bearer auth on task-read endpoints so the derived
// agent wallet can read its own tasks without paying x402 each time.
// Format matches mcp-agent-gateway/src/auth/wallet-token.ts: same canonical
// message, same base64url(JSON) encoding, same signature scheme. Verified
// server-side via ecrecover — no server state, no roundtrip.

const WALLET_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const WALLET_TOKEN_REFRESH_MS = 12 * 60 * 60 * 1000; // refresh at 12h
let _cachedWalletToken: { token: string; expiresAtMs: number; pk: string } | null = null;

async function getDerivedWalletToken(): Promise<string | null> {
  const pk = resolvePrivateKey();
  if (!pk) return null;

  // Reuse cached token if still fresh and same wallet
  const now = Date.now();
  if (
    _cachedWalletToken &&
    _cachedWalletToken.pk === pk &&
    _cachedWalletToken.expiresAtMs - now > WALLET_TOKEN_REFRESH_MS
  ) {
    return _cachedWalletToken.token;
  }

  try {
    const wallet = new ethers.Wallet(pk.startsWith('0x') ? pk : '0x' + pk);
    const expiresAtMs = now + WALLET_TOKEN_TTL_MS;
    const expiresAt = new Date(expiresAtMs).toISOString();
    const checksummed = ethers.getAddress(wallet.address);
    const msg = `MCP Platform Auth\nWallet: ${checksummed}\nExpires: ${expiresAt}`;
    const sig = await wallet.signMessage(msg);
    const payload = {
      v: 1,
      wallet: checksummed,
      exp: Math.floor(expiresAtMs / 1000),
      msg,
      sig,
    };
    const token = 'mcpwt_' + Buffer.from(JSON.stringify(payload)).toString('base64url');
    _cachedWalletToken = { token, expiresAtMs, pk };
    return token;
  } catch {
    return null;
  }
}

export const a2aTools: Tool[] = [
  {
    name: "a2a_send_message",
    description:
      "Send a message to an ERC-8004 agent via the A2A (Agent-to-Agent) protocol. " +
      "The agent must have an A2A endpoint configured. Requires configured wallet. " +
      "Returns a task ID for tracking the conversation.",
    inputSchema: {
      type: "object" as const,
      properties: {
        agentId: {
          type: "string",
          description: "Agent ID in chainId:tokenId format (e.g. '11155111:42')",
        },
        message: {
          type: "string",
          description: "Message text to send to the agent",
        },
        taskId: {
          type: "string",
          description: "Existing task ID to continue a conversation (optional)",
        },
      },
      required: ["agentId", "message"],
    },
  },
  {
    name: "a2a_list_tasks",
    description:
      "List A2A tasks/conversations with a specific agent. " +
      "Returns task IDs, statuses, and summaries.",
    inputSchema: {
      type: "object" as const,
      properties: {
        agentId: {
          type: "string",
          description: "Agent ID in chainId:tokenId format",
        },
      },
      required: ["agentId"],
    },
  },
  {
    name: "a2a_get_task",
    description:
      "Get details of a specific A2A task including messages and artifacts.",
    inputSchema: {
      type: "object" as const,
      properties: {
        agentId: {
          type: "string",
          description: "Agent ID in chainId:tokenId format",
        },
        taskId: {
          type: "string",
          description: "Task ID to retrieve",
        },
      },
      required: ["agentId", "taskId"],
    },
  },
  {
    name: "a2a_query_task",
    description:
      "Query an A2A task to get its current status, messages, and artifacts. " +
      "Optionally limit how much conversation history is returned.",
    inputSchema: {
      type: "object" as const,
      properties: {
        agentId: {
          type: "string",
          description: "Agent ID in chainId:tokenId format",
        },
        taskId: {
          type: "string",
          description: "Task ID to query",
        },
        historyLength: {
          type: "number",
          description: "Number of recent messages to include (default: all)",
        },
      },
      required: ["agentId", "taskId"],
    },
  },
  {
    name: "a2a_task_message",
    description:
      "Send a follow-up message to an existing A2A task. " +
      "Continues the conversation within the task context.",
    inputSchema: {
      type: "object" as const,
      properties: {
        agentId: {
          type: "string",
          description: "Agent ID in chainId:tokenId format",
        },
        taskId: {
          type: "string",
          description: "Existing task ID to send message to",
        },
        message: {
          type: "string",
          description: "Message text to send",
        },
      },
      required: ["agentId", "taskId", "message"],
    },
  },
  {
    name: "a2a_cancel_task",
    description:
      "Cancel an in-progress A2A task. Requires configured wallet.",
    inputSchema: {
      type: "object" as const,
      properties: {
        agentId: {
          type: "string",
          description: "Agent ID in chainId:tokenId format",
        },
        taskId: {
          type: "string",
          description: "Task ID to cancel",
        },
      },
      required: ["agentId", "taskId"],
    },
  },
];

// ============================================================================
// HELPERS
// ============================================================================

async function requireAuth() {
  if (!hasAuthentication()) {
    return {
      sdk: null as any,
      error: "No wallet configured. Call configure_wallet first.",
    };
  }
  const sdk = await getAuthenticatedSDK();
  if (!sdk) {
    return { sdk: null as any, error: "Failed to initialize authenticated SDK." };
  }
  return { sdk, error: undefined };
}

function parseChainId(agentId: string): number {
  const parts = agentId.split(":");
  return parts.length === 2 ? parseInt(parts[0], 10) : 11155111;
}

// ============================================================================
// A2A ENDPOINT RESOLUTION
// ============================================================================

async function resolveA2aEndpoint(a2aUrl: string): Promise<{ baseUrl: string; a2aVersion: string }> {
  // Fetch agent card from the A2A endpoint
  const isCardUrl = /\/(\.well-known\/)?(agent-card|agent)\.json$/i.test(new URL(a2aUrl).pathname);
  let cardData: Record<string, unknown> | null = null;

  if (isCardUrl) {
    const res = await fetch(a2aUrl, { signal: AbortSignal.timeout(5000), redirect: 'follow' });
    if (res.ok) cardData = await res.json() as Record<string, unknown>;
  } else {
    const base = a2aUrl.replace(/\/+$/, '');
    for (const p of ['/.well-known/agent-card.json', '/.well-known/agent.json']) {
      const res = await fetch(`${base}${p}`, { signal: AbortSignal.timeout(5000), redirect: 'follow' });
      if (res.ok) { cardData = await res.json() as Record<string, unknown>; break; }
      if (res.status !== 404) break;
    }
  }

  if (!cardData) throw new Error('Could not load agent card');

  // Extract base URL and version from card interfaces
  const interfaces = cardData.supportedInterfaces as Array<{ url?: string; protocolVersion?: string; protocolBinding?: string }> | undefined;
  if (Array.isArray(interfaces) && interfaces.length > 0) {
    const chosen = interfaces.find(i => i.protocolBinding === 'HTTP+JSON') ?? interfaces[0];
    return {
      baseUrl: (chosen.url ?? '').replace(/\/+$/, ''),
      a2aVersion: chosen.protocolVersion ?? '1.0',
    };
  }

  // Fallback: use card's url field or derive from A2A URL
  const url = (cardData.url as string) ?? a2aUrl.replace(/\/(\.well-known\/)?(agent-card|agent)\.json$/i, '') ?? a2aUrl;
  return { baseUrl: url.replace(/\/+$/, ''), a2aVersion: (cardData.protocolVersion as string) ?? '1.0' };
}

// ============================================================================
// HANDLERS
// ============================================================================

async function handleSendMessage(
  args: Record<string, unknown>,
): Promise<unknown> {
  const { sdk, error } = await requireAuth();
  if (error || !sdk) return { error };

  const agentId = args.agentId as string;
  const message = args.message as string;

  // Load agent summary to get A2A endpoint
  const agentSummary = await sdk.getAgent(agentId);
  if (!agentSummary) {
    return { error: `Agent ${agentId} not found` };
  }
  if (!agentSummary.a2a) {
    return {
      error: `Agent ${agentId} does not have an A2A endpoint configured`,
    };
  }

  // Resolve A2A interface from agent card
  const { baseUrl, a2aVersion } = await resolveA2aEndpoint(agentSummary.a2a);

  // Build A2A message body
  const body = {
    jsonrpc: '2.0' as const,
    id: `msg-${Date.now()}`,
    method: 'SendMessage',
    params: {
      message: {
        role: 'ROLE_USER',
        parts: [{ text: message }],
        ...(args.taskId ? { taskId: args.taskId } : {}),
      },
    },
  };

  const messageSendUrl = `${baseUrl}/message:send`;

  // Step 1: Send initial request (expect 402 for paid agents)
  const initialRes = await fetch(messageSendUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'A2A-Version': a2aVersion },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });

  // If 200, agent doesn't require payment
  if (initialRes.ok) {
    const data = await initialRes.json() as Record<string, unknown>;
    const task = (data as any).task ?? (data as any).result ?? data;
    return formatTaskResult(agentId, task);
  }

  // If not 402, unexpected error
  if (initialRes.status !== 402) {
    const text = await initialRes.text();
    return { success: false, error: `A2A request failed: HTTP ${initialRes.status}`, detail: text.slice(0, 300) };
  }

  // Step 2: Parse 402 challenge
  const challengeBody = await initialRes.json() as Record<string, unknown>;
  const accepts = (challengeBody as any)?.data?.accepts ?? (challengeBody as any)?.accepts ?? [];
  if (!accepts.length) {
    return { success: false, error: 'A2A 402 response missing accepts', detail: JSON.stringify(challengeBody).slice(0, 300) };
  }

  // Step 3: Sign x402 payment using SDK's wallet
  const x402Deps = sdk.getX402RequestDeps?.();
  if (!x402Deps?.buildPayment) {
    return { success: false, error: 'No x402 payment capability — wallet may not have signing key' };
  }

  let paymentHeader: string;
  try {
    paymentHeader = await x402Deps.buildPayment(accepts[0], { url: messageSendUrl, method: 'POST', x402Version: 2, resource: accepts[0]?.resource });
  } catch (e) {
    return { success: false, error: `x402 payment signing failed: ${(e as Error).message}`, agentId };
  }

  // Step 4: Retry with payment
  const paidRes = await fetch(messageSendUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'A2A-Version': a2aVersion,
      'PAYMENT-SIGNATURE': paymentHeader,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });

  if (!paidRes.ok) {
    const text = await paidRes.text();
    return { success: false, error: `A2A paid request failed: HTTP ${paidRes.status}`, detail: text.slice(0, 300) };
  }

  const data = await paidRes.json() as Record<string, unknown>;
  let task = (data as any).task ?? (data as any).result ?? data;

  // Poll if task is SUBMITTED (agent hasn't finished yet).
  // Use a derived-wallet mcpwt_ Bearer token for the poll — the x402 payment
  // nonce is one-shot and can't be reused for task reads.
  const taskId = task?.id ?? task?.taskId;
  if (taskId && isSubmittedState(task)) {
    const bearer = await getDerivedWalletToken();
    task = await pollForCompletion(baseUrl, a2aVersion, taskId, bearer) ?? task;
  }

  return formatTaskResult(agentId, task);
}

function isSubmittedState(task: any): boolean {
  const state = task?.status?.state;
  return state === 'TASK_STATE_SUBMITTED' || state === 'submitted' || state === 'working';
}

async function pollForCompletion(baseUrl: string, a2aVersion: string, taskId: string, bearerToken: string | null): Promise<any | null> {
  const taskUrl = `${baseUrl}/tasks/${taskId}`;
  const headers: Record<string, string> = { 'A2A-Version': a2aVersion };
  if (bearerToken) headers['Authorization'] = `Bearer ${bearerToken}`;
  for (let i = 0; i < 12; i++) {  // Poll up to 60s (12 * 5s)
    await new Promise(r => setTimeout(r, 5000));
    try {
      const res = await fetch(taskUrl, {
        headers,
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) continue;
      const data = await res.json() as any;
      const task = data.task ?? data.result ?? data;
      if (!isSubmittedState(task)) return task;
    } catch { /* retry */ }
  }
  return null;
}

function formatTaskResult(agentId: string, task: Record<string, unknown>): unknown {
  const chainId = parseChainId(agentId);
  const responseText = (task?.artifacts as any[])?.[0]?.parts?.[0]?.text
    ?? (task?.history as any[])?.filter?.((m: any) => m.role === 'ROLE_AGENT')?.pop()?.parts?.[0]?.text;
  return {
    success: true,
    agentId,
    chain: getChainName(chainId),
    taskId: task?.id ?? task?.taskId,
    status: task?.status,
    response: responseText ?? task,
  };
}

// ============================================================================
// TASK RETRIEVAL (Direct HTTP — no SDK dependency)
// ============================================================================

/**
 * Build Bearer auth headers using the derived wallet mcpwt_ token.
 * Allows the task-owner wallet to read its own tasks without paying x402
 * each time. The target A2A gateway's optionalAuth will identify the wallet
 * via ecrecover and match it against the task's owner.
 */
async function buildAuthHeaders(a2aVersion: string): Promise<Record<string, string>> {
  const headers: Record<string, string> = { 'A2A-Version': a2aVersion };
  const token = await getDerivedWalletToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

async function handleListTasks(
  args: Record<string, unknown>,
): Promise<unknown> {
  const { sdk, error } = await requireAuth();
  if (error || !sdk) return { error };

  const agentId = args.agentId as string;
  const agentSummary = await sdk.getAgent(agentId);
  if (!agentSummary?.a2a) {
    return { error: `Agent ${agentId} not found or has no A2A endpoint` };
  }

  const { baseUrl, a2aVersion } = await resolveA2aEndpoint(agentSummary.a2a);
  const res = await fetch(`${baseUrl}/tasks`, {
    headers: await buildAuthHeaders(a2aVersion),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    return { agentId, count: 0, tasks: [], note: `HTTP ${res.status}` };
  }
  const data = await res.json() as any;
  const tasks = data.result?.tasks ?? data.tasks ?? [];
  return { agentId, count: tasks.length, tasks };
}

async function handleGetTask(
  args: Record<string, unknown>,
): Promise<unknown> {
  const { sdk, error } = await requireAuth();
  if (error || !sdk) return { error };

  const agentId = args.agentId as string;
  const taskId = args.taskId as string;
  const agentSummary = await sdk.getAgent(agentId);
  if (!agentSummary?.a2a) {
    return { error: `Agent ${agentId} not found or has no A2A endpoint` };
  }

  const { baseUrl, a2aVersion } = await resolveA2aEndpoint(agentSummary.a2a);
  const res = await fetch(`${baseUrl}/tasks/${taskId}`, {
    headers: await buildAuthHeaders(a2aVersion),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    return { agentId, taskId, error: `HTTP ${res.status}` };
  }
  const data = await res.json() as any;
  const task = data.task ?? data.result ?? data;
  return formatTaskResult(agentId, task);
}

async function handleQueryTask(
  args: Record<string, unknown>,
): Promise<unknown> {
  // Query task is the same as get task with optional historyLength param
  const { sdk, error } = await requireAuth();
  if (error || !sdk) return { error };

  const agentId = args.agentId as string;
  const taskId = args.taskId as string;
  const historyLength = args.historyLength as number | undefined;
  const agentSummary = await sdk.getAgent(agentId);
  if (!agentSummary?.a2a) {
    return { error: `Agent ${agentId} not found or has no A2A endpoint` };
  }

  const { baseUrl, a2aVersion } = await resolveA2aEndpoint(agentSummary.a2a);
  const qs = historyLength !== undefined ? `?historyLength=${historyLength}` : '';
  const res = await fetch(`${baseUrl}/tasks/${taskId}${qs}`, {
    headers: await buildAuthHeaders(a2aVersion),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    return { agentId, taskId, error: `HTTP ${res.status}` };
  }
  const data = await res.json() as any;
  const task = data.task ?? data.result ?? data;
  return {
    agentId,
    taskId,
    status: task?.status,
    messages: task?.history ?? task?.messages ?? [],
    artifacts: task?.artifacts ?? [],
    response: (task?.artifacts as any[])?.[0]?.parts?.[0]?.text,
  };
}

async function handleTaskMessage(
  args: Record<string, unknown>,
): Promise<unknown> {
  const { sdk, error } = await requireAuth();
  if (error || !sdk) return { error };

  const agentId = args.agentId as string;
  const taskId = args.taskId as string;
  const message = args.message as string;

  const agentSummary = await sdk.getAgent(agentId);
  if (!agentSummary) {
    return { error: `Agent ${agentId} not found` };
  }
  if (!agentSummary.a2a) {
    return { error: `Agent ${agentId} does not have an A2A endpoint` };
  }

  // Direct HTTP approach (same as handleSendMessage)
  const { baseUrl, a2aVersion } = await resolveA2aEndpoint(agentSummary.a2a);

  const body = {
    jsonrpc: '2.0' as const,
    id: `msg-${Date.now()}`,
    method: 'SendMessage',
    params: {
      message: { role: 'ROLE_USER', parts: [{ text: message }], taskId },
    },
  };
  const messageSendUrl = `${baseUrl}/message:send`;

  // Try without payment first
  const initialRes = await fetch(messageSendUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'A2A-Version': a2aVersion },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });

  if (initialRes.ok) {
    const data = await initialRes.json() as Record<string, unknown>;
    const task = (data as any).task ?? (data as any).result ?? data;
    return formatTaskResult(agentId, task);
  }

  if (initialRes.status !== 402) {
    return { success: false, error: `A2A request failed: HTTP ${initialRes.status}` };
  }

  // Sign and retry with x402 payment
  const challengeBody = await initialRes.json() as Record<string, unknown>;
  const accepts = (challengeBody as any)?.data?.accepts ?? (challengeBody as any)?.accepts ?? [];
  const x402Deps = sdk.getX402RequestDeps?.();
  if (!x402Deps?.buildPayment || !accepts.length) {
    return { success: false, error: 'Cannot pay for A2A message — no payment capability or empty accepts' };
  }

  let paymentHeader: string;
  try {
    paymentHeader = await x402Deps.buildPayment(accepts[0], { url: messageSendUrl, method: 'POST', x402Version: 2 });
  } catch (e) {
    return { success: false, error: `x402 payment signing failed: ${(e as Error).message}`, agentId };
  }

  const paidRes = await fetch(messageSendUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'A2A-Version': a2aVersion, 'PAYMENT-SIGNATURE': paymentHeader },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });

  if (!paidRes.ok) {
    const text = await paidRes.text();
    return { success: false, error: `A2A paid request failed: HTTP ${paidRes.status}`, detail: text.slice(0, 300) };
  }

  const data = await paidRes.json() as Record<string, unknown>;
  let task = (data as any).task ?? (data as any).result ?? data;

  // Poll for completion if SUBMITTED — same pattern as handleSendMessage.
  const newTaskId = task?.id ?? task?.taskId;
  if (newTaskId && isSubmittedState(task)) {
    const bearer = await getDerivedWalletToken();
    task = await pollForCompletion(baseUrl, a2aVersion, newTaskId, bearer) ?? task;
  }

  return formatTaskResult(agentId, task);
}

async function handleCancelTask(
  args: Record<string, unknown>,
): Promise<unknown> {
  const { sdk, error } = await requireAuth();
  if (error || !sdk) return { error };

  const agentId = args.agentId as string;
  const taskId = args.taskId as string;

  const agentSummary = await sdk.getAgent(agentId);
  if (!agentSummary) {
    return { error: `Agent ${agentId} not found` };
  }
  if (!agentSummary.a2a) {
    return { error: `Agent ${agentId} does not have an A2A endpoint` };
  }

  const a2aClient = sdk.createA2AClient(agentSummary);
  const result = await (a2aClient as any).cancelTask(taskId);

  return {
    success: true,
    agentId,
    taskId,
    cancelled: true,
    result: result ?? {},
  };
}

// ============================================================================
// DISPATCH
// ============================================================================

export async function handleA2ATool(
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "a2a_send_message":
      return handleSendMessage(args);
    case "a2a_list_tasks":
      return handleListTasks(args);
    case "a2a_get_task":
      return handleGetTask(args);
    case "a2a_query_task":
      return handleQueryTask(args);
    case "a2a_task_message":
      return handleTaskMessage(args);
    case "a2a_cancel_task":
      return handleCancelTask(args);
    default:
      return { error: `Unknown A2A tool: ${name}` };
  }
}
