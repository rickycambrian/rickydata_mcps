import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { computeTrustLabel } from "../utils/trust-labels.js";
import { getChainName } from "../utils/chains.js";

// ============================================================================
// KFDB API CLIENT
// ============================================================================

const KFDB_BASE_URL = process.env.KFDB_API_URL || "http://34.60.37.158";
const KFDB_API_KEY = process.env.KFDB_API_KEY || "";

interface KfdbEntityResponse {
  label: string;
  items: Record<string, unknown>[];
  total: number;
  limit: number;
  offset: number;
}

interface KfdbLabelsResponse {
  labels: { label: string; count: number }[];
}

async function kfdbFetch(path: string, options?: RequestInit): Promise<Response> {
  const url = `${KFDB_BASE_URL}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options?.headers as Record<string, string> || {}),
  };
  if (KFDB_API_KEY) {
    headers["Authorization"] = `Bearer ${KFDB_API_KEY}`;
  }
  return fetch(url, { ...options, headers });
}

async function kfdbEntities(
  label: string,
  limit = 20,
  offset = 0,
): Promise<KfdbEntityResponse> {
  const res = await kfdbFetch(
    `/api/v1/entities/${label}?limit=${limit}&offset=${offset}`,
  );
  if (!res.ok) {
    throw new Error(`KFDB entity API error: ${res.status} ${await res.text()}`);
  }
  return res.json() as Promise<KfdbEntityResponse>;
}

async function kfdbEntityById(
  label: string,
  uuid: string,
): Promise<Record<string, unknown> | null> {
  const res = await kfdbFetch(`/api/v1/entities/${label}/${uuid}`);
  if (res.status === 404 || res.status === 400) return null;
  if (!res.ok) {
    throw new Error(`KFDB entity API error: ${res.status} ${await res.text()}`);
  }
  return res.json() as Promise<Record<string, unknown>>;
}

async function kfdbLabels(): Promise<KfdbLabelsResponse> {
  const res = await kfdbFetch("/api/v1/entities/labels");
  if (!res.ok) {
    throw new Error(`KFDB labels API error: ${res.status} ${await res.text()}`);
  }
  return res.json() as Promise<KfdbLabelsResponse>;
}

async function kfdbKQL(query: string): Promise<unknown> {
  if (!KFDB_API_KEY) {
    throw new Error("KFDB_API_KEY required for KQL queries");
  }
  const res = await kfdbFetch("/api/v1/query", {
    method: "POST",
    body: JSON.stringify({ query }),
  });
  if (!res.ok) {
    throw new Error(`KFDB KQL error: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function kfdbSemanticSearch(
  query: string,
  label: string,
  limit = 10,
): Promise<Record<string, unknown>[] | null> {
  const res = await kfdbFetch("/api/v1/semantic/search", {
    method: "POST",
    body: JSON.stringify({ query, label, limit }),
  });
  if (!res.ok) return null; // HNSW may not be ready
  const data = (await res.json()) as { results?: Record<string, unknown>[] };
  return data.results ?? null;
}

async function kfdbEgoGraph(
  label: string,
  id: string,
  depth = 1,
): Promise<Record<string, unknown> | null> {
  const res = await kfdbFetch(
    `/api/v1/ego-graph/${label}/${encodeURIComponent(id)}?depth=${depth}`,
  );
  if (!res.ok) return null;
  return res.json() as Promise<Record<string, unknown>>;
}

// ============================================================================
// RESPONSE FORMATTERS
// ============================================================================

function formatKfdbAgent(agent: Record<string, unknown>): string {
  const trust = computeTrustLabel(
    (agent.total_feedback as number) ?? 0,
    0, // entity API doesn't have avg score, use feedback count for trust
  );

  const lines: string[] = [];
  lines.push(`## ${agent.name || "Unnamed Agent"}`);
  lines.push(`**Agent ID**: ${agent.agent_id}`);
  lines.push(`**Chain**: ${getChainName((agent.chain_id as number) ?? 0)} (${agent.chain_id})`);
  if (agent.description) lines.push(`**Description**: ${agent.description}`);
  lines.push(`**Trust**: ${trust.display}`);
  lines.push(`**Active**: ${agent.active ?? "unknown"}`);
  if (agent.owner) lines.push(`**Owner**: ${agent.owner}`);
  if (agent.agent_wallet) lines.push(`**Wallet**: ${agent.agent_wallet}`);
  if (agent.image) lines.push(`**Image**: ${agent.image}`);
  if (agent.has_real_endpoint) lines.push(`**Has Real Endpoint**: yes`);
  if (agent.supported_trusts) {
    const trusts = agent.supported_trusts as string[];
    if (trusts.length > 0) lines.push(`**Trust Models**: ${trusts.join(", ")}`);
  }
  lines.push(`**Total Feedback**: ${agent.total_feedback ?? 0}`);
  if (agent.updated_at) {
    const d = new Date((agent.updated_at as number) * 1000);
    lines.push(`**Last Updated**: ${d.toISOString().split("T")[0]}`);
  }
  return lines.join("\n");
}

function formatKfdbFeedback(fb: Record<string, unknown>): string {
  const lines: string[] = [];
  lines.push(`- **Score**: ${fb.value ?? "N/A"}/100`);
  lines.push(`  **From**: ${fb.client_address ?? "unknown"}`);
  if (fb.tag1) lines.push(`  **Tag**: ${fb.tag1}${fb.tag2 ? ` / ${fb.tag2}` : ""}`);
  if (fb.endpoint) lines.push(`  **Endpoint**: ${fb.endpoint}`);
  if (fb.is_revoked) lines.push(`  **Revoked**: yes`);
  if (fb.created_at) {
    const d = new Date((fb.created_at as number) * 1000);
    lines.push(`  **Date**: ${d.toISOString().split("T")[0]}`);
  }
  return lines.join("\n");
}

// ============================================================================
// TOOL DEFINITIONS
// ============================================================================

export const kfdbTools: Tool[] = [
  {
    name: "kfdb_search_agents",
    description:
      "Search 131K+ ERC-8004 agents indexed in KFDB by name, description, or chain. " +
      "Uses semantic search when available, falls back to text matching. " +
      "Returns agents with trust labels and rich metadata from the knowledge graph.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description:
            "Search query - matches against agent name and description",
        },
        chain_id: {
          type: "number",
          description:
            "Filter by chain ID (1=Ethereum, 8453=Base, 56=BSC, 137=Polygon, 11155111=Sepolia)",
        },
        active_only: {
          type: "boolean",
          description: "Only return active agents (default: false)",
        },
        limit: {
          type: "number",
          description: "Max results (default: 10, max: 50)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "kfdb_get_agent_details",
    description:
      "Get rich details about a specific ERC-8004 agent from the KFDB knowledge graph. " +
      "Returns full profile with description, trust label, chain info, wallet, and feedback count. " +
      "Includes graph connections (skills, domains, chain relationships) when available.",
    inputSchema: {
      type: "object" as const,
      properties: {
        agent_id: {
          type: "string",
          description:
            "Agent ID in chainId:tokenId format (e.g. '8453:123' or '1:42')",
        },
      },
      required: ["agent_id"],
    },
  },
  {
    name: "kfdb_find_similar",
    description:
      "Find agents similar to a given agent or description using KFDB semantic search. " +
      "Provide either an agent_id (looks up its description) or a free-text description. " +
      "Returns ranked similar agents from the 131K+ indexed agents.",
    inputSchema: {
      type: "object" as const,
      properties: {
        agent_id: {
          type: "string",
          description:
            "Agent ID to find similar agents for (chainId:tokenId format)",
        },
        description: {
          type: "string",
          description:
            "Free-text description to find similar agents (used if agent_id not provided)",
        },
        limit: {
          type: "number",
          description: "Max results (default: 5, max: 20)",
        },
      },
    },
  },
  {
    name: "kfdb_ecosystem_stats",
    description:
      "Get aggregate statistics about the ERC-8004 agent ecosystem from KFDB. " +
      "Returns total agents, feedback entries, accounts, chain breakdowns, and more. " +
      "Optionally filter by chain_id for chain-specific stats.",
    inputSchema: {
      type: "object" as const,
      properties: {
        chain_id: {
          type: "number",
          description:
            "Filter stats by chain ID (omit for global stats across all chains)",
        },
      },
    },
  },
  {
    name: "kfdb_feedback_analysis",
    description:
      "Analyze feedback/reputation for a specific ERC-8004 agent from KFDB. " +
      "Returns individual feedback entries with scores, tags, reviewers, and dates. " +
      "Computes average score and tag distribution for reputation analysis.",
    inputSchema: {
      type: "object" as const,
      properties: {
        agent_id: {
          type: "string",
          description:
            "Agent ID in chainId:tokenId format (e.g. '8453:123')",
        },
        limit: {
          type: "number",
          description: "Max feedback entries to return (default: 20, max: 100)",
        },
      },
      required: ["agent_id"],
    },
  },
];

// ============================================================================
// TOOL HANDLERS
// ============================================================================

async function handleKfdbSearchAgents(
  args: Record<string, unknown>,
): Promise<string> {
  const query = (args.query as string)?.toLowerCase();
  if (!query) return "Error: query is required";

  const chainFilter = args.chain_id as number | undefined;
  const activeOnly = (args.active_only as boolean) ?? false;
  const limit = Math.min(Math.max(1, (args.limit as number) ?? 10), 50);

  // Strategy 1: Try semantic search first (best quality)
  const semanticResults = await kfdbSemanticSearch(query, "ERC8004Agent", limit);
  if (semanticResults && semanticResults.length > 0) {
    let filtered = semanticResults;
    if (chainFilter) {
      filtered = filtered.filter((a) => a.chain_id === chainFilter);
    }
    if (activeOnly) {
      filtered = filtered.filter((a) => a.active === true);
    }
    const results = filtered.slice(0, limit);
    const lines = [
      `# KFDB Agent Search: "${args.query}"`,
      `**Source**: Semantic search (embedding similarity)`,
      `**Results**: ${results.length} agents found\n`,
    ];
    for (const agent of results) {
      lines.push(formatKfdbAgent(agent));
      lines.push("");
    }
    return lines.join("\n");
  }

  // Strategy 2: Scan entity API pages and filter by name/description match
  const BATCH_SIZE = 500;
  const MAX_PAGES = 10; // scan up to 5000 agents
  const matches: Record<string, unknown>[] = [];

  for (let page = 0; page < MAX_PAGES && matches.length < limit; page++) {
    const data = await kfdbEntities("ERC8004Agent", BATCH_SIZE, page * BATCH_SIZE);
    if (!data.items || data.items.length === 0) break;

    for (const agent of data.items) {
      const name = ((agent.name as string) ?? "").toLowerCase();
      const desc = ((agent.description as string) ?? "").toLowerCase();
      const agentId = ((agent.agent_id as string) ?? "").toLowerCase();

      if (!name.includes(query) && !desc.includes(query) && !agentId.includes(query)) {
        continue;
      }
      if (chainFilter && agent.chain_id !== chainFilter) continue;
      if (activeOnly && agent.active !== true) continue;
      matches.push(agent);
      if (matches.length >= limit) break;
    }
  }

  if (matches.length === 0) {
    return `# KFDB Agent Search: "${args.query}"\n\nNo agents found matching "${args.query}". ` +
      `Try a broader search term or different chain_id. ` +
      `KFDB has 131K+ agents indexed across multiple chains.`;
  }

  const lines = [
    `# KFDB Agent Search: "${args.query}"`,
    `**Source**: Entity API (text match)`,
    `**Results**: ${matches.length} agents found\n`,
  ];
  for (const agent of matches) {
    lines.push(formatKfdbAgent(agent));
    lines.push("");
  }
  return lines.join("\n");
}

async function handleKfdbGetAgentDetails(
  args: Record<string, unknown>,
): Promise<string> {
  const agentId = args.agent_id as string;
  if (!agentId) return "Error: agent_id is required (format: chainId:tokenId)";

  if (!agentId.includes(":")) {
    return "Error: agent_id must be in chainId:tokenId format (e.g. '8453:123')";
  }

  // Scan entity API to find by agent_id property
  const BATCH_SIZE = 500;
  const MAX_PAGES = 20;
  let agent: Record<string, unknown> | null = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await kfdbEntities("ERC8004Agent", BATCH_SIZE, page * BATCH_SIZE);
    if (!data.items || data.items.length === 0) break;

    const found = data.items.find((a) => a.agent_id === agentId);
    if (found) {
      agent = found;
      break;
    }
  }

  if (!agent) {
    return `Agent ${agentId} not found in KFDB. Verify the chainId:tokenId format is correct.`;
  }

  const lines = [formatKfdbAgent(agent)];

  // Try to get ego-graph for connections (requires auth)
  const graph = await kfdbEgoGraph("ERC8004Agent", agent._id as string);
  if (graph) {
    const edges = (graph.edges ?? []) as Record<string, unknown>[];
    const neighbors = (graph.neighbors ?? graph.nodes ?? []) as Record<string, unknown>[];
    if (edges.length > 0 || neighbors.length > 0) {
      lines.push("\n### Graph Connections");
      if (edges.length > 0) {
        lines.push(`**Edges**: ${edges.length} connections`);
        for (const edge of edges.slice(0, 10)) {
          lines.push(`- ${edge.label ?? edge.type ?? "connected"} -> ${edge.target_label ?? edge.to ?? "?"}`);
        }
      }
    }
  }

  // Try to get feedback summary
  const feedbackData = await kfdbEntities("ERC8004Feedback", 500, 0);
  const feedbacks = feedbackData.items.filter((f) => f.agent_id === agentId);
  if (feedbacks.length > 0) {
    const scores = feedbacks.map((f) => (f.value as number) ?? 0);
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    const trust = computeTrustLabel(feedbacks.length, avg);
    lines.push("\n### Reputation Summary");
    lines.push(`**Feedback Count**: ${feedbacks.length}`);
    lines.push(`**Average Score**: ${avg.toFixed(1)}/100`);
    lines.push(`**Trust**: ${trust.display}`);
    const tags = new Map<string, number>();
    for (const f of feedbacks) {
      if (f.tag1) tags.set(f.tag1 as string, (tags.get(f.tag1 as string) ?? 0) + 1);
    }
    if (tags.size > 0) {
      const tagStr = [...tags.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([t, c]) => `${t} (${c})`)
        .join(", ");
      lines.push(`**Tags**: ${tagStr}`);
    }
  }

  return lines.join("\n");
}

async function handleKfdbFindSimilar(
  args: Record<string, unknown>,
): Promise<string> {
  const agentId = args.agent_id as string | undefined;
  let description = args.description as string | undefined;
  const limit = Math.min(Math.max(1, (args.limit as number) ?? 5), 20);

  if (!agentId && !description) {
    return "Error: provide either agent_id or description to find similar agents";
  }

  // If agent_id given, look up its description
  if (agentId && !description) {
    const BATCH_SIZE = 500;
    const MAX_PAGES = 20;
    for (let page = 0; page < MAX_PAGES; page++) {
      const data = await kfdbEntities("ERC8004Agent", BATCH_SIZE, page * BATCH_SIZE);
      if (!data.items || data.items.length === 0) break;
      const found = data.items.find((a) => a.agent_id === agentId);
      if (found) {
        description = (found.description as string) ?? (found.name as string);
        break;
      }
    }
    if (!description) {
      return `Agent ${agentId} not found in KFDB. Cannot determine description for similarity search.`;
    }
  }

  // Try semantic search
  const semanticResults = await kfdbSemanticSearch(description!, "ERC8004Agent", limit + 1);
  if (semanticResults && semanticResults.length > 0) {
    // Filter out the source agent if present
    let results = semanticResults;
    if (agentId) {
      results = results.filter((a) => a.agent_id !== agentId);
    }
    results = results.slice(0, limit);

    const lines = [
      `# Similar Agents`,
      agentId ? `**Reference**: ${agentId}` : `**Query**: "${description}"`,
      `**Source**: Semantic similarity (embeddings)`,
      `**Results**: ${results.length} similar agents\n`,
    ];
    for (let i = 0; i < results.length; i++) {
      lines.push(`### ${i + 1}. Match`);
      lines.push(formatKfdbAgent(results[i]));
      lines.push("");
    }
    return lines.join("\n");
  }

  // Fallback: text-based similarity using keyword overlap
  const keywords = description!.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
  if (keywords.length === 0) {
    return "Could not extract meaningful keywords for similarity search. Semantic search is not available - try again later.";
  }

  const BATCH_SIZE = 500;
  const MAX_PAGES = 10;
  const scored: { agent: Record<string, unknown>; score: number }[] = [];

  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await kfdbEntities("ERC8004Agent", BATCH_SIZE, page * BATCH_SIZE);
    if (!data.items || data.items.length === 0) break;

    for (const agent of data.items) {
      if (agentId && agent.agent_id === agentId) continue;
      const text = `${agent.name ?? ""} ${agent.description ?? ""}`.toLowerCase();
      const matchCount = keywords.filter((kw) => text.includes(kw)).length;
      if (matchCount > 0) {
        scored.push({ agent, score: matchCount / keywords.length });
      }
    }
  }

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, limit);

  if (top.length === 0) {
    return `No similar agents found. Semantic search is not currently available (HNSW index building). Try again later for better results.`;
  }

  const lines = [
    `# Similar Agents`,
    agentId ? `**Reference**: ${agentId}` : `**Query**: "${description}"`,
    `**Source**: Keyword overlap (semantic search unavailable)`,
    `**Results**: ${top.length} similar agents\n`,
  ];
  for (let i = 0; i < top.length; i++) {
    lines.push(`### ${i + 1}. Match (${(top[i].score * 100).toFixed(0)}% keyword overlap)`);
    lines.push(formatKfdbAgent(top[i].agent));
    lines.push("");
  }
  return lines.join("\n");
}

async function handleKfdbEcosystemStats(
  args: Record<string, unknown>,
): Promise<string> {
  const chainFilter = args.chain_id as number | undefined;

  // Get label counts from KFDB
  const labelsData = await kfdbLabels();
  const labelMap = new Map<string, number>();
  for (const l of labelsData.labels) {
    labelMap.set(l.label, l.count);
  }

  const agentCount = labelMap.get("ERC8004Agent") ?? 0;
  const feedbackCount = labelMap.get("ERC8004Feedback") ?? 0;
  const accountCount = labelMap.get("ERC8004Account") ?? 0;

  const lines = [
    `# ERC-8004 Ecosystem Statistics (KFDB)`,
    "",
    `## Global Counts`,
    `- **Agents**: ${agentCount.toLocaleString()}`,
    `- **Feedback Entries**: ${feedbackCount.toLocaleString()}`,
    `- **Accounts**: ${accountCount.toLocaleString()}`,
  ];

  // If chain filter requested, scan agents for that chain
  if (chainFilter !== undefined) {
    const BATCH_SIZE = 500;
    const MAX_PAGES = 20;
    let chainAgents = 0;
    let activeAgents = 0;
    let withEndpoint = 0;
    let totalFeedbackSum = 0;

    for (let page = 0; page < MAX_PAGES; page++) {
      const data = await kfdbEntities("ERC8004Agent", BATCH_SIZE, page * BATCH_SIZE);
      if (!data.items || data.items.length === 0) break;

      for (const agent of data.items) {
        if (agent.chain_id !== chainFilter) continue;
        chainAgents++;
        if (agent.active === true) activeAgents++;
        if (agent.has_real_endpoint === true) withEndpoint++;
        totalFeedbackSum += (agent.total_feedback as number) ?? 0;
      }
    }

    lines.push("");
    lines.push(`## ${getChainName(chainFilter)} (Chain ${chainFilter})`);
    lines.push(`- **Agents on chain**: ${chainAgents.toLocaleString()}`);
    lines.push(`- **Active**: ${activeAgents.toLocaleString()}`);
    lines.push(`- **With Real Endpoints**: ${withEndpoint.toLocaleString()}`);
    lines.push(`- **Total Feedback Received**: ${totalFeedbackSum.toLocaleString()}`);
  } else {
    // Get chain distribution from a sample
    const SAMPLE_SIZE = 2000;
    const data = await kfdbEntities("ERC8004Agent", SAMPLE_SIZE, 0);
    const chainCounts = new Map<number, number>();
    for (const agent of data.items) {
      const chain = agent.chain_id as number;
      chainCounts.set(chain, (chainCounts.get(chain) ?? 0) + 1);
    }

    lines.push("");
    lines.push(`## Chain Distribution (sample of ${data.items.length} agents)`);
    const sorted = [...chainCounts.entries()].sort((a, b) => b[1] - a[1]);
    for (const [chain, count] of sorted) {
      const pct = ((count / data.items.length) * 100).toFixed(1);
      lines.push(`- **${getChainName(chain)}** (${chain}): ${count} agents (${pct}%)`);
    }
  }

  // Additional KFDB graph context
  const otherLabels = labelsData.labels
    .filter((l) => !l.label.startsWith("ERC8004"))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
  if (otherLabels.length > 0) {
    lines.push("");
    lines.push(`## Other KFDB Entities (top 5)`);
    for (const l of otherLabels) {
      lines.push(`- **${l.label}**: ${l.count.toLocaleString()}`);
    }
  }

  lines.push("");
  lines.push(`*Data source: KFDB production (ScyllaDB)*`);

  return lines.join("\n");
}

async function handleKfdbFeedbackAnalysis(
  args: Record<string, unknown>,
): Promise<string> {
  const agentId = args.agent_id as string;
  if (!agentId) return "Error: agent_id is required (format: chainId:tokenId)";

  const limit = Math.min(Math.max(1, (args.limit as number) ?? 20), 100);

  // Scan feedback entities to find those matching the agent
  const BATCH_SIZE = 500;
  const MAX_PAGES = 40; // scan up to 20K feedback entries
  const feedbacks: Record<string, unknown>[] = [];

  for (let page = 0; page < MAX_PAGES && feedbacks.length < limit; page++) {
    const data = await kfdbEntities("ERC8004Feedback", BATCH_SIZE, page * BATCH_SIZE);
    if (!data.items || data.items.length === 0) break;

    for (const fb of data.items) {
      if (fb.agent_id === agentId) {
        feedbacks.push(fb);
        if (feedbacks.length >= limit) break;
      }
    }
  }

  if (feedbacks.length === 0) {
    return `# Feedback Analysis: ${agentId}\n\nNo feedback found for agent ${agentId} in KFDB. ` +
      `The agent may have no reviews yet, or feedback may not have been synced.`;
  }

  // Compute stats
  const scores = feedbacks.map((f) => (f.value as number) ?? 0);
  const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const trust = computeTrustLabel(feedbacks.length, avg);

  // Tag distribution
  const tags = new Map<string, number>();
  for (const f of feedbacks) {
    if (f.tag1) tags.set(f.tag1 as string, (tags.get(f.tag1 as string) ?? 0) + 1);
    if (f.tag2) tags.set(f.tag2 as string, (tags.get(f.tag2 as string) ?? 0) + 1);
  }

  // Unique reviewers
  const reviewers = new Set(feedbacks.map((f) => f.client_address as string));

  const lines = [
    `# Feedback Analysis: ${agentId}`,
    "",
    `## Summary`,
    `- **Trust**: ${trust.display}`,
    `- **Total Feedback**: ${feedbacks.length}`,
    `- **Average Score**: ${avg.toFixed(1)}/100`,
    `- **Score Range**: ${min} - ${max}`,
    `- **Unique Reviewers**: ${reviewers.size}`,
  ];

  if (tags.size > 0) {
    lines.push("");
    lines.push(`## Tag Distribution`);
    const sortedTags = [...tags.entries()].sort((a, b) => b[1] - a[1]);
    for (const [tag, count] of sortedTags) {
      lines.push(`- **${tag}**: ${count} (${((count / feedbacks.length) * 100).toFixed(0)}%)`);
    }
  }

  lines.push("");
  lines.push(`## Recent Feedback (${Math.min(feedbacks.length, 10)} shown)`);
  for (const fb of feedbacks.slice(0, 10)) {
    lines.push(formatKfdbFeedback(fb));
  }

  return lines.join("\n");
}

// ============================================================================
// DISPATCH
// ============================================================================

export async function handleKfdbTool(
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "kfdb_search_agents":
      return handleKfdbSearchAgents(args);
    case "kfdb_get_agent_details":
      return handleKfdbGetAgentDetails(args);
    case "kfdb_find_similar":
      return handleKfdbFindSimilar(args);
    case "kfdb_ecosystem_stats":
      return handleKfdbEcosystemStats(args);
    case "kfdb_feedback_analysis":
      return handleKfdbFeedbackAnalysis(args);
    default:
      return `Unknown KFDB tool: ${name}`;
  }
}
