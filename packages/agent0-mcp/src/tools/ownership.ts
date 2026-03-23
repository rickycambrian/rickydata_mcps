import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  getAuthenticatedSDK,
  getReadOnlySDK,
  hasAuthentication,
} from "../auth/sdk-client.js";
import { getChainName } from "../utils/chains.js";

export const ownershipTools: Tool[] = [
  {
    name: "transfer_agent",
    description:
      "Transfer ownership of an ERC-8004 agent NFT to a new address. " +
      "Requires configured wallet and agent ownership. This is irreversible.",
    inputSchema: {
      type: "object" as const,
      properties: {
        agentId: {
          type: "string",
          description: "Agent ID in chainId:tokenId format (e.g. '11155111:42')",
        },
        newOwnerAddress: {
          type: "string",
          description: "Ethereum address of the new owner (0x-prefixed)",
        },
      },
      required: ["agentId", "newOwnerAddress"],
    },
  },
  {
    name: "get_agent_owner",
    description:
      "Get the current owner address of an ERC-8004 agent. " +
      "Returns the wallet address that owns the agent NFT.",
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
    name: "is_agent_owner",
    description:
      "Check if a specific address (or the configured wallet) owns an ERC-8004 agent. " +
      "If no address is provided, checks the currently configured wallet.",
    inputSchema: {
      type: "object" as const,
      properties: {
        agentId: {
          type: "string",
          description: "Agent ID in chainId:tokenId format",
        },
        address: {
          type: "string",
          description:
            "Address to check (optional — defaults to configured wallet address)",
        },
      },
      required: ["agentId"],
    },
  },
];

// ============================================================================
// HELPERS
// ============================================================================

function parseChainId(agentId: string): number {
  const parts = agentId.split(":");
  return parts.length === 2 ? parseInt(parts[0], 10) : 11155111;
}

async function requireAuth(): Promise<{ sdk: any; error?: string }> {
  if (!hasAuthentication()) {
    return {
      sdk: null,
      error: "No wallet configured. Call configure_wallet first.",
    };
  }
  const sdk = await getAuthenticatedSDK();
  if (!sdk) {
    return { sdk: null, error: "Failed to initialize authenticated SDK." };
  }
  return { sdk };
}

// ============================================================================
// HANDLERS
// ============================================================================

async function handleTransferAgent(
  args: Record<string, unknown>,
): Promise<unknown> {
  const { sdk, error } = await requireAuth();
  if (error || !sdk) return { error };

  const agentId = args.agentId as string;
  const newOwnerAddress = args.newOwnerAddress as string;

  if (!newOwnerAddress || !newOwnerAddress.startsWith("0x") || newOwnerAddress.length !== 42) {
    return { error: "Invalid newOwnerAddress. Must be 0x-prefixed 20-byte Ethereum address." };
  }

  const chainId = parseChainId(agentId);
  const agent = await sdk.loadAgent(agentId);
  const tx = await agent.transfer(newOwnerAddress);
  const mined = await tx.waitConfirmed({ timeoutMs: 180_000 });

  return {
    success: true,
    agentId,
    newOwner: newOwnerAddress,
    txHash: mined.receipt.transactionHash,
    chain: getChainName(chainId),
    warning: "Ownership transfer is irreversible. The new owner now controls this agent.",
  };
}

async function handleGetAgentOwner(
  args: Record<string, unknown>,
): Promise<unknown> {
  const agentId = args.agentId as string;
  if (!agentId) return { error: "agentId is required" };

  const chainId = parseChainId(agentId);
  const sdk = await getReadOnlySDK(chainId);
  const owner = await sdk.getAgentOwner(agentId);

  return {
    agentId,
    owner,
    chain: getChainName(chainId),
  };
}

async function handleIsAgentOwner(
  args: Record<string, unknown>,
): Promise<unknown> {
  const agentId = args.agentId as string;
  if (!agentId) return { error: "agentId is required" };

  const chainId = parseChainId(agentId);
  const address = args.address as string | undefined;

  if (address) {
    // Check specific address — read-only operation
    const sdk = await getReadOnlySDK(chainId);
    const isOwner = await sdk.isAgentOwner(agentId, address);
    return { agentId, address, isOwner, chain: getChainName(chainId) };
  }

  // Check configured wallet
  if (!hasAuthentication()) {
    return {
      error: "No wallet configured and no address provided. Call configure_wallet first or provide an address.",
    };
  }
  const sdk = await getAuthenticatedSDK(chainId);
  if (!sdk) return { error: "Failed to initialize authenticated SDK." };

  const isOwner = await sdk.isAgentOwner(agentId);
  return { agentId, isOwner, chain: getChainName(chainId) };
}

// ============================================================================
// DISPATCH
// ============================================================================

export async function handleOwnershipTool(
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "transfer_agent":
      return handleTransferAgent(args);
    case "get_agent_owner":
      return handleGetAgentOwner(args);
    case "is_agent_owner":
      return handleIsAgentOwner(args);
    default:
      return { error: `Unknown ownership tool: ${name}` };
  }
}
