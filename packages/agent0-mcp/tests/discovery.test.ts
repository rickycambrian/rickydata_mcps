import { describe, it, expect, vi, beforeEach } from "vitest";
import { discoveryTools, handleDiscoveryTool } from "../src/tools/discovery.js";

// Mock agent0-sdk so tests don't hit the real API
vi.mock("agent0-sdk", () => {
  const mockSearchAgents = vi.fn();
  const mockGetAgent = vi.fn();
  const mockGetReputationSummary = vi.fn();
  const mockSearchFeedback = vi.fn();

  return {
    SDK: vi.fn().mockImplementation(() => ({
      searchAgents: mockSearchAgents,
      getAgent: mockGetAgent,
      getReputationSummary: mockGetReputationSummary,
      searchFeedback: mockSearchFeedback,
    })),
    __mocks: {
      mockSearchAgents,
      mockGetAgent,
      mockGetReputationSummary,
      mockSearchFeedback,
    },
  };
});

// Access mock functions
async function getMocks() {
  const mod = await import("agent0-sdk");
  return (mod as unknown as { __mocks: Record<string, ReturnType<typeof vi.fn>> }).__mocks;
}

function makeAgent(overrides: Record<string, unknown> = {}) {
  return {
    agentId: "11155111:42",
    chainId: 11155111,
    name: "Test Agent",
    description: "A test agent",
    image: "https://example.com/img.png",
    active: true,
    x402support: false,
    owners: ["0x1234567890abcdef1234567890abcdef12345678"],
    walletAddress: "0x1234567890abcdef1234567890abcdef12345678",
    mcp: null,
    a2a: null,
    web: null,
    ens: null,
    mcpTools: [],
    a2aSkills: [],
    oasfSkills: [],
    oasfDomains: [],
    supportedTrusts: [],
    feedbackCount: 0,
    averageValue: 0,
    updatedAt: 1700000000,
    ...overrides,
  };
}

describe("discovery tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // Tool registration
  // ===========================================================================
  describe("tool registration", () => {
    it("registers 6 discovery tools", () => {
      expect(discoveryTools).toHaveLength(6);
    });

    const expectedTools = [
      "search_agents",
      "get_agent",
      "get_supported_chains",
      "get_platform_stats",
      "get_reputation_summary",
      "search_feedback",
    ];

    for (const toolName of expectedTools) {
      it(`registers ${toolName}`, () => {
        const tool = discoveryTools.find((t) => t.name === toolName);
        expect(tool).toBeDefined();
        expect(tool!.description).toBeTypeOf("string");
        expect(tool!.description.length).toBeGreaterThan(10);
        expect(tool!.inputSchema).toBeDefined();
      });
    }
  });

  // ===========================================================================
  // search_agents
  // ===========================================================================
  describe("search_agents", () => {
    it("returns formatted agents with trust labels", async () => {
      const mocks = await getMocks();
      mocks.mockSearchAgents.mockResolvedValue([
        makeAgent({ feedbackCount: 25, averageValue: 90 }),
      ]);

      const result = (await handleDiscoveryTool("search_agents", {})) as {
        count: number;
        agents: Array<{ trust: string }>;
      };

      expect(result.count).toBe(1);
      expect(result.agents[0].trust).toContain("Highly Trusted");
    });

    it("respects limit parameter", async () => {
      const mocks = await getMocks();
      const manyAgents = Array.from({ length: 50 }, (_, i) =>
        makeAgent({ agentId: `11155111:${i}` }),
      );
      mocks.mockSearchAgents.mockResolvedValue(manyAgents);

      const result = (await handleDiscoveryTool("search_agents", {
        limit: 5,
      })) as { count: number; totalAvailable: number };

      expect(result.count).toBe(5);
      expect(result.totalAvailable).toBe(50);
    });

    it("caps limit at 100", async () => {
      const mocks = await getMocks();
      const agents = Array.from({ length: 150 }, (_, i) =>
        makeAgent({ agentId: `11155111:${i}` }),
      );
      mocks.mockSearchAgents.mockResolvedValue(agents);

      const result = (await handleDiscoveryTool("search_agents", {
        limit: 200,
      })) as { count: number };

      expect(result.count).toBe(100);
    });

    it("handles empty results", async () => {
      const mocks = await getMocks();
      mocks.mockSearchAgents.mockResolvedValue([]);

      const result = (await handleDiscoveryTool("search_agents", {
        name: "nonexistent",
      })) as { count: number; agents: unknown[] };

      expect(result.count).toBe(0);
      expect(result.agents).toEqual([]);
    });

    it("passes filter parameters to SDK", async () => {
      const mocks = await getMocks();
      mocks.mockSearchAgents.mockResolvedValue([]);

      await handleDiscoveryTool("search_agents", {
        name: "defi",
        active: true,
        x402support: true,
        hasMCP: true,
      });

      expect(mocks.mockSearchAgents).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "defi",
          active: true,
          x402support: true,
          hasMCP: true,
        }),
        expect.any(Object),
      );
    });
  });

  // ===========================================================================
  // get_agent
  // ===========================================================================
  describe("get_agent", () => {
    it("returns full agent profile with reputation", async () => {
      const mocks = await getMocks();
      mocks.mockGetAgent.mockResolvedValue(
        makeAgent({ name: "DeFi Bot", feedbackCount: 10, averageValue: 75 }),
      );
      mocks.mockGetReputationSummary.mockResolvedValue({
        count: 10,
        averageValue: 75,
      });

      const result = (await handleDiscoveryTool("get_agent", {
        agentId: "11155111:42",
      })) as { name: string; reputation: { trustLabel: string }; chain: string };

      expect(result.name).toBe("DeFi Bot");
      expect(result.reputation.trustLabel).toBe("Trusted");
      expect(result.chain).toContain("Chain"); // getChainName for 11155111 returns fallback
    });

    it("returns error for missing agentId", async () => {
      const result = (await handleDiscoveryTool("get_agent", {})) as {
        error: string;
      };
      expect(result.error).toContain("agentId is required");
    });

    it("returns error for invalid agentId format", async () => {
      const result = (await handleDiscoveryTool("get_agent", {
        agentId: "invalid",
      })) as { error: string };
      expect(result.error).toContain("Invalid agentId format");
    });

    it("returns error when agent not found", async () => {
      const mocks = await getMocks();
      mocks.mockGetAgent.mockResolvedValue(null);

      const result = (await handleDiscoveryTool("get_agent", {
        agentId: "11155111:99999",
      })) as { error: string };
      expect(result.error).toContain("not found");
    });

    it("handles reputation fetch failure gracefully", async () => {
      const mocks = await getMocks();
      mocks.mockGetAgent.mockResolvedValue(makeAgent());
      mocks.mockGetReputationSummary.mockRejectedValue(
        new Error("Reputation unavailable"),
      );

      const result = (await handleDiscoveryTool("get_agent", {
        agentId: "11155111:42",
      })) as { reputation: { count: number; averageValue: number } };

      // Should still return agent with default reputation
      expect(result.reputation.count).toBe(0);
      expect(result.reputation.averageValue).toBe(0);
    });
  });

  // ===========================================================================
  // get_supported_chains
  // ===========================================================================
  describe("get_supported_chains", () => {
    it("returns chain list with count", async () => {
      const result = (await handleDiscoveryTool(
        "get_supported_chains",
        {},
      )) as { count: number; chains: Array<{ chainId: number; name: string }> };

      expect(result.count).toBeGreaterThan(0);
      expect(result.chains.length).toBe(result.count);
    });

    it("includes Ethereum Mainnet and Base", async () => {
      const result = (await handleDiscoveryTool(
        "get_supported_chains",
        {},
      )) as { chains: Array<{ chainId: number }> };

      const chainIds = result.chains.map((c) => c.chainId);
      expect(chainIds).toContain(1);
      expect(chainIds).toContain(8453);
    });

    it("each chain has required fields", async () => {
      const result = (await handleDiscoveryTool(
        "get_supported_chains",
        {},
      )) as {
        chains: Array<{
          chainId: number;
          name: string;
          identity: string;
          reputation: string;
          hasSubgraph: boolean;
        }>;
      };

      for (const chain of result.chains) {
        expect(chain.chainId).toBeTypeOf("number");
        expect(chain.name).toBeTypeOf("string");
        expect(chain.identity).toMatch(/^0x/);
        expect(chain.reputation).toMatch(/^0x/);
        expect(chain.hasSubgraph).toBeTypeOf("boolean");
      }
    });
  });

  // ===========================================================================
  // get_platform_stats
  // ===========================================================================
  describe("get_platform_stats", () => {
    it("returns aggregate stats", async () => {
      const mocks = await getMocks();
      mocks.mockSearchAgents.mockResolvedValue([
        makeAgent({ active: true, mcp: "https://mcp.test", x402support: true }),
        makeAgent({ active: false, a2a: "https://a2a.test", feedbackCount: 5 }),
        makeAgent({ active: true }),
      ]);

      const result = (await handleDiscoveryTool("get_platform_stats", {})) as {
        totalAgents: number;
        activeAgents: number;
        agentsWithMCP: number;
        agentsWithA2A: number;
        agentsWithX402: number;
        agentsWithFeedback: number;
      };

      expect(result.totalAgents).toBe(3);
      expect(result.activeAgents).toBe(2);
      expect(result.agentsWithMCP).toBe(1);
      expect(result.agentsWithA2A).toBe(1);
      expect(result.agentsWithX402).toBe(1);
      expect(result.agentsWithFeedback).toBe(1);
    });

    it("uses provided chainId", async () => {
      const mocks = await getMocks();
      mocks.mockSearchAgents.mockResolvedValue([]);
      const { SDK } = await import("agent0-sdk");

      await handleDiscoveryTool("get_platform_stats", { chainId: 8453 });

      expect(SDK).toHaveBeenCalledWith(
        expect.objectContaining({ chainId: 8453 }),
      );
    });
  });

  // ===========================================================================
  // get_reputation_summary
  // ===========================================================================
  describe("get_reputation_summary", () => {
    it("returns reputation with trust label", async () => {
      const mocks = await getMocks();
      mocks.mockGetReputationSummary.mockResolvedValue({
        count: 15,
        averageValue: 72,
      });

      const result = (await handleDiscoveryTool("get_reputation_summary", {
        agentId: "11155111:42",
      })) as { trustLabel: string; count: number; averageValue: number };

      expect(result.count).toBe(15);
      expect(result.averageValue).toBe(72);
      expect(result.trustLabel).toBe("Trusted");
    });

    it("returns error for missing agentId", async () => {
      const result = (await handleDiscoveryTool(
        "get_reputation_summary",
        {},
      )) as { error: string };
      expect(result.error).toContain("agentId is required");
    });

    it("returns error for invalid format", async () => {
      const result = (await handleDiscoveryTool("get_reputation_summary", {
        agentId: "bad-format",
      })) as { error: string };
      expect(result.error).toContain("Invalid agentId format");
    });

    it("passes tag to SDK", async () => {
      const mocks = await getMocks();
      mocks.mockGetReputationSummary.mockResolvedValue({
        count: 0,
        averageValue: 0,
      });

      await handleDiscoveryTool("get_reputation_summary", {
        agentId: "11155111:42",
        tag: "quality",
      });

      expect(mocks.mockGetReputationSummary).toHaveBeenCalledWith(
        "11155111:42",
        "quality",
      );
    });
  });

  // ===========================================================================
  // search_feedback
  // ===========================================================================
  describe("search_feedback", () => {
    it("returns formatted feedback entries", async () => {
      const mocks = await getMocks();
      mocks.mockSearchFeedback.mockResolvedValue([
        {
          agentId: "11155111:42",
          reviewer: "0xabc",
          value: 85,
          tags: ["quality"],
          text: "Great agent",
          endpoint: "mcp",
          isRevoked: false,
          createdAt: 1700000000,
          mcpTool: "search",
          a2aSkills: [],
        },
      ]);

      const result = (await handleDiscoveryTool("search_feedback", {
        agentId: "11155111:42",
      })) as { count: number; feedbacks: Array<{ value: number }> };

      expect(result.count).toBe(1);
      expect(result.feedbacks[0].value).toBe(85);
    });

    it("returns error when no agent specified", async () => {
      const result = (await handleDiscoveryTool("search_feedback", {})) as {
        error: string;
      };
      expect(result.error).toContain("Provide agentId or agents[]");
    });

    it("caps results at 50", async () => {
      const mocks = await getMocks();
      const manyFeedbacks = Array.from({ length: 60 }, (_, i) => ({
        agentId: "11155111:42",
        reviewer: `0x${i}`,
        value: 50,
        tags: [],
        text: "",
        endpoint: null,
        isRevoked: false,
        createdAt: 1700000000,
        mcpTool: null,
        a2aSkills: [],
      }));
      mocks.mockSearchFeedback.mockResolvedValue(manyFeedbacks);

      const result = (await handleDiscoveryTool("search_feedback", {
        agentId: "11155111:42",
      })) as { count: number; feedbacks: unknown[] };

      expect(result.count).toBe(60);
      expect(result.feedbacks).toHaveLength(50);
    });
  });

  // ===========================================================================
  // Unknown tool
  // ===========================================================================
  it("returns error for unknown tool name", async () => {
    const result = (await handleDiscoveryTool("nonexistent", {})) as {
      error: string;
    };
    expect(result.error).toContain("Unknown discovery tool");
  });
});
