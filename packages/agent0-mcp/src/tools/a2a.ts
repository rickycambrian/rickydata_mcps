import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  getAuthenticatedSDK,
  getReadOnlySDK,
  hasAuthentication,
} from "../auth/sdk-client.js";
import { getChainName } from "../utils/chains.js";

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
];

// ============================================================================
// HELPERS
// ============================================================================

function requireAuth() {
  if (!hasAuthentication()) {
    return {
      sdk: null as ReturnType<typeof getAuthenticatedSDK>,
      error: "No wallet configured. Call configure_wallet first.",
    };
  }
  const sdk = await getAuthenticatedSDK();
  if (!sdk) {
    return { sdk: null as ReturnType<typeof getAuthenticatedSDK>, error: "Failed to initialize authenticated SDK." };
  }
  return { sdk, error: undefined };
}

function parseChainId(agentId: string): number {
  const parts = agentId.split(":");
  return parts.length === 2 ? parseInt(parts[0], 10) : 11155111;
}

// ============================================================================
// HANDLERS
// ============================================================================

async function handleSendMessage(
  args: Record<string, unknown>,
): Promise<unknown> {
  const { sdk, error } = requireAuth();
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

  // Create A2A client from summary
  const a2aClient = sdk.createA2AClient(agentSummary);

  // Send message
  const result = await (a2aClient as any).messageA2A(message, {
    taskId: (args.taskId as string) ?? undefined,
  });

  const chainId = parseChainId(agentId);
  return {
    success: true,
    agentId,
    chain: getChainName(chainId),
    taskId: result?.taskId ?? result?.id,
    status: result?.status,
    response: result?.response ?? result?.text ?? result,
  };
}

async function handleListTasks(
  args: Record<string, unknown>,
): Promise<unknown> {
  const { sdk, error } = requireAuth();
  if (error || !sdk) return { error };

  const agentId = args.agentId as string;
  const agentSummary = await sdk.getAgent(agentId);
  if (!agentSummary) {
    return { error: `Agent ${agentId} not found` };
  }
  if (!agentSummary.a2a) {
    return { error: `Agent ${agentId} does not have an A2A endpoint` };
  }

  const a2aClient = sdk.createA2AClient(agentSummary);
  const tasks = await (a2aClient as any).listTasks();

  return {
    agentId,
    count: Array.isArray(tasks) ? tasks.length : 0,
    tasks: tasks ?? [],
  };
}

async function handleGetTask(
  args: Record<string, unknown>,
): Promise<unknown> {
  const { sdk, error } = requireAuth();
  if (error || !sdk) return { error };

  const agentId = args.agentId as string;
  const taskId = args.taskId as string;

  const agentSummary = await sdk.getAgent(agentId);
  if (!agentSummary) {
    return { error: `Agent ${agentId} not found` };
  }

  const a2aClient = sdk.createA2AClient(agentSummary);
  const task = await (a2aClient as any).loadTask(taskId);

  return {
    agentId,
    taskId,
    task: task ?? { error: "Task not found" },
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
    default:
      return { error: `Unknown A2A tool: ${name}` };
  }
}
