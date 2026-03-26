import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { computeTrustLabel } from "../utils/trust-labels.js";
import { getChainName } from "../utils/chains.js";

// ============================================================================
// KFDB API CLIENT
// ============================================================================

const KFDB_BASE_URL = process.env.KFDB_API_URL || "http://34.60.37.158";
const KFDB_API_KEY = process.env.KFDB_API_KEY || "";
const WALLET_ADDRESS = process.env.WALLET_ADDRESS || "";

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
  // NOTE: Do NOT send X-Wallet-Address for read-only KFDB tools.
  // ERC-8004 data lives in the default/global tenant. Adding X-Wallet-Address
  // scopes queries to a per-wallet tenant keyspace that has no ERC-8004 data.
  // Wallet scoping is only needed for per-user write operations (notes, private data).
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

async function kfdbLabels(): Promise<KfdbLabelsResponse> {
  const res = await kfdbFetch("/api/v1/entities/labels");
  if (!res.ok) {
    throw new Error(`KFDB labels API error: ${res.status} ${await res.text()}`);
  }
  return res.json() as Promise<KfdbLabelsResponse>;
}

async function kfdbKQL(query: string): Promise<Record<string, unknown>[]> {
  if (!KFDB_API_KEY) {
    throw new Error(
      "KFDB_API_KEY not configured. Configure it as a secret for this MCP server " +
      "in the marketplace, or set KFDB_API_KEY environment variable."
    );
  }
  const res = await kfdbFetch("/api/v1/query", {
    method: "POST",
    body: JSON.stringify({ query }),
  });
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `KFDB auth failed (${res.status}). The KFDB_API_KEY may be invalid or expired. ` +
        `Update it in the MCP server secrets.`
      );
    }
    throw new Error(`KFDB KQL error: ${res.status} ${text}`);
  }
  const result = (await res.json()) as { data?: Record<string, unknown>[] };
  return result.data ?? [];
}

async function kfdbSemanticSearch(
  query: string,
  limit = 10,
): Promise<Record<string, unknown>[] | null> {
  const res = await kfdbFetch("/api/v1/semantic/search", {
    method: "POST",
    body: JSON.stringify({ query, limit, min_similarity: 0.5 }),
  });
  if (!res.ok) return null; // HNSW may not be ready
  const data = (await res.json()) as { results?: Record<string, unknown>[] };
  return data.results ?? null;
}

// ============================================================================
// KQL PROJECTION FIELDS
// ============================================================================

// IMPORTANT: KQL `RETURN n` goes to ScyllaDB filtered scan (per-tenant keyspace).
// KQL `RETURN n.field1, n.field2` goes to ClickHouse pushdown (global data).
// For KFDB API keys that resolve to a non-default tenant, `RETURN n` returns
// empty results. Always use explicit projections to ensure ClickHouse path.
const AGENT_FIELDS = "n._id, n.name, n.description, n.agent_id, n.chain_id, n.trust_label, n.trust_emoji, n.total_feedback, n.active, n.owner, n.agent_wallet, n.web_endpoint, n.image, n.has_real_endpoint, n.oasf_skills, n.oasf_domains, n.supported_trusts, n.x402_support, n.service_types, n.updated_at, n.created_at";
const FEEDBACK_FIELDS = "n._id, n.agent_id, n.feedback_id, n.value, n.tag1, n.tag2, n.client_address, n.endpoint, n.is_revoked, n.created_at, n.chain_id";

// ============================================================================
// PROPERTY UNWRAPPING
// ============================================================================

// KQL returns typed wrappers: {String: "val"}, {Integer: 42}, {Boolean: true}
// Entity API returns flat values. This function normalizes both.
function unwrap(val: unknown): unknown {
  if (val === null || val === undefined) return val;
  if (typeof val !== "object") return val;
  const obj = val as Record<string, unknown>;
  if ("String" in obj) return obj.String;
  if ("Integer" in obj) return obj.Integer;
  if ("Float" in obj) return obj.Float;
  if ("Boolean" in obj) return obj.Boolean;
  if ("Array" in obj) {
    return (obj.Array as unknown[]).map(unwrap);
  }
  if ("Object" in obj) {
    return unwrapProps(obj.Object as Record<string, unknown>);
  }
  return val;
}

function unwrapProps(props: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(props)) {
    result[key] = unwrap(val);
  }
  return result;
}

// Extract a flat object from KQL row.
// Projections return: {name: {String:"X"}, chain_id: {Integer:1}} (flat, no n. prefix)
// RETURN n returns: {n: {Object: {...}}} (wrapped)
function extractKqlNode(row: Record<string, unknown>, alias = "n"): Record<string, unknown> | null {
  // Check for wrapped format: {n: {Object: {...}}}
  const wrapper = row[alias] as Record<string, unknown> | undefined;
  if (wrapper && "Object" in wrapper) {
    return unwrapProps(wrapper.Object as Record<string, unknown>);
  }
  if (wrapper && typeof wrapper === "object") {
    return unwrapProps(wrapper);
  }
  // Projection format: flat fields directly on row
  if (Object.keys(row).length > 0 && !wrapper) {
    return unwrapProps(row);
  }
  return null;
}

// ============================================================================
// RESPONSE FORMATTERS
// ============================================================================

function formatAgent(agent: Record<string, unknown>): string {
  const trust = computeTrustLabel(
    (agent.total_feedback as number) ?? 0,
    0,
  );

  const lines: string[] = [];
  lines.push(`## ${agent.name || "Unnamed Agent"}`);
  lines.push(`**Agent ID**: ${agent.agent_id}`);
  lines.push(`**Chain**: ${getChainName((agent.chain_id as number) ?? 0)} (${agent.chain_id})`);
  if (agent.description) lines.push(`**Description**: ${(agent.description as string).slice(0, 300)}`);
  lines.push(`**Trust**: ${agent.trust_label ?? trust.display}`);
  lines.push(`**Active**: ${agent.active ?? "unknown"}`);
  if (agent.owner) lines.push(`**Owner**: ${agent.owner}`);
  if (agent.agent_wallet) lines.push(`**Wallet**: ${agent.agent_wallet}`);
  if (agent.image) lines.push(`**Image**: ${agent.image}`);
  if (agent.web_endpoint) lines.push(`**Endpoint**: ${agent.web_endpoint}`);
  if (agent.has_real_endpoint) lines.push(`**Has Real Endpoint**: yes`);
  const skills = agent.oasf_skills as string[] | undefined;
  if (skills && skills.length > 0) lines.push(`**Skills**: ${skills.slice(0, 5).join(", ")}`);
  const domains = agent.oasf_domains as string[] | undefined;
  if (domains && domains.length > 0) lines.push(`**Domains**: ${domains.join(", ")}`);
  lines.push(`**Total Feedback**: ${agent.total_feedback ?? 0}`);
  if (agent.updated_at) {
    const ts = agent.updated_at as number;
    const d = new Date(ts > 1e12 ? ts : ts * 1000);
    lines.push(`**Last Updated**: ${d.toISOString().split("T")[0]}`);
  }
  return lines.join("\n");
}

function formatFeedback(fb: Record<string, unknown>): string {
  const lines: string[] = [];
  lines.push(`- **Score**: ${fb.value ?? "N/A"}/100`);
  lines.push(`  **From**: ${fb.client_address ?? "unknown"}`);
  if (fb.tag1) lines.push(`  **Tag**: ${fb.tag1}${fb.tag2 ? ` / ${fb.tag2}` : ""}`);
  if (fb.endpoint) lines.push(`  **Endpoint**: ${fb.endpoint}`);
  if (fb.is_revoked) lines.push(`  **Revoked**: yes`);
  if (fb.created_at) {
    const ts = fb.created_at as number;
    const d = new Date(ts > 1e12 ? ts : ts * 1000);
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
      "Includes skills, domains, and reputation summary.",
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

async function handleSearchAgents(args: Record<string, unknown>): Promise<string> {
  const query = args.query as string;
  if (!query) return "Error: query is required";

  const chainFilter = args.chain_id as number | undefined;
  const activeOnly = (args.active_only as boolean) ?? false;
  const limit = Math.min(Math.max(1, (args.limit as number) ?? 10), 50);

  // Strategy 1: Semantic search (best quality, uses HNSW embeddings)
  const semanticResults = await kfdbSemanticSearch(query, limit * 2);
  if (semanticResults && semanticResults.length > 0) {
    // Semantic results come from file_embeddings with erc8004-agent:// paths
    // Extract agent UUIDs from file_path: "erc8004-agent://<uuid>/<name>"
    const agentUuids = semanticResults
      .map((r) => {
        const props = r.properties ? unwrapProps(r.properties as Record<string, unknown>) : r;
        const path = (props.file_path as string) ?? "";
        const match = path.match(/erc8004-agent:\/\/([a-f0-9-]+)\//);
        return match ? match[1] : null;
      })
      .filter(Boolean) as string[];

    if (agentUuids.length > 0) {
      // Batch-fetch agent details via KQL
      const uuidList = agentUuids.slice(0, limit).map((u) => `'${u}'`).join(", ");
      try {
        const rows = await kfdbKQL(
          `MATCH (n:ERC8004Agent) WHERE n._id IN [${uuidList}] RETURN ${AGENT_FIELDS} LIMIT ${limit}`,
        );
        let agents = rows.map((r) => extractKqlNode(r)).filter(Boolean) as Record<string, unknown>[];

        if (chainFilter) agents = agents.filter((a) => a.chain_id === chainFilter);
        if (activeOnly) agents = agents.filter((a) => a.active === true);

        if (agents.length > 0) {
          const lines = [
            `# KFDB Agent Search: "${query}"`,
            `**Source**: Semantic search (embedding similarity)`,
            `**Results**: ${agents.length} agents\n`,
          ];
          for (const agent of agents.slice(0, limit)) {
            lines.push(formatAgent(agent));
            lines.push("");
          }
          return lines.join("\n");
        }
      } catch {
        // KQL IN may not be supported — fall through to entity scan
      }
    }
  }

  // Strategy 2: Text search via entity API scan (limited to 5000 agents)
  const queryLower = query.toLowerCase();
  const BATCH_SIZE = 500;
  const MAX_PAGES = 10;
  const matches: Record<string, unknown>[] = [];

  for (let page = 0; page < MAX_PAGES && matches.length < limit; page++) {
    const data = await kfdbEntities("ERC8004Agent", BATCH_SIZE, page * BATCH_SIZE);
    if (!data.items || data.items.length === 0) break;

    for (const agent of data.items) {
      const name = ((agent.name as string) ?? "").toLowerCase();
      const desc = ((agent.description as string) ?? "").toLowerCase();
      const agentId = ((agent.agent_id as string) ?? "").toLowerCase();

      if (!name.includes(queryLower) && !desc.includes(queryLower) && !agentId.includes(queryLower)) {
        continue;
      }
      if (chainFilter && agent.chain_id !== chainFilter) continue;
      if (activeOnly && agent.active !== true) continue;
      matches.push(agent);
      if (matches.length >= limit) break;
    }
  }

  if (matches.length === 0) {
    return `# KFDB Agent Search: "${query}"\n\nNo agents found matching "${query}". ` +
      `Try a broader term or different chain_id. KFDB has 131K+ agents across 9 chains.`;
  }

  const lines = [
    `# KFDB Agent Search: "${query}"`,
    `**Source**: Entity API (text match)`,
    `**Results**: ${matches.length} agents\n`,
  ];
  for (const agent of matches) {
    lines.push(formatAgent(agent));
    lines.push("");
  }
  return lines.join("\n");
}

async function handleGetAgentDetails(args: Record<string, unknown>): Promise<string> {
  const agentId = args.agent_id as string;
  if (!agentId) return "Error: agent_id is required (format: chainId:tokenId)";
  if (!agentId.includes(":")) return "Error: agent_id must be in chainId:tokenId format (e.g. '8453:123')";

  // Use KQL with ClickHouse-pushdown projections (RETURN n goes to ScyllaDB per-tenant keyspace)
  const rows = await kfdbKQL(
    `MATCH (n:ERC8004Agent) WHERE n.agent_id = '${agentId.replace(/'/g, "\\'")}' RETURN ${AGENT_FIELDS} LIMIT 1`,
  );

  const agent = rows.length > 0 ? extractKqlNode(rows[0]) : null;
  if (!agent) {
    return `Agent ${agentId} not found in KFDB. Verify the chainId:tokenId format is correct.`;
  }

  const lines = [formatAgent(agent)];

  // Get feedback summary via KQL (fast targeted query)
  try {
    const fbRows = await kfdbKQL(
      `MATCH (n:ERC8004Feedback) WHERE n.agent_id = '${agentId.replace(/'/g, "\\'")}' RETURN ${FEEDBACK_FIELDS} LIMIT 50`,
    );
    const feedbacks = fbRows.map((r) => extractKqlNode(r)).filter(Boolean) as Record<string, unknown>[];

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
  } catch {
    // Feedback query failed — non-blocking
  }

  return lines.join("\n");
}

async function handleFindSimilar(args: Record<string, unknown>): Promise<string> {
  const agentId = args.agent_id as string | undefined;
  let description = args.description as string | undefined;
  const limit = Math.min(Math.max(1, (args.limit as number) ?? 5), 20);

  if (!agentId && !description) {
    return "Error: provide either agent_id or description to find similar agents";
  }

  // If agent_id given, look up its description via KQL
  if (agentId && !description) {
    const rows = await kfdbKQL(
      `MATCH (n:ERC8004Agent) WHERE n.agent_id = '${agentId.replace(/'/g, "\\'")}' RETURN ${AGENT_FIELDS} LIMIT 1`,
    );
    const agent = rows.length > 0 ? extractKqlNode(rows[0]) : null;
    if (!agent) {
      return `Agent ${agentId} not found in KFDB.`;
    }
    description = (agent.description as string) ?? (agent.name as string);
  }

  if (!description) return "Error: could not determine description for similarity search.";

  // Semantic search via HNSW
  const semanticResults = await kfdbSemanticSearch(description, limit + 5);
  if (semanticResults && semanticResults.length > 0) {
    const agentUuids = semanticResults
      .map((r) => {
        const props = r.properties ? unwrapProps(r.properties as Record<string, unknown>) : r;
        const path = (props.file_path as string) ?? "";
        const match = path.match(/erc8004-agent:\/\/([a-f0-9-]+)\//);
        return match ? match[1] : null;
      })
      .filter(Boolean) as string[];

    if (agentUuids.length > 0) {
      const uuidList = agentUuids.slice(0, limit + 3).map((u) => `'${u}'`).join(", ");
      try {
        const rows = await kfdbKQL(
          `MATCH (n:ERC8004Agent) WHERE n._id IN [${uuidList}] RETURN ${AGENT_FIELDS} LIMIT ${limit + 3}`,
        );
        let agents = rows.map((r) => extractKqlNode(r)).filter(Boolean) as Record<string, unknown>[];
        if (agentId) agents = agents.filter((a) => a.agent_id !== agentId);
        agents = agents.slice(0, limit);

        if (agents.length > 0) {
          const lines = [
            `# Similar Agents`,
            agentId ? `**Reference**: ${agentId}` : `**Query**: "${description.slice(0, 100)}"`,
            `**Source**: Semantic similarity (embeddings)`,
            `**Results**: ${agents.length}\n`,
          ];
          for (let i = 0; i < agents.length; i++) {
            lines.push(`### ${i + 1}. Match`);
            lines.push(formatAgent(agents[i]));
            lines.push("");
          }
          return lines.join("\n");
        }
      } catch {
        // Fall through to keyword search
      }
    }
  }

  // Fallback: keyword overlap on entity scan
  const keywords = description.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
  if (keywords.length === 0) {
    return "Could not extract keywords. Semantic search unavailable — try again later.";
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
      if (matchCount > 0) scored.push({ agent, score: matchCount / keywords.length });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, limit);

  if (top.length === 0) {
    return `No similar agents found. Semantic search may be building — try again later.`;
  }

  const lines = [
    `# Similar Agents`,
    agentId ? `**Reference**: ${agentId}` : `**Query**: "${description.slice(0, 100)}"`,
    `**Source**: Keyword overlap`,
    `**Results**: ${top.length}\n`,
  ];
  for (let i = 0; i < top.length; i++) {
    lines.push(`### ${i + 1}. (${(top[i].score * 100).toFixed(0)}% overlap)`);
    lines.push(formatAgent(top[i].agent));
    lines.push("");
  }
  return lines.join("\n");
}

async function handleEcosystemStats(args: Record<string, unknown>): Promise<string> {
  const chainFilter = args.chain_id as number | undefined;

  const labelsData = await kfdbLabels();
  const labelMap = new Map<string, number>();
  for (const l of labelsData.labels) labelMap.set(l.label, l.count);

  const lines = [
    `# ERC-8004 Ecosystem Statistics (KFDB)`,
    "",
    `## Global Counts`,
    `- **Agents**: ${(labelMap.get("ERC8004Agent") ?? 0).toLocaleString()}`,
    `- **Feedback Entries**: ${(labelMap.get("ERC8004Feedback") ?? 0).toLocaleString()}`,
    `- **Accounts**: ${(labelMap.get("ERC8004Account") ?? 0).toLocaleString()}`,
    `- **Skills**: ${(labelMap.get("ERC8004Skill") ?? 0).toLocaleString()}`,
    `- **Domains**: ${(labelMap.get("ERC8004Domain") ?? 0).toLocaleString()}`,
    `- **Chains**: ${(labelMap.get("ERC8004Chain") ?? 0).toLocaleString()}`,
  ];

  if (chainFilter !== undefined) {
    // Use entity scan for chain-specific stats (limited sample)
    const data = await kfdbEntities("ERC8004Agent", 2000, 0);
    let chainAgents = 0, activeAgents = 0, withEndpoint = 0, totalFb = 0;
    for (const agent of data.items) {
      if (agent.chain_id !== chainFilter) continue;
      chainAgents++;
      if (agent.active === true) activeAgents++;
      if (agent.has_real_endpoint === true) withEndpoint++;
      totalFb += (agent.total_feedback as number) ?? 0;
    }
    lines.push("");
    lines.push(`## ${getChainName(chainFilter)} (Chain ${chainFilter})`);
    lines.push(`- **Agents**: ${chainAgents.toLocaleString()} (from sample of ${data.items.length})`);
    lines.push(`- **Active**: ${activeAgents.toLocaleString()}`);
    lines.push(`- **With Real Endpoints**: ${withEndpoint.toLocaleString()}`);
    lines.push(`- **Total Feedback**: ${totalFb.toLocaleString()}`);
  } else {
    const data = await kfdbEntities("ERC8004Agent", 2000, 0);
    const chainCounts = new Map<number, number>();
    for (const agent of data.items) {
      const chain = agent.chain_id as number;
      chainCounts.set(chain, (chainCounts.get(chain) ?? 0) + 1);
    }
    lines.push("");
    lines.push(`## Chain Distribution (sample of ${data.items.length})`);
    const sorted = [...chainCounts.entries()].sort((a, b) => b[1] - a[1]);
    for (const [chain, count] of sorted) {
      const pct = ((count / data.items.length) * 100).toFixed(1);
      lines.push(`- **${getChainName(chain)}** (${chain}): ${count} (${pct}%)`);
    }
  }

  lines.push("");
  lines.push(`*Data source: KFDB production (ScyllaDB + ClickHouse)*`);
  return lines.join("\n");
}

async function handleFeedbackAnalysis(args: Record<string, unknown>): Promise<string> {
  const agentId = args.agent_id as string;
  if (!agentId) return "Error: agent_id is required (format: chainId:tokenId)";

  const limit = Math.min(Math.max(1, (args.limit as number) ?? 20), 100);

  // Use KQL for targeted feedback lookup instead of scanning 106K entries
  const rows = await kfdbKQL(
    `MATCH (n:ERC8004Feedback) WHERE n.agent_id = '${agentId.replace(/'/g, "\\'")}' RETURN ${FEEDBACK_FIELDS} LIMIT ${limit}`,
  );
  const feedbacks = rows.map((r) => extractKqlNode(r)).filter(Boolean) as Record<string, unknown>[];

  if (feedbacks.length === 0) {
    return `# Feedback Analysis: ${agentId}\n\nNo feedback found for agent ${agentId}. ` +
      `The agent may have no reviews yet.`;
  }

  const scores = feedbacks.map((f) => (f.value as number) ?? 0);
  const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const trust = computeTrustLabel(feedbacks.length, avg);

  const tags = new Map<string, number>();
  for (const f of feedbacks) {
    if (f.tag1) tags.set(f.tag1 as string, (tags.get(f.tag1 as string) ?? 0) + 1);
    if (f.tag2) tags.set(f.tag2 as string, (tags.get(f.tag2 as string) ?? 0) + 1);
  }

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
    lines.push(formatFeedback(fb));
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
      return handleSearchAgents(args);
    case "kfdb_get_agent_details":
      return handleGetAgentDetails(args);
    case "kfdb_find_similar":
      return handleFindSimilar(args);
    case "kfdb_ecosystem_stats":
      return handleEcosystemStats(args);
    case "kfdb_feedback_analysis":
      return handleFeedbackAnalysis(args);
    default:
      return `Unknown KFDB tool: ${name}`;
  }
}
