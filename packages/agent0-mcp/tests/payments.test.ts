import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock agent0-sdk
const mockRequest = vi.fn();
const mockIsX402Required = vi.fn();

vi.mock("agent0-sdk", () => {
  return {
    SDK: vi.fn().mockImplementation(() => ({
      request: mockRequest,
    })),
    isX402Required: (...args: unknown[]) => mockIsX402Required(...args),
  };
});

import { paymentsTools, handlePaymentsTool } from "../src/tools/payments.js";
import { setDerivedKey, setChainId } from "../src/auth/sdk-client.js";

describe("payments tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setChainId(11155111);
    setDerivedKey("0x" + "bb".repeat(32));
    mockIsX402Required.mockReturnValue(false);
  });

  // ===========================================================================
  // Tool registration
  // ===========================================================================
  describe("tool registration", () => {
    it("registers 1 payment tool", () => {
      expect(paymentsTools).toHaveLength(1);
    });

    it("registers x402_request", () => {
      expect(paymentsTools.find((t) => t.name === "x402_request")).toBeDefined();
    });
  });

  // ===========================================================================
  // x402_request
  // ===========================================================================
  describe("x402_request", () => {
    it("returns ok for non-402 response", async () => {
      mockRequest.mockResolvedValue({ status: 200, data: "hello" });

      const result = (await handlePaymentsTool("x402_request", {
        url: "https://api.test/data",
      })) as { status: string; x402: boolean };

      expect(result.status).toBe("ok");
      expect(result.x402).toBe(false);
    });

    it("returns payment_required when 402 and autoPay is false", async () => {
      mockIsX402Required.mockReturnValue(true);
      mockRequest.mockResolvedValue({
        x402Payment: { pay: vi.fn() },
      });

      const result = (await handlePaymentsTool("x402_request", {
        url: "https://paid.test/resource",
        autoPay: false,
      })) as { status: string; x402: boolean };

      expect(result.status).toBe("payment_required");
      expect(result.x402).toBe(true);
    });

    it("auto-pays and returns paid result when autoPay is true", async () => {
      const mockPay = vi.fn().mockResolvedValue({ receipt: "paid_data" });
      mockIsX402Required.mockReturnValue(true);
      mockRequest.mockResolvedValue({
        x402Payment: { pay: mockPay },
      });

      const result = (await handlePaymentsTool("x402_request", {
        url: "https://paid.test/resource",
        autoPay: true,
      })) as { status: string; x402: boolean; result: unknown };

      expect(result.status).toBe("paid");
      expect(result.x402).toBe(true);
      expect(result.result).toEqual({ receipt: "paid_data" });
      expect(mockPay).toHaveBeenCalledOnce();
    });

    it("returns payment_failed when auto-pay throws", async () => {
      const mockPay = vi.fn().mockRejectedValue(new Error("Insufficient funds"));
      mockIsX402Required.mockReturnValue(true);
      mockRequest.mockResolvedValue({
        x402Payment: { pay: mockPay },
      });

      const result = (await handlePaymentsTool("x402_request", {
        url: "https://paid.test/resource",
        autoPay: true,
      })) as { status: string; error: string };

      expect(result.status).toBe("payment_failed");
      expect(result.error).toContain("Insufficient funds");
    });

    it("passes method and headers to SDK request", async () => {
      mockRequest.mockResolvedValue({ data: "ok" });

      await handlePaymentsTool("x402_request", {
        url: "https://api.test/data",
        method: "POST",
        headers: { "X-Custom": "value" },
        body: '{"key":"val"}',
      });

      expect(mockRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "https://api.test/data",
          method: "POST",
          headers: { "X-Custom": "value" },
          body: { key: "val" },
        }),
      );
    });

    it("defaults method to GET", async () => {
      mockRequest.mockResolvedValue({ data: "ok" });

      await handlePaymentsTool("x402_request", {
        url: "https://api.test/data",
      });

      expect(mockRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "GET",
        }),
      );
    });
  });

  // ===========================================================================
  // Unknown tool
  // ===========================================================================
  it("returns error for unknown tool", async () => {
    const result = (await handlePaymentsTool("nonexistent", {})) as {
      error: string;
    };
    expect(result.error).toContain("Unknown payments tool");
  });
});
