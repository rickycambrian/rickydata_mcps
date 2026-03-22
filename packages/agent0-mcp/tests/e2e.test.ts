/**
 * Integration tests against live 8004scan / agent0-sdk API.
 *
 * Run with: LIVE_TESTS=1 npx vitest run tests/e2e.test.ts
 *
 * These tests call the real agent0-sdk which hits the 8004scan subgraph.
 * They are slow (~5-15s each) and require network access.
 * Set EIGHTSCAN_API_KEY to avoid rate limits.
 */
import { describe, it, expect } from "vitest";
import { handleDiscoveryTool } from "../src/tools/discovery.js";

const LIVE = !!process.env.LIVE_TESTS;

describe.skipIf(!LIVE)("e2e: live agent0-sdk via discovery tools", () => {
  it(
    "search_agents: returns agents on default chain (Sepolia)",
    async () => {
      const result = (await handleDiscoveryTool("search_agents", {
        limit: 5,
      })) as {
        count: number;
        totalAvailable: number;
        chainId: number;
        agents: Array<{
          agentId: string;
          name: string;
          trust: string;
        }>;
      };

      expect(result.count).toBeGreaterThan(0);
      expect(result.count).toBeLessThanOrEqual(5);
      expect(result.totalAvailable).toBeGreaterThan(0);

      // Each agent should have required fields
      for (const agent of result.agents) {
        expect(agent.agentId).toBeTypeOf("string");
        expect(agent.agentId).toContain(":");
        expect(agent.name).toBeTypeOf("string");
        expect(agent.trust).toBeTypeOf("string");
      }
    },
    30_000,
  );

  it(
    "search_agents: name filter returns matching results",
    async () => {
      const result = (await handleDiscoveryTool("search_agents", {
        name: "test",
        limit: 10,
      })) as {
        count: number;
        agents: Array<{ name: string }>;
      };

      // May return 0 if no agents match, but should not error
      expect(result.count).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(result.agents)).toBe(true);
    },
    30_000,
  );

  it(
    "get_agent: returns a known agent profile",
    async () => {
      // First search to find a real agent ID
      const searchResult = (await handleDiscoveryTool("search_agents", {
        limit: 1,
      })) as {
        agents: Array<{ agentId: string }>;
      };

      expect(searchResult.agents.length).toBeGreaterThan(0);
      const agentId = searchResult.agents[0].agentId;

      const result = (await handleDiscoveryTool("get_agent", {
        agentId,
      })) as {
        agentId: string;
        name: string;
        reputation: {
          count: number;
          averageValue: number;
          trustLabel: string;
          trustDisplay: string;
        };
        chain: string;
      };

      expect(result.agentId).toBe(agentId);
      expect(result.name).toBeTypeOf("string");
      expect(result.reputation).toBeDefined();
      expect(result.reputation.trustLabel).toBeTypeOf("string");
      expect(result.chain).toBeTypeOf("string");
    },
    30_000,
  );

  it(
    "get_agent: returns error for nonexistent agent",
    async () => {
      const result = (await handleDiscoveryTool("get_agent", {
        agentId: "11155111:999999999",
      })) as { error?: string };

      expect(result.error).toBeDefined();
      expect(result.error).toContain("not found");
    },
    30_000,
  );

  it(
    "get_supported_chains: returns chain list with contract addresses",
    async () => {
      const result = (await handleDiscoveryTool(
        "get_supported_chains",
        {},
      )) as {
        count: number;
        chains: Array<{
          chainId: number;
          name: string;
          identity: string;
          reputation: string;
          hasSubgraph: boolean;
        }>;
        note: string;
      };

      expect(result.count).toBeGreaterThanOrEqual(3);
      expect(result.chains.length).toBe(result.count);

      // Verify known chains are present
      const chainIds = result.chains.map((c) => c.chainId);
      expect(chainIds).toContain(1); // Ethereum
      expect(chainIds).toContain(8453); // Base
      expect(chainIds).toContain(11155111); // Sepolia

      // Each chain has contract addresses
      for (const chain of result.chains) {
        expect(chain.identity).toMatch(/^0x[0-9a-fA-F]{40}$/);
        expect(chain.reputation).toMatch(/^0x[0-9a-fA-F]{40}$/);
      }
    },
    15_000,
  );

  it(
    "get_platform_stats: returns aggregate stats for Sepolia",
    async () => {
      const result = (await handleDiscoveryTool("get_platform_stats", {
        chainId: 11155111,
      })) as {
        chainId: number;
        chain: string;
        totalAgents: number;
        activeAgents: number;
        agentsWithMCP: number;
        agentsWithA2A: number;
        agentsWithX402: number;
        totalMCPTools: number;
      };

      expect(result.chainId).toBe(11155111);
      expect(result.totalAgents).toBeGreaterThan(0);
      expect(result.activeAgents).toBeGreaterThanOrEqual(0);
      expect(result.activeAgents).toBeLessThanOrEqual(result.totalAgents);
    },
    30_000,
  );

  it(
    "get_reputation_summary: returns trust label for an agent",
    async () => {
      // Find a real agent first
      const searchResult = (await handleDiscoveryTool("search_agents", {
        limit: 1,
      })) as { agents: Array<{ agentId: string }> };
      const agentId = searchResult.agents[0].agentId;

      const result = (await handleDiscoveryTool("get_reputation_summary", {
        agentId,
      })) as {
        agentId: string;
        count: number;
        averageValue: number;
        trustLabel: string;
        trustEmoji: string;
        trustDisplay: string;
      };

      expect(result.agentId).toBe(agentId);
      expect(result.count).toBeGreaterThanOrEqual(0);
      expect(result.trustLabel).toBeTypeOf("string");
      expect(result.trustEmoji).toBeTypeOf("string");
    },
    30_000,
  );

  it(
    "search_feedback: returns feedback entries (may be empty)",
    async () => {
      // Find a real agent first
      const searchResult = (await handleDiscoveryTool("search_agents", {
        limit: 1,
      })) as { agents: Array<{ agentId: string }> };
      const agentId = searchResult.agents[0].agentId;

      const result = (await handleDiscoveryTool("search_feedback", {
        agentId,
      })) as {
        count: number;
        feedbacks: Array<{
          agentId: string;
          reviewer: string;
          value: number;
        }>;
      };

      expect(result.count).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(result.feedbacks)).toBe(true);

      // If any feedback exists, verify shape
      if (result.feedbacks.length > 0) {
        const fb = result.feedbacks[0];
        expect(fb.agentId).toBeTypeOf("string");
        expect(fb.value).toBeTypeOf("number");
      }
    },
    30_000,
  );
});
