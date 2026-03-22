import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock agent0-sdk
vi.mock("agent0-sdk", () => {
  const mockGiveFeedback = vi.fn().mockResolvedValue({
    waitConfirmed: vi.fn().mockResolvedValue({
      result: {},
      receipt: { transactionHash: "0xfeedback_tx" },
    }),
  });
  const mockRevokeFeedback = vi.fn().mockResolvedValue({
    waitConfirmed: vi.fn().mockResolvedValue({
      result: {},
      receipt: { transactionHash: "0xrevoke_tx" },
    }),
  });
  const mockPrepareFeedbackFile = vi.fn().mockReturnValue({ uri: "ipfs://feedback" });
  const mockChainId = vi.fn().mockResolvedValue(11155111);

  return {
    SDK: vi.fn().mockImplementation(() => ({
      giveFeedback: mockGiveFeedback,
      revokeFeedback: mockRevokeFeedback,
      prepareFeedbackFile: mockPrepareFeedbackFile,
      chainId: mockChainId,
    })),
    __mocks: { mockGiveFeedback, mockRevokeFeedback, mockPrepareFeedbackFile },
  };
});

import {
  reputationTools,
  handleReputationTool,
} from "../src/tools/reputation.js";
import { setDerivedKey, setChainId } from "../src/auth/sdk-client.js";

async function getMocks() {
  const mod = await import("agent0-sdk");
  return (mod as unknown as { __mocks: Record<string, ReturnType<typeof vi.fn>> }).__mocks;
}

describe("reputation tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setChainId(11155111);
    // Ensure auth is available for write tests
    setDerivedKey("0x" + "aa".repeat(32));
  });

  // ===========================================================================
  // Tool registration
  // ===========================================================================
  describe("tool registration", () => {
    it("registers 2 reputation tools", () => {
      expect(reputationTools).toHaveLength(2);
    });

    it("registers give_feedback", () => {
      expect(reputationTools.find((t) => t.name === "give_feedback")).toBeDefined();
    });

    it("registers revoke_feedback", () => {
      expect(reputationTools.find((t) => t.name === "revoke_feedback")).toBeDefined();
    });
  });

  // ===========================================================================
  // give_feedback
  // ===========================================================================
  describe("give_feedback", () => {
    it("submits feedback successfully", async () => {
      const mocks = await getMocks();

      const result = (await handleReputationTool("give_feedback", {
        agentId: "11155111:42",
        value: 85,
        tag1: "quality",
      })) as { success: boolean; value: number; txHash: string; tags: string[] };

      expect(result.success).toBe(true);
      expect(result.value).toBe(85);
      expect(result.txHash).toBe("0xfeedback_tx");
      expect(result.tags).toContain("quality");
      expect(mocks.mockGiveFeedback).toHaveBeenCalledWith(
        "11155111:42",
        85,
        "quality",
        undefined,
        undefined,
        undefined,
      );
    });

    it("rejects value below 0", async () => {
      const result = (await handleReputationTool("give_feedback", {
        agentId: "11155111:42",
        value: -1,
      })) as { error: string };

      expect(result.error).toContain("between 0 and 100");
    });

    it("rejects value above 100", async () => {
      const result = (await handleReputationTool("give_feedback", {
        agentId: "11155111:42",
        value: 101,
      })) as { error: string };

      expect(result.error).toContain("between 0 and 100");
    });

    it("accepts boundary value 0", async () => {
      const result = (await handleReputationTool("give_feedback", {
        agentId: "11155111:42",
        value: 0,
      })) as { success: boolean; value: number };

      expect(result.success).toBe(true);
      expect(result.value).toBe(0);
    });

    it("accepts boundary value 100", async () => {
      const result = (await handleReputationTool("give_feedback", {
        agentId: "11155111:42",
        value: 100,
      })) as { success: boolean; value: number };

      expect(result.success).toBe(true);
      expect(result.value).toBe(100);
    });

    it("prepares feedback file when text is provided", async () => {
      const mocks = await getMocks();

      await handleReputationTool("give_feedback", {
        agentId: "11155111:42",
        value: 75,
        text: "Great agent!",
      });

      expect(mocks.mockPrepareFeedbackFile).toHaveBeenCalledWith({
        text: "Great agent!",
        mcpTool: undefined,
        a2aSkills: undefined,
      });
    });

    it("prepares feedback file when mcpTool is provided", async () => {
      const mocks = await getMocks();

      await handleReputationTool("give_feedback", {
        agentId: "11155111:42",
        value: 80,
        mcpTool: "search",
      });

      expect(mocks.mockPrepareFeedbackFile).toHaveBeenCalled();
    });

    it("passes both tags", async () => {
      const result = (await handleReputationTool("give_feedback", {
        agentId: "11155111:42",
        value: 90,
        tag1: "quality",
        tag2: "reliability",
      })) as { tags: string[] };

      expect(result.tags).toEqual(["quality", "reliability"]);
    });

    it("extracts chainId from agentId", async () => {
      const result = (await handleReputationTool("give_feedback", {
        agentId: "8453:100",
        value: 70,
      })) as { chain: string };

      expect(result.chain).toBe("Base");
    });
  });

  // ===========================================================================
  // revoke_feedback
  // ===========================================================================
  describe("revoke_feedback", () => {
    it("revokes feedback successfully", async () => {
      const mocks = await getMocks();

      const result = (await handleReputationTool("revoke_feedback", {
        agentId: "11155111:42",
        feedbackIndex: 0,
      })) as {
        success: boolean;
        feedbackIndex: number;
        isRevoked: boolean;
        txHash: string;
      };

      expect(result.success).toBe(true);
      expect(result.feedbackIndex).toBe(0);
      expect(result.isRevoked).toBe(true);
      expect(result.txHash).toBe("0xrevoke_tx");
      expect(mocks.mockRevokeFeedback).toHaveBeenCalledWith("11155111:42", 0);
    });
  });

  // ===========================================================================
  // requireAuth guard
  // ===========================================================================
  describe("requireAuth guard", () => {
    it("give_feedback includes auth info in response", async () => {
      // Auth is set in beforeEach, so this should succeed
      const result = (await handleReputationTool("give_feedback", {
        agentId: "11155111:42",
        value: 50,
      })) as { success?: boolean; error?: string };

      // Should succeed since we set derived key in beforeEach
      expect(result.success).toBe(true);
    });
  });

  // ===========================================================================
  // Unknown tool
  // ===========================================================================
  it("returns error for unknown tool", async () => {
    const result = (await handleReputationTool("nonexistent", {})) as {
      error: string;
    };
    expect(result.error).toContain("Unknown reputation tool");
  });
});
