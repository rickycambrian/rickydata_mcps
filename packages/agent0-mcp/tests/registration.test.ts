import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock agent0-sdk
const mockChainId = vi.fn().mockResolvedValue(11155111);
const mockCreateAgent = vi.fn();
const mockLoadAgent = vi.fn();

vi.mock("agent0-sdk", () => {
  return {
    SDK: vi.fn().mockImplementation(() => ({
      chainId: mockChainId,
      createAgent: mockCreateAgent,
      loadAgent: mockLoadAgent,
    })),
  };
});

// Mock wallet-derivation
vi.mock("../src/auth/wallet-derivation.js", async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    deriveWalletFromSignature: vi.fn().mockReturnValue({
      address: "0xDerivedAddress1234",
      privateKey: "0x" + "ab".repeat(32),
    }),
    verifyDerivationSignature: vi.fn().mockReturnValue(true),
  };
});

import {
  registrationTools,
  handleRegistrationTool,
} from "../src/tools/registration.js";
import {
  setDerivedKey,
  setChainId,
} from "../src/auth/sdk-client.js";
import { verifyDerivationSignature } from "../src/auth/wallet-derivation.js";

function makeAgentBuilder() {
  const builder = {
    setMCP: vi.fn(),
    setA2A: vi.fn(),
    setTrust: vi.fn(),
    setActive: vi.fn(),
    setMetadata: vi.fn(),
    registerIPFS: vi.fn().mockResolvedValue({
      waitConfirmed: vi.fn().mockResolvedValue({
        result: { agentId: "11155111:99", agentURI: "ipfs://Qm..." },
        receipt: { transactionHash: "0xtxhash123" },
      }),
    }),
    registerOnChain: vi.fn().mockResolvedValue({
      waitConfirmed: vi.fn().mockResolvedValue({
        result: { agentId: "11155111:99", agentURI: "data:..." },
        receipt: { transactionHash: "0xtxhash456" },
      }),
    }),
    updateInfo: vi.fn(),
  };
  return builder;
}

describe("registration tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setChainId(11155111);
  });

  // ===========================================================================
  // Tool registration
  // ===========================================================================
  describe("tool registration", () => {
    it("registers 5 registration tools", () => {
      expect(registrationTools).toHaveLength(5);
    });

    const expected = [
      "configure_wallet",
      "get_derivation_message",
      "get_auth_status",
      "register_agent",
      "update_agent",
    ];
    for (const name of expected) {
      it(`registers ${name}`, () => {
        expect(registrationTools.find((t) => t.name === name)).toBeDefined();
      });
    }
  });

  // ===========================================================================
  // get_derivation_message
  // ===========================================================================
  describe("get_derivation_message", () => {
    it("returns message and instructions", async () => {
      const result = (await handleRegistrationTool(
        "get_derivation_message",
        {},
      )) as { message: string; instructions: string };

      expect(result.message).toBeTypeOf("string");
      expect(result.message.length).toBeGreaterThan(0);
      expect(result.instructions).toContain("personal_sign");
    });
  });

  // ===========================================================================
  // get_auth_status
  // ===========================================================================
  describe("get_auth_status", () => {
    it("returns status object", async () => {
      const result = (await handleRegistrationTool(
        "get_auth_status",
        {},
      )) as { hasKey: boolean; chainId: number; source: string; isReadOnly: boolean };

      expect(result.chainId).toBeTypeOf("number");
      expect(result.source).toBeTypeOf("string");
      expect(result.isReadOnly).toBeTypeOf("boolean");
    });
  });

  // ===========================================================================
  // configure_wallet
  // ===========================================================================
  describe("configure_wallet", () => {
    it("configures with direct private key", async () => {
      const key = "0x" + "ab".repeat(32);
      const result = (await handleRegistrationTool("configure_wallet", {
        privateKey: key,
      })) as { success: boolean; method: string };

      expect(result.success).toBe(true);
      expect(result.method).toBe("direct_key");
    });

    it("rejects invalid private key format (no 0x)", async () => {
      const result = (await handleRegistrationTool("configure_wallet", {
        privateKey: "ab".repeat(32),
      })) as { error: string };

      expect(result.error).toContain("Invalid private key");
    });

    it("rejects private key with wrong length", async () => {
      const result = (await handleRegistrationTool("configure_wallet", {
        privateKey: "0x1234",
      })) as { error: string };

      expect(result.error).toContain("Invalid private key");
    });

    it("configures with signature derivation", async () => {
      const sig = "0x" + "cd".repeat(65);
      const result = (await handleRegistrationTool("configure_wallet", {
        signature: sig,
        signerAddress: "0xSomeAddress",
      })) as { success: boolean; method: string; derivedAddress: string };

      expect(result.success).toBe(true);
      expect(result.method).toBe("derived_from_signature");
      expect(result.derivedAddress).toBe("0xDerivedAddress1234");
    });

    it("rejects signature when verification fails", async () => {
      (verifyDerivationSignature as ReturnType<typeof vi.fn>).mockReturnValueOnce(false);

      const result = (await handleRegistrationTool("configure_wallet", {
        signature: "0xbadsig",
        signerAddress: "0xWrongAddress",
      })) as { error: string };

      expect(result.error).toContain("Signature verification failed");
    });

    it("sets chain only when no key or signature", async () => {
      const result = (await handleRegistrationTool("configure_wallet", {
        chainId: 8453,
      })) as { success: boolean; method: string; chainId: number };

      expect(result.success).toBe(true);
      expect(result.method).toBe("chain_only");
      expect(result.chainId).toBe(8453);
    });

    it("returns error when no args provided", async () => {
      const result = (await handleRegistrationTool("configure_wallet", {})) as {
        error: string;
      };

      expect(result.error).toContain("Provide either privateKey or signature");
    });
  });

  // ===========================================================================
  // register_agent
  // ===========================================================================
  describe("register_agent", () => {
    it("registers agent via IPFS when authenticated", async () => {
      setDerivedKey("0x" + "ff".repeat(32));
      const builder = makeAgentBuilder();
      mockCreateAgent.mockReturnValue(builder);

      const result = (await handleRegistrationTool("register_agent", {
        name: "My Agent",
        description: "A cool agent",
        mcpEndpoint: "https://mcp.test",
        active: true,
        trustReputation: true,
      })) as { success: boolean; agentId: string; txHash: string; method: string };

      expect(result.success).toBe(true);
      expect(result.agentId).toBe("11155111:99");
      expect(result.txHash).toBe("0xtxhash123");
      expect(result.method).toBe("ipfs");
      expect(builder.setMCP).toHaveBeenCalledWith("https://mcp.test");
      expect(builder.setTrust).toHaveBeenCalledWith(true, false, false);
      expect(builder.setActive).toHaveBeenCalledWith(true);
    });

    it("registers agent on-chain when method is onchain", async () => {
      setDerivedKey("0x" + "ff".repeat(32));
      const builder = makeAgentBuilder();
      mockCreateAgent.mockReturnValue(builder);

      const result = (await handleRegistrationTool("register_agent", {
        name: "My Agent",
        description: "On-chain agent",
        registrationMethod: "onchain",
      })) as { success: boolean; method: string; txHash: string };

      expect(result.success).toBe(true);
      expect(result.method).toBe("onchain");
      expect(result.txHash).toBe("0xtxhash456");
      expect(builder.registerOnChain).toHaveBeenCalled();
    });

    it("sets A2A endpoint when provided", async () => {
      setDerivedKey("0x" + "ff".repeat(32));
      const builder = makeAgentBuilder();
      mockCreateAgent.mockReturnValue(builder);

      await handleRegistrationTool("register_agent", {
        name: "A2A Agent",
        description: "Has A2A",
        a2aEndpoint: "https://a2a.test/agent.json",
      });

      expect(builder.setA2A).toHaveBeenCalledWith("https://a2a.test/agent.json");
    });

    it("sets metadata when provided", async () => {
      setDerivedKey("0x" + "ff".repeat(32));
      const builder = makeAgentBuilder();
      mockCreateAgent.mockReturnValue(builder);

      await handleRegistrationTool("register_agent", {
        name: "Meta Agent",
        description: "Has metadata",
        metadata: { version: "1.0" },
      });

      expect(builder.setMetadata).toHaveBeenCalledWith({ version: "1.0" });
    });
  });

  // ===========================================================================
  // update_agent
  // ===========================================================================
  describe("update_agent", () => {
    it("returns error when agentId missing", async () => {
      setDerivedKey("0x" + "ff".repeat(32));

      const result = (await handleRegistrationTool("update_agent", {})) as {
        error: string;
      };

      expect(result.error).toContain("agentId is required");
    });

    it("updates agent properties", async () => {
      setDerivedKey("0x" + "ff".repeat(32));
      const builder = makeAgentBuilder();
      mockLoadAgent.mockResolvedValue(builder);

      const result = (await handleRegistrationTool("update_agent", {
        agentId: "11155111:42",
        description: "Updated description",
        mcpEndpoint: "https://new-mcp.test",
        active: false,
      })) as { success: boolean; agentId: string; txHash: string };

      expect(result.success).toBe(true);
      expect(result.agentId).toBe("11155111:42");
      expect(result.txHash).toBe("0xtxhash123");
      expect(builder.updateInfo).toHaveBeenCalled();
      expect(builder.setMCP).toHaveBeenCalledWith("https://new-mcp.test");
      expect(builder.setActive).toHaveBeenCalledWith(false);
    });
  });

  // ===========================================================================
  // Unknown tool
  // ===========================================================================
  it("returns error for unknown tool", async () => {
    const result = (await handleRegistrationTool("nonexistent", {})) as {
      error: string;
    };
    expect(result.error).toContain("Unknown registration tool");
  });
});
