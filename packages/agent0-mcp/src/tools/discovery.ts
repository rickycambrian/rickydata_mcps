import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { computeTrustLabel } from "../utils/trust-labels.js";
import { getChainName, CHAINS } from "../utils/chains.js";
import {
  getAuthenticatedSDK,
  hasAuthentication,
} from "../auth/sdk-client.js";

// ============================================================================
// SDK INITIALIZATION (read-only, no private key needed)
// Lazy import to avoid module-level network calls from agent0-sdk
// ============================================================================

// Default to Base (8453) — matches x402 payment chain. Discovery tools
// accept chainId param to query other chains (Ethereum, Arbitrum, etc.)
const DEFAULT_CHAIN_ID = parseInt(process.env.AGENT0_CHAIN_ID || "8453", 10);

// The Graph decentralized network rejects skip > 5000. The SDK's _fetchAllAgentsV2
// uses skip-based pagination, so for chains with >6000 agents (Ethereum mainnet
// has 10,000+), it fails on skip=6000 and the SDK's fetchChain() silently
// swallows the error, returning [] for the entire chain.
//
// Fix: use cursor-based pagination (id_gt) which has no skip limit, allowing us
// to retrieve all agents on any chain. Used for get_platform_stats and
// search_agents when no filters are active.

async function getReadOnlySDK(chainId?: number): Promise<any> {
  const { SDK } = await import("agent0-sdk");
  return new SDK({ chainId: chainId ?? DEFAULT_CHAIN_ID });
}

// Cursor-based full fetch that bypasses The Graph's skip > 5000 limit.
// Returns ALL agents with registrationFile on the given chain.
async function fetchAllAgentsGraceful(chainId: number): Promise<any[]> {
  let SubgraphClientClass: any;
  let subgraphUrl: string | undefined;
  try {
    const agent0 = await import("agent0-sdk");
    SubgraphClientClass = agent0.SubgraphClient;
    subgraphUrl = (agent0.DEFAULT_SUBGRAPH_URLS as Record<number, string>)[chainId];
  } catch {
    const sdk = await getReadOnlySDK(chainId);
    return sdk.searchAgents({}, { sort: ["updatedAt:desc"] });
  }

  if (!SubgraphClientClass || !subgraphUrl) {
    const sdk = await getReadOnlySDK(chainId);
    return sdk.searchAgents({}, { sort: ["updatedAt:desc"] });
  }

  const client = new SubgraphClientClass(subgraphUrl);
  const BATCH = 1000;

  // Cursor-based query — id_gt avoids skip limit entirely.
  // Order by id asc so the cursor is always the last returned id.
  const CURSOR_QUERY = `
    query AgentsCursor($first: Int!, $afterId: String!) {
      agents(
        first: $first
        orderBy: id
        orderDirection: asc
        where: { registrationFile_not: null, id_gt: $afterId }
      ) {
        id
        chainId
        agentId
        owner
        operators
        agentURI
        agentURIType
        agentWallet
        createdAt
        updatedAt
        totalFeedback
        lastActivity
        registrationFile {
          id
          agentId
          name
          description
          image
          active
          x402Support
          supportedTrusts
          mcpEndpoint
          mcpVersion
          a2aEndpoint
          a2aVersion
          webEndpoint
          emailEndpoint
          hasOASF
          oasfSkills
          oasfDomains
          ens
          did
          mcpTools
          mcpPrompts
          mcpResources
          a2aSkills
        }
      }
    }`;

  // Compatibility: some subgraphs (e.g. Sepolia) don't have hasOASF in the schema.
  // The SubgraphClient already handles hasOASF in selection set via its own shim,
  // but we're doing raw queries here so apply the same fallback.
  async function fetchPage(afterId: string): Promise<any[]> {
    try {
      const data = await client.query(CURSOR_QUERY, { first: BATCH, afterId });
      return data.agents || [];
    } catch (err: any) {
      const msg = String(err?.message || err);
      if (msg.includes('hasOASF')) {
        const fallbackQuery = CURSOR_QUERY.replace(/\s+hasOASF\b/g, '');
        const data = await client.query(fallbackQuery, { first: BATCH, afterId });
        return data.agents || [];
      }
      throw err;
    }
  }

  const all: any[] = [];
  let afterId = '';
  for (;;) {
    const page = await fetchPage(afterId);
    all.push(...page);
    if (page.length < BATCH) break;
    afterId = page[page.length - 1].id;
  }

  // Transform raw subgraph agents to AgentSummary format using the SDK's own
  // SubgraphClient._transformAgent method, which normalises all field names.
  try {
    return all.map((a: any) => (client as any)._transformAgent(a));
  } catch {
    // If _transformAgent is unavailable, return raw data (callers handle both).
    return all;
  }
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
        hasWeb: {
          type: "boolean",
          description: "Only agents with a web endpoint",
        },
        hasOASF: {
          type: "boolean",
          description: "Only agents with OASF skills/domains",
        },
        owners: {
          type: "array",
          items: { type: "string" },
          description: "Filter by owner wallet addresses",
        },
        operators: {
          type: "array",
          items: { type: "string" },
          description: "Filter by operator wallet addresses",
        },
        registeredAtFrom: {
          type: "string",
          description: "Filter agents registered after this ISO date (e.g. '2025-01-01')",
        },
        registeredAtTo: {
          type: "string",
          description: "Filter agents registered before this ISO date",
        },
        chains: {
          type: "array",
          items: { type: "number" },
          description:
            "Chain IDs to search (default: [1] Ethereum mainnet). Use [1, 8453, 137, 11155111] for all supported chains.",
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
        capabilities: {
          type: "array",
          items: { type: "string" },
          description: "Filter by agent capabilities mentioned in feedback",
        },
        skills: {
          type: "array",
          items: { type: "string" },
          description: "Filter by skills mentioned in feedback",
        },
        first: {
          type: "number",
          description: "Number of results to return (pagination, default: 50)",
        },
        skip: {
          type: "number",
          description: "Number of results to skip (pagination offset)",
        },
      },
    },
  },
  {
    name: "get_registries",
    description:
      "Get the ERC-8004 registry contract addresses for a specific chain. " +
      "Returns identity, reputation, and validation contract addresses.",
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
    name: "load_agent",
    description:
      "Load a full agent object by ID with updatable methods. " +
      "Returns the complete agent data including metadata, endpoints, trust models, " +
      "and the ability to modify the agent (requires ownership). " +
      "More detailed than get_agent — includes raw on-chain data.",
    inputSchema: {
      type: "object" as const,
      properties: {
        agentId: {
          type: "string",
          description: "Agent ID in chainId:tokenId format (e.g. '11155111:42')",
        },
      },
      required: ["agentId"],
    },
  },
];

// ============================================================================
// TOOL HANDLERS
// ============================================================================

async function handleSearchAgents(
  args: Record<string, unknown>,
): Promise<unknown> {
  // Compatibility shim: MCP gateway may expose `chainId` (number) instead of `chains` (array)
  if (args.chainId !== undefined && !args.chains) {
    args.chains = [args.chainId as number];
  }

  const limit = Math.min(
    Math.max(1, (args.limit as number) ?? 20),
    100,
  );

  const chainId = (args.chains as number[] | undefined)?.[0] ?? DEFAULT_CHAIN_ID;

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
  if (args.hasWeb !== undefined) filters.hasWeb = args.hasWeb;
  if (args.hasOASF !== undefined) filters.hasOASF = args.hasOASF;
  if (args.owners) filters.owners = args.owners;
  if (args.operators) filters.operators = args.operators;
  if (args.registeredAtFrom || args.registeredAtTo) {
    filters.registeredAt = {};
    if (args.registeredAtFrom) (filters.registeredAt as any).from = args.registeredAtFrom;
    if (args.registeredAtTo) (filters.registeredAt as any).to = args.registeredAtTo;
  }
  if (args.chains) filters.chains = args.chains;
  if (args.minFeedbackValue) {
    filters.feedback = {
      minValue: args.minFeedbackValue,
      includeRevoked: false,
    };
  }

  // Determine if any subgraph-level filters are active (beyond just chain selection).
  // When no filters are present, sdk.searchAgents fetches ALL agents which fails for
  // chains with >6000 registrations due to The Graph's skip>5000 restriction.
  const hasSubgraphFilters = Boolean(
    args.name || args.keyword || args.active !== undefined ||
    args.x402support !== undefined || args.hasMCP !== undefined ||
    args.hasA2A !== undefined || args.hasWeb !== undefined ||
    args.hasOASF !== undefined || args.owners || args.operators ||
    args.mcpTools || args.a2aSkills || args.oasfSkills || args.oasfDomains ||
    args.minFeedbackValue || args.registeredAtFrom || args.registeredAtTo
  );

  let allResults: any[];
  if (!hasSubgraphFilters) {
    // No filters — use graceful pagination to avoid silent failure on large chains
    allResults = await fetchAllAgentsGraceful(chainId);
  } else {
    const sdk = await getReadOnlySDK(chainId);
    allResults = await sdk.searchAgents(filters, { sort: ["updatedAt:desc"] });
  }

  const agents = allResults.slice(0, limit).map((a: any) =>
    formatAgentSummary(a as unknown as Record<string, unknown>),
  );

  return {
    count: agents.length,
    totalAvailable: allResults.length,
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

  // Use graceful pagination to avoid silent empty results on chains with >6000 agents
  // (The Graph decentralized network rejects skip > 5000, causing sdk.searchAgents to return [])
  const allAgents = await fetchAllAgentsGraceful(chainId);

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
  if (args.capabilities) filters.capabilities = args.capabilities;
  if (args.skills) filters.skills = args.skills;
  if (args.first !== undefined) options.first = args.first;
  if (args.skip !== undefined) options.skip = args.skip;

  const feedbacks = await sdk.searchFeedback(
    filters as Parameters<typeof sdk.searchFeedback>[0],
    options as Parameters<typeof sdk.searchFeedback>[1],
  );

  const resultLimit = (args.first as number) ?? 50;
  return {
    count: feedbacks.length,
    feedbacks: feedbacks.slice(0, resultLimit).map((f: any) => ({
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

async function handleGetRegistries(
  args: Record<string, unknown>,
): Promise<unknown> {
  const chainId = (args.chainId as number) ?? DEFAULT_CHAIN_ID;
  const sdk = await getReadOnlySDK(chainId);

  const registries = await sdk.registries();

  return {
    chainId,
    chain: getChainName(chainId),
    registries: {
      identity: registries.identity ?? registries.identityRegistry,
      reputation: registries.reputation ?? registries.reputationRegistry,
      validation: registries.validation ?? registries.validationRegistry,
    },
  };
}

async function handleLoadAgent(
  args: Record<string, unknown>,
): Promise<unknown> {
  const agentId = args.agentId as string;
  if (!agentId) return { error: "agentId is required (format: chainId:tokenId)" };

  const parts = agentId.split(":");
  if (parts.length !== 2) {
    return { error: "Invalid agentId format. Use chainId:tokenId (e.g. '11155111:42')" };
  }

  const chainId = parseInt(parts[0], 10);

  // Use authenticated SDK if available (for updatable methods), otherwise read-only
  let sdk: any;
  if (hasAuthentication()) {
    sdk = await getAuthenticatedSDK(chainId);
  }
  if (!sdk) {
    sdk = await getReadOnlySDK(chainId);
  }

  const agent = await sdk.loadAgent(agentId);
  if (!agent) {
    return { error: `Agent ${agentId} not found` };
  }

  // Extract raw data from the loaded agent object
  const data: Record<string, unknown> = {
    agentId,
    chain: getChainName(chainId),
    name: agent.name,
    description: agent.description,
    image: agent.image,
    active: agent.active,
    mcp: agent.mcp ?? null,
    a2a: agent.a2a ?? null,
    web: agent.web ?? null,
    ens: agent.ens ?? null,
    x402support: agent.x402support,
    owners: agent.owners,
    operators: agent.operators,
    supportedTrusts: agent.supportedTrusts,
    mcpTools: agent.mcpTools,
    a2aSkills: agent.a2aSkills,
    oasfSkills: agent.oasfSkills,
    oasfDomains: agent.oasfDomains,
    metadata: agent.metadata ?? {},
    registrationMethod: agent.registrationMethod,
    tokenURI: agent.tokenURI,
    updatedAt: agent.updatedAt,
    registeredAt: agent.registeredAt,
  };

  // Get reputation
  try {
    const reputation = await sdk.getReputationSummary(agentId);
    const trust = computeTrustLabel(reputation.count, reputation.averageValue);
    data.reputation = {
      count: reputation.count,
      averageValue: reputation.averageValue,
      trustLabel: trust.label,
      trustDisplay: trust.display,
    };
  } catch {
    data.reputation = null;
  }

  return data;
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
    case "get_registries":
      return handleGetRegistries(args);
    case "load_agent":
      return handleLoadAgent(args);
    default:
      return { error: `Unknown discovery tool: ${name}` };
  }
}
