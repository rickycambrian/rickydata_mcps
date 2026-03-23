import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  getAuthenticatedSDK,
  hasAuthentication,
  getAuthStatus,
  setDerivedKey,
  setChainId,
} from "../auth/sdk-client.js";
import {
  getDerivationMessage,
  deriveWalletFromSignature,
  verifyDerivationSignature,
} from "../auth/wallet-derivation.js";
import { getChainName } from "../utils/chains.js";

export const registrationTools: Tool[] = [
  {
    name: "configure_wallet",
    description:
      "Configure wallet for ERC-8004 write operations (register, feedback, etc.). " +
      "Provide either a private key directly OR a wallet signature for key derivation. " +
      "Also sets the target chain. Must be called before any write operation.",
    inputSchema: {
      type: "object" as const,
      properties: {
        privateKey: {
          type: "string",
          description:
            "Hex private key (0x-prefixed). Use this if you have a dedicated agent key.",
        },
        signature: {
          type: "string",
          description:
            "Wallet signature of the derivation message (from personal_sign). " +
            "Use get_derivation_message first, then sign it with your wallet.",
        },
        signerAddress: {
          type: "string",
          description:
            "The wallet address that produced the signature (for verification).",
        },
        chainId: {
          type: "number",
          description:
            "Target chain ID (default: 11155111 Sepolia). Use 1 for Ethereum Mainnet, 8453 for Base.",
        },
      },
    },
  },
  {
    name: "get_derivation_message",
    description:
      "Get the message that must be signed with your wallet to derive an ERC-8004 agent key. " +
      "Sign this message with personal_sign, then pass the signature to configure_wallet.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "get_auth_status",
    description:
      "Check if a wallet is configured for write operations. " +
      "Shows key source, chain ID, and whether the SDK is in read-only mode.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "register_agent",
    description:
      "Register a new AI agent on-chain via ERC-8004. Requires configured wallet. " +
      "Creates the agent with name, description, endpoints, and capabilities. " +
      "Returns the on-chain agent ID and URI.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description: "Agent name",
        },
        description: {
          type: "string",
          description: "Agent description",
        },
        image: {
          type: "string",
          description: "Agent image URL (optional)",
        },
        mcpEndpoint: {
          type: "string",
          description: "MCP server endpoint URL (optional)",
        },
        a2aEndpoint: {
          type: "string",
          description: "A2A agent card URL (optional)",
        },
        active: {
          type: "boolean",
          description: "Set agent as active (default: true)",
        },
        x402support: {
          type: "boolean",
          description: "Agent supports x402 payments (default: false)",
        },
        trustReputation: {
          type: "boolean",
          description: "Enable reputation trust model (default: true)",
        },
        trustCryptoEconomic: {
          type: "boolean",
          description: "Enable crypto-economic trust model (default: false)",
        },
        trustTEE: {
          type: "boolean",
          description: "Enable TEE attestation trust model (default: false)",
        },
        metadata: {
          type: "object",
          description: "Additional metadata key-value pairs",
        },
        registrationMethod: {
          type: "string",
          enum: ["ipfs", "onchain"],
          description:
            "Registration method: 'ipfs' (default, stores on IPFS) or 'onchain' (data URI, higher gas)",
        },
      },
      required: ["name", "description"],
    },
  },
  {
    name: "update_agent",
    description:
      "Update an existing agent's properties (description, endpoints, metadata). " +
      "Requires configured wallet and agent ownership.",
    inputSchema: {
      type: "object" as const,
      properties: {
        agentId: {
          type: "string",
          description: "Agent ID in chainId:tokenId format",
        },
        description: {
          type: "string",
          description: "Updated description",
        },
        image: {
          type: "string",
          description: "Updated image URL",
        },
        mcpEndpoint: {
          type: "string",
          description: "Updated MCP endpoint",
        },
        a2aEndpoint: {
          type: "string",
          description: "Updated A2A endpoint",
        },
        active: {
          type: "boolean",
          description: "Set agent active/inactive",
        },
        metadata: {
          type: "object",
          description: "Metadata to merge (key-value pairs)",
        },
      },
      required: ["agentId"],
    },
  },
];

// ============================================================================
// HANDLERS
// ============================================================================

async function requireAuth(): Promise<{ sdk: any; error?: string }> {
  if (!hasAuthentication()) {
    return {
      sdk: null,
      error:
        "No wallet configured. Call configure_wallet first with a private key or signature.",
    };
  }
  const sdk = await getAuthenticatedSDK();
  if (!sdk) {
    return { sdk: null, error: "Failed to initialize authenticated SDK." };
  }
  return { sdk };
}

async function handleConfigureWallet(
  args: Record<string, unknown>,
): Promise<unknown> {
  // Set chain if provided
  if (args.chainId) {
    setChainId(args.chainId as number);
  }

  if (args.privateKey) {
    // Direct private key
    const key = args.privateKey as string;
    if (!key.startsWith("0x") || key.length !== 66) {
      return { error: "Invalid private key format. Must be 0x-prefixed 32-byte hex." };
    }
    setDerivedKey(key);
    const status = getAuthStatus();
    return {
      success: true,
      method: "direct_key",
      chainId: status.chainId,
      chain: getChainName(status.chainId),
    };
  }

  if (args.signature) {
    const signature = args.signature as string;
    const signerAddress = args.signerAddress as string | undefined;

    // Verify signature if address provided
    if (signerAddress) {
      const valid = verifyDerivationSignature(signature, signerAddress);
      if (!valid) {
        return {
          error: `Signature verification failed. The signature was not produced by ${signerAddress}.`,
        };
      }
    }

    // Derive key from signature
    const derived = deriveWalletFromSignature(signature);
    setDerivedKey(derived.privateKey);

    const status = getAuthStatus();
    return {
      success: true,
      method: "derived_from_signature",
      derivedAddress: derived.address,
      chainId: status.chainId,
      chain: getChainName(status.chainId),
      note: "Derived address is your ERC-8004 agent identity. It is deterministic from your wallet signature.",
    };
  }

  // No key or signature — just set chain
  if (args.chainId) {
    return {
      success: true,
      method: "chain_only",
      chainId: args.chainId,
      chain: getChainName(args.chainId as number),
      note: "Chain updated. No signing key configured — read-only mode.",
    };
  }

  return {
    error:
      "Provide either privateKey or signature. Use get_derivation_message to get the message to sign.",
  };
}

async function handleRegisterAgent(
  args: Record<string, unknown>,
): Promise<unknown> {
  const { sdk, error } = await requireAuth();
  if (error || !sdk) return { error };

  const agent = sdk.createAgent(
    args.name as string,
    args.description as string,
    (args.image as string) ?? undefined,
  );

  // Configure endpoints
  if (args.mcpEndpoint) {
    await agent.setMCP(args.mcpEndpoint as string);
  }
  if (args.a2aEndpoint) {
    await agent.setA2A(args.a2aEndpoint as string);
  }

  // Trust models
  agent.setTrust(
    (args.trustReputation as boolean) ?? true,
    (args.trustCryptoEconomic as boolean) ?? false,
    (args.trustTEE as boolean) ?? false,
  );

  // Active status
  agent.setActive((args.active as boolean) ?? true);

  // Metadata
  if (args.metadata) {
    agent.setMetadata(args.metadata as Record<string, unknown>);
  }

  // Register
  const method = (args.registrationMethod as string) ?? "ipfs";
  const tx =
    method === "onchain"
      ? await agent.registerOnChain()
      : await agent.registerIPFS();
  const mined = await tx.waitConfirmed({ timeoutMs: 180_000 });
  const regFile = mined.result;

  return {
    success: true,
    agentId: regFile.agentId,
    agentURI: regFile.agentURI,
    txHash: mined.receipt.transactionHash,
    method,
    chain: getChainName(await sdk.chainId()),
  };
}

async function handleUpdateAgent(
  args: Record<string, unknown>,
): Promise<unknown> {
  const { sdk, error } = await requireAuth();
  if (error || !sdk) return { error };

  const agentId = args.agentId as string;
  if (!agentId) return { error: "agentId is required" };

  const agent = await sdk.loadAgent(agentId);

  if (args.description !== undefined) {
    agent.updateInfo(undefined, args.description as string, undefined);
  }
  if (args.image !== undefined) {
    agent.updateInfo(undefined, undefined, args.image as string);
  }
  if (args.mcpEndpoint) {
    await agent.setMCP(args.mcpEndpoint as string);
  }
  if (args.a2aEndpoint) {
    await agent.setA2A(args.a2aEndpoint as string);
  }
  if (args.active !== undefined) {
    agent.setActive(args.active as boolean);
  }
  if (args.metadata) {
    agent.setMetadata(args.metadata as Record<string, unknown>);
  }

  // Re-register to update
  const tx = await agent.registerIPFS();
  const mined = await tx.waitConfirmed({ timeoutMs: 180_000 });
  const regFile = mined.result;

  return {
    success: true,
    agentId,
    agentURI: regFile.agentURI,
    txHash: mined.receipt.transactionHash,
    chain: getChainName(await sdk.chainId()),
  };
}

// ============================================================================
// DISPATCH
// ============================================================================

export async function handleRegistrationTool(
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "configure_wallet":
      return handleConfigureWallet(args);
    case "get_derivation_message":
      return {
        message: getDerivationMessage(),
        instructions:
          "Sign this message with personal_sign using your wallet, " +
          "then pass the signature to configure_wallet.",
      };
    case "get_auth_status":
      return getAuthStatus();
    case "register_agent":
      return handleRegisterAgent(args);
    case "update_agent":
      return handleUpdateAgent(args);
    default:
      return { error: `Unknown registration tool: ${name}` };
  }
}
