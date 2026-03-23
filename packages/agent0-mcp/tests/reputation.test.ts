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
  const mockGetFeedback = vi.fn().mockResolvedValue({
    value: 80,
    tags: ["quality"],
    text: "Great agent",
    endpoint: "mcp",
    mcpTool: "search",
    a2aSkills: [],
    isRevoked: false,
    createdAt: 1700000000,
    response: null,
  });
  const mockAppendResponse = vi.fn().mockResolvedValue({
    waitConfirmed: vi.fn().mockResolvedValue({
      result: {},
      receipt: { transactionHash: "0xresponse_tx" },
    }),
  });

  return {
    SDK: vi.fn().mockImplementation(() => ({
      giveFeedback: mockGiveFeedback,
      revokeFeedback: mockRevokeFeedback,
      prepareFeedbackFile: mockPrepareFeedbackFile,
      chainId: mockChainId,
      getFeedback: mockGetFeedback,
      appendResponse: mockAppendResponse,
    })),
    __mocks: {
      mockGiveFeedback,
      mockRevokeFeedback,
      mockPrepareFeedbackFile,
      mockGetFeedback,
      mockAppendResponse,
    },
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
    it("registers 4 reputation tools", () => {
      expect(reputationTools).toHaveLength(4);
    });

    it("registers give_feedback", () => {
      expect(reputationTools.find((t) => t.name === "give_feedback")).toBeDefined();
    });

    it("registers revoke_feedback", () => {
      expect(reputationTools.find((t) => t.name === "revoke_feedback")).toBeDefined();
    });

    it("registers get_feedback", () => {
      expect(reputationTools.find((t) => t.name === "get_feedback")).toBeDefined();
    });

    it("registers append_feedback_response", () => {
      expect(reputationTools.find((t) => t.name === "append_feedback_response")).toBeDefined();
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
  // get_feedback
  // ===========================================================================
  describe("get_feedback", () => {
    it("returns feedback details for a valid entry", async () => {
      const mocks = await getMocks();

      const result = (await handleReputationTool("get_feedback", {
        agentId: "11155111:42",
        clientAddress: "0xabc1234567890abcdef1234567890abcdef123456",
        feedbackIndex: 0,
      })) as {
        agentId: string;
        clientAddress: string;
        feedbackIndex: number;
        chain: string;
        feedback: {
          value: number;
          tags: string[];
          text: string;
          isRevoked: boolean;
          response: null;
        };
      };

      expect(result.agentId).toBe("11155111:42");
      expect(result.clientAddress).toBe("0xabc1234567890abcdef1234567890abcdef123456");
      expect(result.feedbackIndex).toBe(0);
      expect(result.feedback.value).toBe(80);
      expect(result.feedback.tags).toContain("quality");
      expect(result.feedback.isRevoked).toBe(false);
      expect(result.feedback.response).toBeNull();
      expect(mocks.mockGetFeedback).toHaveBeenCalledWith(
        "11155111:42",
        "0xabc1234567890abcdef1234567890abcdef123456",
        0,
      );
    });

    it("does not require authentication", async () => {
      // Clear auth — get_feedback is read-only
      setDerivedKey("");
      const result = (await handleReputationTool("get_feedback", {
        agentId: "11155111:42",
        clientAddress: "0xabc1234567890abcdef1234567890abcdef123456",
        feedbackIndex: 0,
      })) as { feedback?: unknown; error?: string };

      // Should succeed even without auth
      expect(result.error).toBeUndefined();
      expect(result.feedback).toBeDefined();

      // Restore auth for subsequent tests
      setDerivedKey("0x" + "aa".repeat(32));
    });

    it("returns error when feedback not found", async () => {
      const mocks = await getMocks();
      mocks.mockGetFeedback.mockResolvedValueOnce(null);

      const result = (await handleReputationTool("get_feedback", {
        agentId: "11155111:42",
        clientAddress: "0xabc1234567890abcdef1234567890abcdef123456",
        feedbackIndex: 99,
      })) as { error: string };

      expect(result.error).toContain("Feedback not found");
    });

    it("returns error when agentId is missing", async () => {
      const result = (await handleReputationTool("get_feedback", {
        clientAddress: "0xabc",
        feedbackIndex: 0,
      })) as { error: string };

      expect(result.error).toContain("agentId is required");
    });

    it("returns error when clientAddress is missing", async () => {
      const result = (await handleReputationTool("get_feedback", {
        agentId: "11155111:42",
        feedbackIndex: 0,
      })) as { error: string };

      expect(result.error).toContain("clientAddress is required");
    });

    it("includes chain name derived from agentId", async () => {
      const result = (await handleReputationTool("get_feedback", {
        agentId: "8453:42",
        clientAddress: "0xabc1234567890abcdef1234567890abcdef123456",
        feedbackIndex: 0,
      })) as { chain: string };

      expect(result.chain).toBe("Base");
    });

    it("returns feedback with response text when present", async () => {
      const mocks = await getMocks();
      mocks.mockGetFeedback.mockResolvedValueOnce({
        value: 90,
        tags: ["quality"],
        text: "Excellent!",
        endpoint: null,
        mcpTool: null,
        a2aSkills: [],
        isRevoked: false,
        createdAt: 1700000000,
        response: "Thank you for the review!",
      });

      const result = (await handleReputationTool("get_feedback", {
        agentId: "11155111:42",
        clientAddress: "0xabc1234567890abcdef1234567890abcdef123456",
        feedbackIndex: 2,
      })) as { feedback: { response: string } };

      expect(result.feedback.response).toBe("Thank you for the review!");
    });
  });

  // ===========================================================================
  // append_feedback_response
  // ===========================================================================
  describe("append_feedback_response", () => {
    it("appends response successfully", async () => {
      const mocks = await getMocks();

      const result = (await handleReputationTool("append_feedback_response", {
        agentId: "11155111:42",
        clientAddress: "0xabc1234567890abcdef1234567890abcdef123456",
        feedbackIndex: 0,
        responseText: "Thank you for the feedback!",
      })) as {
        success: boolean;
        agentId: string;
        clientAddress: string;
        feedbackIndex: number;
        txHash: string;
        chain: string;
      };

      expect(result.success).toBe(true);
      expect(result.agentId).toBe("11155111:42");
      expect(result.clientAddress).toBe("0xabc1234567890abcdef1234567890abcdef123456");
      expect(result.feedbackIndex).toBe(0);
      expect(result.txHash).toBe("0xresponse_tx");
      expect(mocks.mockAppendResponse).toHaveBeenCalledWith(
        "11155111:42",
        "0xabc1234567890abcdef1234567890abcdef123456",
        0,
        { text: "Thank you for the feedback!" },
      );
    });

    it("requires authentication", async () => {
      // setDerivedKey("") sets key to "" (falsy) — SDK init fails with auth error
      setDerivedKey("");

      const result = (await handleReputationTool("append_feedback_response", {
        agentId: "11155111:42",
        clientAddress: "0xabc",
        feedbackIndex: 0,
        responseText: "Thanks!",
      })) as { error: string };

      expect(result.error).toBeDefined();
      expect(result.error).toContain("authenticated");

      // Restore auth
      setDerivedKey("0x" + "aa".repeat(32));
    });

    it("returns error when agentId is missing", async () => {
      const result = (await handleReputationTool("append_feedback_response", {
        clientAddress: "0xabc",
        feedbackIndex: 0,
        responseText: "Thanks!",
      })) as { error: string };

      expect(result.error).toContain("agentId is required");
    });

    it("returns error when responseText is missing", async () => {
      const result = (await handleReputationTool("append_feedback_response", {
        agentId: "11155111:42",
        clientAddress: "0xabc",
        feedbackIndex: 0,
      })) as { error: string };

      expect(result.error).toContain("responseText is required");
    });

    it("includes chain name in response", async () => {
      const result = (await handleReputationTool("append_feedback_response", {
        agentId: "8453:42",
        clientAddress: "0xabc1234567890abcdef1234567890abcdef123456",
        feedbackIndex: 1,
        responseText: "We appreciate the review!",
      })) as { chain: string };

      expect(result.chain).toBe("Base");
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
