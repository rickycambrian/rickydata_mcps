import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock agent0-sdk
const mockLoadAgent = vi.fn();
const mockGetAgentOwner = vi.fn();
const mockIsAgentOwner = vi.fn();

vi.mock("agent0-sdk", () => {
  return {
    SDK: vi.fn().mockImplementation(() => ({
      loadAgent: mockLoadAgent,
      getAgentOwner: mockGetAgentOwner,
      isAgentOwner: mockIsAgentOwner,
    })),
  };
});

import {
  ownershipTools,
  handleOwnershipTool,
} from "../src/tools/ownership.js";
import { setDerivedKey, setChainId } from "../src/auth/sdk-client.js";

const OWNER_ADDRESS = "0x1234567890abcdef1234567890abcdef12345678";
const NEW_OWNER_ADDRESS = "0xdeadbeef890abcdef1234567890abcdef12345678".slice(0, 42);

describe("ownership tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setChainId(11155111);
    setDerivedKey("0x" + "aa".repeat(32));

    mockGetAgentOwner.mockResolvedValue(OWNER_ADDRESS);
    mockIsAgentOwner.mockResolvedValue(true);
    mockLoadAgent.mockResolvedValue({
      transfer: vi.fn().mockResolvedValue({
        waitConfirmed: vi.fn().mockResolvedValue({
          result: {},
          receipt: { transactionHash: "0xtransfer_tx" },
        }),
      }),
    });
  });

  // ===========================================================================
  // Tool registration
  // ===========================================================================
  describe("tool registration", () => {
    it("registers 3 ownership tools", () => {
      expect(ownershipTools).toHaveLength(3);
    });

    const expected = ["transfer_agent", "get_agent_owner", "is_agent_owner"];
    for (const name of expected) {
      it(`registers ${name}`, () => {
        const tool = ownershipTools.find((t) => t.name === name);
        expect(tool).toBeDefined();
        expect(tool!.description).toBeTypeOf("string");
        expect(tool!.inputSchema).toBeDefined();
      });
    }
  });

  // ===========================================================================
  // transfer_agent
  // ===========================================================================
  describe("transfer_agent", () => {
    it("transfers agent successfully", async () => {
      const newOwner = "0xabcdef1234567890abcdef1234567890abcdef12";

      const result = (await handleOwnershipTool("transfer_agent", {
        agentId: "11155111:42",
        newOwnerAddress: newOwner,
      })) as {
        success: boolean;
        agentId: string;
        newOwner: string;
        txHash: string;
        chain: string;
        warning: string;
      };

      expect(result.success).toBe(true);
      expect(result.agentId).toBe("11155111:42");
      expect(result.newOwner).toBe(newOwner);
      expect(result.txHash).toBe("0xtransfer_tx");
      expect(result.warning).toContain("irreversible");
    });

    it("calls sdk.loadAgent then agent.transfer with new owner", async () => {
      const newOwner = "0xabcdef1234567890abcdef1234567890abcdef12";
      const mockAgent = {
        transfer: vi.fn().mockResolvedValue({
          waitConfirmed: vi.fn().mockResolvedValue({
            result: {},
            receipt: { transactionHash: "0xtransfer_tx" },
          }),
        }),
      };
      mockLoadAgent.mockResolvedValue(mockAgent);

      await handleOwnershipTool("transfer_agent", {
        agentId: "11155111:42",
        newOwnerAddress: newOwner,
      });

      expect(mockLoadAgent).toHaveBeenCalledWith("11155111:42");
      expect(mockAgent.transfer).toHaveBeenCalledWith(newOwner);
    });

    it("requires authentication", async () => {
      // setDerivedKey("") sets key to "" which is falsy — SDK init fails
      setDerivedKey("");

      const result = (await handleOwnershipTool("transfer_agent", {
        agentId: "11155111:42",
        newOwnerAddress: "0xabcdef1234567890abcdef1234567890abcdef12",
      })) as { error: string };

      expect(result.error).toBeDefined();
      expect(result.error).toContain("authenticated");

      setDerivedKey("0x" + "aa".repeat(32));
    });

    it("returns error for invalid newOwnerAddress (too short)", async () => {
      const result = (await handleOwnershipTool("transfer_agent", {
        agentId: "11155111:42",
        newOwnerAddress: "0xshort",
      })) as { error: string };

      expect(result.error).toContain("Invalid newOwnerAddress");
    });

    it("returns error for newOwnerAddress without 0x prefix", async () => {
      const result = (await handleOwnershipTool("transfer_agent", {
        agentId: "11155111:42",
        newOwnerAddress: "abcdef1234567890abcdef1234567890abcdef12",
      })) as { error: string };

      expect(result.error).toContain("Invalid newOwnerAddress");
    });

    it("includes chain name in response", async () => {
      const result = (await handleOwnershipTool("transfer_agent", {
        agentId: "8453:42",
        newOwnerAddress: "0xabcdef1234567890abcdef1234567890abcdef12",
      })) as { chain: string };

      expect(result.chain).toBe("Base");
    });
  });

  // ===========================================================================
  // get_agent_owner
  // ===========================================================================
  describe("get_agent_owner", () => {
    it("returns owner address for a valid agent", async () => {
      const result = (await handleOwnershipTool("get_agent_owner", {
        agentId: "11155111:42",
      })) as {
        agentId: string;
        owner: string;
        chain: string;
      };

      expect(result.agentId).toBe("11155111:42");
      expect(result.owner).toBe(OWNER_ADDRESS);
      expect(mockGetAgentOwner).toHaveBeenCalledWith("11155111:42");
    });

    it("does not require authentication", async () => {
      setDerivedKey("");

      const result = (await handleOwnershipTool("get_agent_owner", {
        agentId: "11155111:42",
      })) as { owner?: string; error?: string };

      // Should succeed even without auth
      expect(result.error).toBeUndefined();
      expect(result.owner).toBe(OWNER_ADDRESS);

      setDerivedKey("0x" + "aa".repeat(32));
    });

    it("returns error when agentId is missing", async () => {
      const result = (await handleOwnershipTool("get_agent_owner", {})) as {
        error: string;
      };

      expect(result.error).toContain("agentId is required");
    });

    it("includes chain name in response", async () => {
      const result = (await handleOwnershipTool("get_agent_owner", {
        agentId: "8453:42",
      })) as { chain: string };

      expect(result.chain).toBe("Base");
    });

    it("resolves chainId from agentId correctly", async () => {
      const { SDK } = await import("agent0-sdk");

      await handleOwnershipTool("get_agent_owner", {
        agentId: "137:10",
      });

      expect(SDK).toHaveBeenCalledWith(
        expect.objectContaining({ chainId: 137 }),
      );
    });
  });

  // ===========================================================================
  // is_agent_owner
  // ===========================================================================
  describe("is_agent_owner", () => {
    it("checks specific address when provided", async () => {
      const result = (await handleOwnershipTool("is_agent_owner", {
        agentId: "11155111:42",
        address: OWNER_ADDRESS,
      })) as {
        agentId: string;
        address: string;
        isOwner: boolean;
        chain: string;
      };

      expect(result.agentId).toBe("11155111:42");
      expect(result.address).toBe(OWNER_ADDRESS);
      expect(result.isOwner).toBe(true);
      expect(mockIsAgentOwner).toHaveBeenCalledWith("11155111:42", OWNER_ADDRESS);
    });

    it("returns false when address is not the owner", async () => {
      mockIsAgentOwner.mockResolvedValue(false);

      const result = (await handleOwnershipTool("is_agent_owner", {
        agentId: "11155111:42",
        address: "0xdeadbeef1234567890abcdef1234567890abcdef",
      })) as { isOwner: boolean };

      expect(result.isOwner).toBe(false);
    });

    it("checks configured wallet when no address provided", async () => {
      const result = (await handleOwnershipTool("is_agent_owner", {
        agentId: "11155111:42",
      })) as {
        agentId: string;
        isOwner: boolean;
      };

      expect(result.agentId).toBe("11155111:42");
      expect(result.isOwner).toBe(true);
      // Called without address argument when checking configured wallet
      expect(mockIsAgentOwner).toHaveBeenCalledWith("11155111:42");
    });

    it("returns error when no address provided and no wallet configured", async () => {
      // setDerivedKey("") sets key to "" (falsy) — SDK init fails with auth error
      setDerivedKey("");

      const result = (await handleOwnershipTool("is_agent_owner", {
        agentId: "11155111:42",
      })) as { error: string };

      expect(result.error).toBeDefined();
      expect(result.error).toContain("authenticated");

      setDerivedKey("0x" + "aa".repeat(32));
    });

    it("does not require auth when explicit address is given", async () => {
      setDerivedKey("");

      const result = (await handleOwnershipTool("is_agent_owner", {
        agentId: "11155111:42",
        address: OWNER_ADDRESS,
      })) as { isOwner?: boolean; error?: string };

      // Should succeed — explicit address uses read-only SDK
      expect(result.error).toBeUndefined();
      expect(result.isOwner).toBe(true);

      setDerivedKey("0x" + "aa".repeat(32));
    });

    it("returns error when agentId is missing", async () => {
      const result = (await handleOwnershipTool("is_agent_owner", {})) as {
        error: string;
      };

      expect(result.error).toContain("agentId is required");
    });

    it("includes chain name in response", async () => {
      const result = (await handleOwnershipTool("is_agent_owner", {
        agentId: "8453:42",
        address: OWNER_ADDRESS,
      })) as { chain: string };

      expect(result.chain).toBe("Base");
    });
  });

  // ===========================================================================
  // Unknown tool
  // ===========================================================================
  it("returns error for unknown tool", async () => {
    const result = (await handleOwnershipTool("nonexistent", {})) as {
      error: string;
    };
    expect(result.error).toContain("Unknown ownership tool");
  });
});
