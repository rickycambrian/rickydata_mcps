import type { Tool } from "@modelcontextprotocol/sdk/types.js";
// Dynamic type - FeedbackFileInput used inline
import {
  getAuthenticatedSDK,
  getReadOnlySDK,
  hasAuthentication,
} from "../auth/sdk-client.js";
import { getChainName } from "../utils/chains.js";

export const reputationTools: Tool[] = [
  {
    name: "get_feedback",
    description:
      "Get a specific feedback entry for an agent by reviewer address and feedback index. " +
      "Returns the full feedback details including score, tags, text, and revocation status.",
    inputSchema: {
      type: "object" as const,
      properties: {
        agentId: {
          type: "string",
          description: "Agent ID in chainId:tokenId format (e.g. '11155111:42')",
        },
        clientAddress: {
          type: "string",
          description: "Reviewer wallet address (0x-prefixed)",
        },
        feedbackIndex: {
          type: "number",
          description: "Feedback index from the reviewer's feedback list",
        },
      },
      required: ["agentId", "clientAddress", "feedbackIndex"],
    },
  },
  {
    name: "append_feedback_response",
    description:
      "Append an owner response to existing feedback. Only the agent owner can respond. " +
      "Requires configured wallet and agent ownership. Response is stored on IPFS.",
    inputSchema: {
      type: "object" as const,
      properties: {
        agentId: {
          type: "string",
          description: "Agent ID in chainId:tokenId format",
        },
        clientAddress: {
          type: "string",
          description: "Reviewer wallet address whose feedback to respond to",
        },
        feedbackIndex: {
          type: "number",
          description: "Feedback index to respond to",
        },
        responseText: {
          type: "string",
          description: "Response text from the agent owner",
        },
      },
      required: ["agentId", "clientAddress", "feedbackIndex", "responseText"],
    },
  },
  {
    name: "give_feedback",
    description:
      "Submit on-chain feedback/review for an ERC-8004 agent. Requires configured wallet. " +
      "Creates a permanent, verifiable review with a score (0-100), tags, and optional text.",
    inputSchema: {
      type: "object" as const,
      properties: {
        agentId: {
          type: "string",
          description: "Agent ID in chainId:tokenId format (e.g. '11155111:42')",
        },
        value: {
          type: "number",
          description: "Feedback score from 0 (worst) to 100 (best)",
        },
        tag1: {
          type: "string",
          description: "Primary tag (e.g. 'quality', 'reliability', 'enterprise')",
        },
        tag2: {
          type: "string",
          description: "Secondary tag (optional)",
        },
        endpoint: {
          type: "string",
          description: "Specific endpoint being reviewed (optional)",
        },
        text: {
          type: "string",
          description: "Free-text review content (stored off-chain via IPFS)",
        },
        mcpTool: {
          type: "string",
          description: "Specific MCP tool being reviewed (optional)",
        },
        a2aSkills: {
          type: "array",
          items: { type: "string" },
          description: "A2A skills being reviewed (optional)",
        },
      },
      required: ["agentId", "value"],
    },
  },
  {
    name: "revoke_feedback",
    description:
      "Revoke previously submitted feedback. Only the original reviewer can revoke. " +
      "Requires configured wallet.",
    inputSchema: {
      type: "object" as const,
      properties: {
        agentId: {
          type: "string",
          description: "Agent ID in chainId:tokenId format",
        },
        feedbackIndex: {
          type: "number",
          description: "The feedback index to revoke (from the reviewer's feedback list)",
        },
      },
      required: ["agentId", "feedbackIndex"],
    },
  },
];

// ============================================================================
// HANDLERS
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

async function handleGetFeedback(
  args: Record<string, unknown>,
): Promise<unknown> {
  const agentId = args.agentId as string;
  const clientAddress = args.clientAddress as string;
  const feedbackIndex = args.feedbackIndex as number;

  if (!agentId) return { error: "agentId is required" };
  if (!clientAddress) return { error: "clientAddress is required" };
  if (feedbackIndex === undefined) return { error: "feedbackIndex is required" };

  const parts = agentId.split(":");
  const chainId = parts.length === 2 ? parseInt(parts[0], 10) : 11155111;
  const sdk = await getReadOnlySDK(chainId);

  const feedback = await sdk.getFeedback(agentId, clientAddress, feedbackIndex);
  if (!feedback) {
    return { error: `Feedback not found for agent ${agentId}, reviewer ${clientAddress}, index ${feedbackIndex}` };
  }

  return {
    agentId,
    clientAddress,
    feedbackIndex,
    chain: getChainName(chainId),
    feedback: {
      value: feedback.value,
      tags: feedback.tags,
      text: feedback.text,
      endpoint: feedback.endpoint,
      mcpTool: feedback.mcpTool,
      a2aSkills: feedback.a2aSkills,
      isRevoked: feedback.isRevoked,
      createdAt: feedback.createdAt,
      response: feedback.response ?? null,
    },
  };
}

async function handleAppendFeedbackResponse(
  args: Record<string, unknown>,
): Promise<unknown> {
  const { sdk, error } = await requireAuth();
  if (error || !sdk) return { error };

  const agentId = args.agentId as string;
  const clientAddress = args.clientAddress as string;
  const feedbackIndex = args.feedbackIndex as number;
  const responseText = args.responseText as string;

  if (!agentId) return { error: "agentId is required" };
  if (!clientAddress) return { error: "clientAddress is required" };
  if (feedbackIndex === undefined) return { error: "feedbackIndex is required" };
  if (!responseText) return { error: "responseText is required" };

  const parts = agentId.split(":");
  const chainId = parts.length === 2 ? parseInt(parts[0], 10) : await sdk.chainId();

  // Upload response to IPFS and append on-chain
  const tx = await sdk.appendResponse(agentId, clientAddress, feedbackIndex, {
    text: responseText,
  });
  const mined = await tx.waitConfirmed({ timeoutMs: 120_000 });

  return {
    success: true,
    agentId,
    clientAddress,
    feedbackIndex,
    txHash: mined.receipt.transactionHash,
    chain: getChainName(chainId),
  };
}

async function handleGiveFeedback(
  args: Record<string, unknown>,
): Promise<unknown> {
  const { sdk, error } = await requireAuth();
  if (error || !sdk) return { error };

  const agentId = args.agentId as string;
  const value = args.value as number;

  if (value < 0 || value > 100) {
    return { error: "Feedback value must be between 0 and 100" };
  }

  // Build off-chain feedback file if rich fields provided
  let feedbackFile: any;
  if (args.text || args.mcpTool || args.a2aSkills) {
    feedbackFile = sdk.prepareFeedbackFile({
      text: args.text as string | undefined,
      mcpTool: args.mcpTool as string | undefined,
      a2aSkills: args.a2aSkills as string[] | undefined,
    });
  }

  const tx = await sdk.giveFeedback(
    agentId,
    value,
    (args.tag1 as string) ?? undefined,
    (args.tag2 as string) ?? undefined,
    (args.endpoint as string) ?? undefined,
    feedbackFile,
  );

  const mined = await tx.waitConfirmed({ timeoutMs: 120_000 });

  const parts = agentId.split(":");
  const chainId = parts.length === 2 ? parseInt(parts[0], 10) : await sdk.chainId();

  return {
    success: true,
    agentId,
    value,
    tags: [args.tag1, args.tag2].filter(Boolean),
    txHash: mined.receipt.transactionHash,
    chain: getChainName(chainId),
  };
}

async function handleRevokeFeedback(
  args: Record<string, unknown>,
): Promise<unknown> {
  const { sdk, error } = await requireAuth();
  if (error || !sdk) return { error };

  const agentId = args.agentId as string;
  const feedbackIndex = args.feedbackIndex as number;

  const tx = await sdk.revokeFeedback(agentId, feedbackIndex);
  const mined = await tx.waitConfirmed({ timeoutMs: 120_000 });

  const parts = agentId.split(":");
  const chainId = parts.length === 2 ? parseInt(parts[0], 10) : await sdk.chainId();

  return {
    success: true,
    agentId,
    feedbackIndex,
    txHash: mined.receipt.transactionHash,
    isRevoked: true,
    chain: getChainName(chainId),
  };
}

// ============================================================================
// DISPATCH
// ============================================================================

export async function handleReputationTool(
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "get_feedback":
      return handleGetFeedback(args);
    case "append_feedback_response":
      return handleAppendFeedbackResponse(args);
    case "give_feedback":
      return handleGiveFeedback(args);
    case "revoke_feedback":
      return handleRevokeFeedback(args);
    default:
      return { error: `Unknown reputation tool: ${name}` };
  }
}
