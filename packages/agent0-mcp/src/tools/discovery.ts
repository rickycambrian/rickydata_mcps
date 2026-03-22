import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { computeTrustLabel } from "../utils/trust-labels.js";
import { getChainName, CHAINS } from "../utils/chains.js";

// ============================================================================
// SDK INITIALIZATION (read-only, no private key needed)
// Lazy import to avoid module-level network calls from agent0-sdk
// ============================================================================

const DEFAULT_CHAIN_ID = parseInt(process.env.AGENT0_CHAIN_ID || "11155111", 10);

async function getReadOnlySDK(chainId?: number): Promise<any> {
  const { SDK } = await import("agent0-sdk");
  return new SDK({ chainId: chainId ?? DEFAULT_CHAIN_ID });
}

// ============================================================================
// RESPONSE HELPERS
// ============================================================================

function formatAgentSummary(agent: Record<string, unknown>): Record<string, unknown> {
  const count = (agent.feedbackCount as number) ?? 0;
  const avg = (agent.averageValue as number) ?? 0;
  const trust = computeTrustLabel(count, avg);

  return {
    agentId: agent.agentId,
    chainId: agent.chainId,
    name: agent.name,
    description: agent.description,
    image: agent.image,
    active: agent.active,
    x402support: agent.x402support,
    owners: agent.owners,
    walletAddress: agent.walletAddress,
    mcp: agent.mcp || null,
    a2a: agent.a2a || null,
    web: agent.web || null,
    ens: agent.ens || null,
    mcpTools: agent.mcpTools,
    a2aSkills: agent.a2aSkills,
    oasfSkills: agent.oasfSkills,
    oasfDomains: agent.oasfDomains,
    supportedTrusts: agent.supportedTrusts,
    trust: trust.display,
    feedbackCount: count,
    averageValue: avg,
    updatedAt: agent.updatedAt,
  };
}

// ============================================================================
// TOOL DEFINITIONS
// ============================================================================

export const discoveryTools: Tool[] = [
  {
    name: "search_agents",
    description:
      "Search for ERC-8004 registered AI agents by name, capabilities, tools, skills, or reputation. " +
      "Returns agent summaries with trust labels. Supports multi-chain search.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description: "Substring match on agent name",
        },
        keyword: {
          type: "string",
          description: "Keyword search across agent metadata",
        },
        mcpTools: {
          type: "array",
          items: { type: "string" },
          description: "Filter by MCP tool names the agent exposes",
        },
        a2aSkills: {
          type: "array",
          items: { type: "string" },
          description: "Filter by A2A skills",
        },
        oasfSkills: {
          type: "array",
          items: { type: "string" },
          description: "Filter by OASF taxonomy skills",
        },
        oasfDomains: {
          type: "array",
          items: { type: "string" },
          description: "Filter by OASF taxonomy domains",
        },
        active: {
          type: "boolean",
          description: "Filter by active status (default: true)",
        },
        x402support: {
          type: "boolean",
          description: "Filter by x402 payment support",
        },
        hasMCP: {
          type: "boolean",
          description: "Only agents with an MCP endpoint",
        },
        hasA2A: {
          type: "boolean",
          description: "Only agents with an A2A endpoint",
        },
        chains: {
          type: "array",
          items: { type: "number" },
          description:
            "Chain IDs to search (default: [11155111]). Use [1, 8453, 137, 11155111] for all supported chains.",
        },
        minFeedbackValue: {
          type: "number",
          description: "Minimum average feedback score (0-100)",
        },
        limit: {
          type: "number",
          description: "Max results to return (default: 20, max: 100)",
        },
      },
    },
  },
  {
    name: "get_agent",
    description:
      "Get detailed information about a specific ERC-8004 agent by its ID (format: chainId:tokenId, e.g. '11155111:42'). " +
      "Returns full agent profile with endpoints, tools, skills, trust label, and reputation summary.",
    inputSchema: {
      type: "object" as const,
      properties: {
        agentId: {
          type: "string",
          description:
            "Agent ID in chainId:tokenId format (e.g. '11155111:42' or '1:123')",
        },
      },
      required: ["agentId"],
    },
  },
  {
    name: "get_supported_chains",
    description:
      "List all blockchain networks that support ERC-8004 agent registration. " +
      "Returns chain IDs, names, registry contract addresses, and subgraph URLs.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "get_platform_stats",
    description:
      "Get aggregate statistics about the ERC-8004 agent ecosystem on a specific chain. " +
      "Returns total agents, active count, agents with MCP/A2A endpoints, and x402 support count.",
    inputSchema: {
      type: "object" as const,
      properties: {
        chainId: {
          type: "number",
          description:
            "Chain ID to query (default: 11155111 Sepolia). Use 1 for Ethereum Mainnet, 8453 for Base.",
        },
      },
    },
  },
  {
    name: "get_reputation_summary",
    description:
      "Get reputation summary (feedback count and average value) for a specific agent. " +
      "Optionally filter by tag. Returns trust label computation.",
    inputSchema: {
      type: "object" as const,
      properties: {
        agentId: {
          type: "string",
          description:
            "Agent ID in chainId:tokenId format (e.g. '11155111:42')",
        },
        tag: {
          type: "string",
          description: "Optional tag to filter reputation by (e.g. 'enterprise', 'quality')",
        },
      },
      required: ["agentId"],
    },
  },
  {
    name: "search_feedback",
    description:
      "Search feedback/reviews for agents. Can search by agent ID, reviewer wallet, tags, " +
      "or across multiple agents. Returns individual feedback entries with scores and metadata.",
    inputSchema: {
      type: "object" as const,
      properties: {
        agentId: {
          type: "string",
          description: "Agent ID to search feedback for (chainId:tokenId format)",
        },
        agents: {
          type: "array",
          items: { type: "string" },
          description: "Multiple agent IDs to search feedback across",
        },
        reviewers: {
          type: "array",
          items: { type: "string" },
          description: "Filter by reviewer wallet addresses",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Filter by feedback tags",
        },
        minValue: {
          type: "number",
          description: "Minimum feedback value (0-100)",
        },
        maxValue: {
          type: "number",
          description: "Maximum feedback value (0-100)",
        },
        includeRevoked: {
          type: "boolean",
          description: "Include revoked feedback (default: false)",
        },
      },
    },
  },
];

// ============================================================================
// TOOL HANDLERS
// ============================================================================

async function handleSearchAgents(
  args: Record<string, unknown>,
): Promise<unknown> {
  const limit = Math.min(
    Math.max(1, (args.limit as number) ?? 20),
    100,
  );

  const chainId = (args.chains as number[] | undefined)?.[0] ?? DEFAULT_CHAIN_ID;
  const sdk = await getReadOnlySDK(chainId);

  const filters: Record<string, unknown> = {};
  if (args.name) filters.name = args.name;
  if (args.keyword) filters.keyword = args.keyword;
  if (args.mcpTools) filters.mcpTools = args.mcpTools;
  if (args.a2aSkills) filters.a2aSkills = args.a2aSkills;
  if (args.oasfSkills) filters.oasfSkills = args.oasfSkills;
  if (args.oasfDomains) filters.oasfDomains = args.oasfDomains;
  if (args.active !== undefined) filters.active = args.active;
  if (args.x402support !== undefined) filters.x402support = args.x402support;
  if (args.hasMCP !== undefined) filters.hasMCP = args.hasMCP;
  if (args.hasA2A !== undefined) filters.hasA2A = args.hasA2A;
  if (args.chains) filters.chains = args.chains;
  if (args.minFeedbackValue) {
    filters.feedback = {
      minValue: args.minFeedbackValue,
      includeRevoked: false,
    };
  }

  const results = await sdk.searchAgents(
    filters,
    { sort: ["updatedAt:desc"] },
  );

  const agents = results.slice(0, limit).map((a) =>
    formatAgentSummary(a as unknown as Record<string, unknown>),
  );

  return {
    count: agents.length,
    totalAvailable: results.length,
    chainId,
    agents,
  };
}

async function handleGetAgent(
  args: Record<string, unknown>,
): Promise<unknown> {
  const agentId = args.agentId as string;
  if (!agentId) return { error: "agentId is required (format: chainId:tokenId)" };

  const parts = agentId.split(":");
  if (parts.length !== 2) {
    return { error: "Invalid agentId format. Use chainId:tokenId (e.g. '11155111:42')" };
  }

  const chainId = parseInt(parts[0], 10);
  const sdk = await getReadOnlySDK(chainId);
  const agent = await sdk.getAgent(agentId);

  if (!agent) {
    return { error: `Agent ${agentId} not found` };
  }

  // Get reputation summary
  let reputation = { count: 0, averageValue: 0 };
  try {
    reputation = await sdk.getReputationSummary(agentId);
  } catch {
    // Reputation may not be available for all agents
  }

  const trust = computeTrustLabel(reputation.count, reputation.averageValue);
  const summary = formatAgentSummary(agent as unknown as Record<string, unknown>);

  return {
    ...summary,
    reputation: {
      count: reputation.count,
      averageValue: reputation.averageValue,
      trustLabel: trust.label,
      trustDisplay: trust.display,
    },
    chain: getChainName(chainId),
  };
}

async function handleGetSupportedChains(): Promise<unknown> {
  const chains = [
    {
      chainId: 1,
      name: "Ethereum Mainnet",
      identity: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
      reputation: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63",
      hasSubgraph: true,
    },
    {
      chainId: 8453,
      name: "Base",
      identity: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
      reputation: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63",
      hasSubgraph: true,
    },
    {
      chainId: 137,
      name: "Polygon Mainnet",
      identity: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
      reputation: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63",
      hasSubgraph: true,
    },
    {
      chainId: 11155111,
      name: "Ethereum Sepolia (Testnet)",
      identity: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
      reputation: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
      hasSubgraph: true,
    },
    {
      chainId: 84532,
      name: "Base Sepolia (Testnet)",
      identity: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
      reputation: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63",
      hasSubgraph: true,
    },
  ];

  return {
    count: chains.length,
    chains,
    note: "Use chainId:tokenId format when querying agents (e.g. '1:42' for Ethereum Mainnet agent #42)",
  };
}

async function handleGetPlatformStats(
  args: Record<string, unknown>,
): Promise<unknown> {
  const chainId = (args.chainId as number) ?? DEFAULT_CHAIN_ID;
  const sdk = await getReadOnlySDK(chainId);

  // Fetch all agents on this chain (no filter)
  const allAgents = await sdk.searchAgents({}, { sort: ["updatedAt:desc"] });

  let activeCount = 0;
  let mcpCount = 0;
  let a2aCount = 0;
  let x402Count = 0;
  let withFeedback = 0;
  let totalTools = 0;
  let totalSkills = 0;

  for (const agent of allAgents) {
    if (agent.active) activeCount++;
    if (agent.mcp) mcpCount++;
    if (agent.a2a) a2aCount++;
    if (agent.x402support) x402Count++;
    if (agent.feedbackCount && agent.feedbackCount > 0) withFeedback++;
    totalTools += agent.mcpTools?.length ?? 0;
    totalSkills += agent.a2aSkills?.length ?? 0;
  }

  return {
    chainId,
    chain: getChainName(chainId),
    totalAgents: allAgents.length,
    activeAgents: activeCount,
    agentsWithMCP: mcpCount,
    agentsWithA2A: a2aCount,
    agentsWithX402: x402Count,
    agentsWithFeedback: withFeedback,
    totalMCPTools: totalTools,
    totalA2ASkills: totalSkills,
  };
}

async function handleGetReputationSummary(
  args: Record<string, unknown>,
): Promise<unknown> {
  const agentId = args.agentId as string;
  if (!agentId) return { error: "agentId is required" };

  const parts = agentId.split(":");
  if (parts.length !== 2) {
    return { error: "Invalid agentId format. Use chainId:tokenId" };
  }

  const chainId = parseInt(parts[0], 10);
  const sdk = await getReadOnlySDK(chainId);
  const tag = args.tag as string | undefined;

  const reputation = await sdk.getReputationSummary(agentId, tag);
  const trust = computeTrustLabel(reputation.count, reputation.averageValue);

  return {
    agentId,
    chain: getChainName(chainId),
    count: reputation.count,
    averageValue: reputation.averageValue,
    trustLabel: trust.label,
    trustEmoji: trust.emoji,
    trustDisplay: trust.display,
    tag: tag ?? null,
  };
}

async function handleSearchFeedback(
  args: Record<string, unknown>,
): Promise<unknown> {
  const agentId = args.agentId as string | undefined;
  const agents = args.agents as string[] | undefined;

  // Determine chain from first agent ID available
  const firstId = agentId ?? agents?.[0];
  if (!firstId) {
    return { error: "Provide agentId or agents[] to search feedback" };
  }

  const parts = firstId.split(":");
  const chainId = parts.length === 2 ? parseInt(parts[0], 10) : DEFAULT_CHAIN_ID;
  const sdk = await getReadOnlySDK(chainId);

  const filters: Record<string, unknown> = {};
  if (agentId) filters.agentId = agentId;
  if (agents) filters.agents = agents;
  if (args.reviewers) filters.reviewers = args.reviewers;
  if (args.tags) filters.tags = args.tags;
  if (args.includeRevoked !== undefined)
    filters.includeRevoked = args.includeRevoked;

  const options: Record<string, unknown> = {};
  if (args.minValue !== undefined) options.minValue = args.minValue;
  if (args.maxValue !== undefined) options.maxValue = args.maxValue;

  const feedbacks = await sdk.searchFeedback(
    filters as Parameters<typeof sdk.searchFeedback>[0],
    options as Parameters<typeof sdk.searchFeedback>[1],
  );

  return {
    count: feedbacks.length,
    feedbacks: feedbacks.slice(0, 50).map((f) => ({
      agentId: f.agentId,
      reviewer: f.reviewer,
      value: f.value,
      tags: f.tags,
      text: f.text,
      endpoint: f.endpoint,
      isRevoked: f.isRevoked,
      createdAt: f.createdAt,
      mcpTool: f.mcpTool,
      a2aSkills: f.a2aSkills,
    })),
  };
}

// ============================================================================
// DISPATCH
// ============================================================================

export async function handleDiscoveryTool(
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "search_agents":
      return handleSearchAgents(args);
    case "get_agent":
      return handleGetAgent(args);
    case "get_supported_chains":
      return handleGetSupportedChains();
    case "get_platform_stats":
      return handleGetPlatformStats(args);
    case "get_reputation_summary":
      return handleGetReputationSummary(args);
    case "search_feedback":
      return handleSearchFeedback(args);
    default:
      return { error: `Unknown discovery tool: ${name}` };
  }
}
