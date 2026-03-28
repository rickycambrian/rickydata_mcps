import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  constructor: vi.fn(),
  request: vi.fn(),
}));

class MockX402Client {
  constructor(privateKey: string, options: unknown) {
    mocks.constructor(privateKey, options);
  }

  request(url: string, options: unknown) {
    return mocks.request(url, options);
  }
}

vi.mock("rickydata", () => ({
  X402Client: MockX402Client,
}));

import { paymentsTools, handlePaymentsTool } from "../src/tools/payments.js";
import { setDerivedKey, setChainId } from "../src/auth/sdk-client.js";

describe("payments tools", () => {
  beforeEach(() => {
    vi.useRealTimers();
    mocks.constructor.mockReset();
    mocks.request.mockReset();
    setChainId(11155111);
    setDerivedKey("0x" + "bb".repeat(32));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("tool registration", () => {
    it("registers x402_request", () => {
      expect(paymentsTools).toHaveLength(1);
      expect(paymentsTools.find((tool) => tool.name === "x402_request")).toBeDefined();
    });
  });

  describe("x402_request", () => {
    it("passes through richer SDK preview results unchanged when autoPay is false", async () => {
      mocks.request.mockResolvedValue({
        success: false,
        status: "payment_required",
        x402: true,
        paymentAttempted: false,
        selectedOffer: {
          network: "eip155:137",
          chainId: 137,
          amount: "750",
        },
        usableOffers: [
          { network: "eip155:8453", balanceSufficient: false },
          { network: "eip155:137", balanceSufficient: true },
        ],
      });

      const result = await handlePaymentsTool("x402_request", {
        url: "https://paid.test/resource",
        autoPay: false,
      }) as {
        status: string;
        paymentAttempted: boolean;
        selectedOffer?: { network?: string };
        usableOffers?: unknown[];
      };

      expect(result).toMatchObject({
        status: "payment_required",
        paymentAttempted: false,
        selectedOffer: { network: "eip155:137" },
      });
      expect(result.usableOffers).toHaveLength(2);
      expect(mocks.request).toHaveBeenCalledTimes(1);
      expect(mocks.request).toHaveBeenCalledWith(
        "https://paid.test/resource",
        expect.objectContaining({ autoPay: false, method: "GET" }),
      );
    });

    it("previews first and then pays once when autoPay is true", async () => {
      mocks.request
        .mockResolvedValueOnce({
          success: false,
          status: "payment_required",
          x402: true,
          paymentAttempted: false,
          selectedOffer: {
            network: "eip155:137",
            chainId: 137,
            amount: "750",
          },
        })
        .mockResolvedValueOnce({
          success: true,
          status: "paid",
          x402: true,
          paymentAttempted: true,
          selectedOffer: {
            network: "eip155:137",
            chainId: 137,
            amount: "750",
          },
          result: { ok: true },
        });

      const result = await handlePaymentsTool("x402_request", {
        url: "https://paid.test/resource",
        autoPay: true,
        method: "POST",
        body: '{"chain":"polygon","tokenAddress":"0xabc"}',
      }) as { status: string; result: unknown };

      expect(result).toMatchObject({
        status: "paid",
        result: { ok: true },
      });
      expect(mocks.request).toHaveBeenCalledTimes(2);
      expect(mocks.request.mock.calls[0]).toEqual([
        "https://paid.test/resource",
        expect.objectContaining({
          autoPay: false,
          method: "POST",
          body: '{"chain":"polygon","tokenAddress":"0xabc"}',
        }),
      ]);
      expect(mocks.request.mock.calls[1]).toEqual([
        "https://paid.test/resource",
        expect.objectContaining({
          autoPay: true,
          method: "POST",
          body: '{"chain":"polygon","tokenAddress":"0xabc"}',
        }),
      ]);

      expect(mocks.constructor).toHaveBeenCalledTimes(1);
      expect(mocks.constructor).toHaveBeenCalledWith(
        "0x" + "bb".repeat(32),
        expect.objectContaining({
          maxPaymentUsd: 1,
          rpcUrls: {},
        }),
      );
      expect(mocks.constructor.mock.calls[0]?.[1]).not.toHaveProperty("chainId");
      expect(mocks.constructor.mock.calls[0]?.[1]).not.toHaveProperty("strictChainId");
    });

    it("passes explicit paymentChainId as a strict override to the SDK client", async () => {
      mocks.request
        .mockResolvedValueOnce({
          success: false,
          status: "payment_required",
          x402: true,
          paymentAttempted: false,
          selectedOffer: {
            network: "eip155:8453",
            chainId: 8453,
            amount: "500",
          },
        })
        .mockResolvedValueOnce({
          success: true,
          status: "paid",
          x402: true,
          paymentAttempted: true,
          selectedOffer: {
            network: "eip155:8453",
            chainId: 8453,
            amount: "500",
          },
        });

      await handlePaymentsTool("x402_request", {
        url: "https://paid.test/strict",
        autoPay: true,
        paymentChainId: 8453,
      });

      expect(mocks.constructor).toHaveBeenCalledWith(
        "0x" + "bb".repeat(32),
        expect.objectContaining({
          chainId: 8453,
          strictChainId: true,
          maxPaymentUsd: 1,
        }),
      );
    });

    it("returns richer SDK failure statuses unchanged after the preview step", async () => {
      mocks.request
        .mockResolvedValueOnce({
          success: false,
          status: "payment_required",
          x402: true,
          paymentAttempted: false,
          usableOffers: [
            {
              network: "eip155:8453",
              balance: "0",
              balanceSufficient: false,
            },
          ],
        })
        .mockResolvedValueOnce({
          success: false,
          status: "payment_unfunded",
          x402: true,
          paymentAttempted: false,
          error: "No funded payment offer available on eip155:8453.",
          usableOffers: [
            {
              network: "eip155:8453",
              balance: "0",
              balanceSufficient: false,
            },
          ],
        });

      const result = await handlePaymentsTool("x402_request", {
        url: "https://paid.test/unfunded",
        autoPay: true,
      }) as { status: string; error?: string; usableOffers?: unknown[] };

      expect(result).toMatchObject({
        status: "payment_unfunded",
        error: "No funded payment offer available on eip155:8453.",
      });
      expect(result.usableOffers).toHaveLength(1);
      expect(mocks.request).toHaveBeenCalledTimes(2);
    });

    it("blocks duplicate auto-pay attempts for the same request after a paid failure", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-03-28T02:00:00Z"));

      mocks.request
        .mockResolvedValueOnce({
          success: false,
          status: "payment_required",
          x402: true,
          paymentAttempted: false,
          selectedOffer: {
            network: "eip155:137",
            chainId: 137,
            amount: "750",
          },
        })
        .mockResolvedValueOnce({
          success: false,
          status: "payment_failed",
          x402: true,
          paymentAttempted: true,
          error: "Payment failed: settlement rejected",
          serverReason: "settlement rejected",
          selectedOffer: {
            network: "eip155:137",
            chainId: 137,
            amount: "750",
          },
        })
        .mockResolvedValueOnce({
          success: false,
          status: "payment_required",
          x402: true,
          paymentAttempted: false,
          selectedOffer: {
            network: "eip155:137",
            chainId: 137,
            amount: "750",
          },
        });

      const first = await handlePaymentsTool("x402_request", {
        url: "https://paid.test/duplicate",
        autoPay: true,
        body: '{"chain":"polygon","tokenAddress":"0xabc"}',
      }) as { status: string };

      const second = await handlePaymentsTool("x402_request", {
        url: "https://paid.test/duplicate",
        autoPay: true,
        body: '{"chain":"polygon","tokenAddress":"0xabc"}',
      }) as {
        status: string;
        error?: string;
        paymentAttempted?: boolean;
        duplicatePaymentBlocked?: boolean;
        retryAfterSeconds?: number;
      };

      expect(first.status).toBe("payment_failed");
      expect(second).toMatchObject({
        status: "payment_rejected",
        paymentAttempted: false,
        duplicatePaymentBlocked: true,
      });
      expect(second.error).toContain("Blocked duplicate auto-pay attempt");
      expect(second.error).toContain("settlement rejected");
      expect(second.retryAfterSeconds).toBeGreaterThan(0);
      expect(mocks.request).toHaveBeenCalledTimes(3);
    });

    it("allows retrying again after the duplicate-payment TTL expires", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-03-28T03:00:00Z"));

      mocks.request
        .mockResolvedValueOnce({
          success: false,
          status: "payment_required",
          x402: true,
          paymentAttempted: false,
          selectedOffer: {
            network: "eip155:8453",
            chainId: 8453,
            amount: "500",
          },
        })
        .mockResolvedValueOnce({
          success: false,
          status: "payment_failed",
          x402: true,
          paymentAttempted: true,
          error: "Payment failed: upstream timeout",
          selectedOffer: {
            network: "eip155:8453",
            chainId: 8453,
            amount: "500",
          },
        });

      await handlePaymentsTool("x402_request", {
        url: "https://paid.test/ttl",
        autoPay: true,
      });

      vi.advanceTimersByTime(121_000);

      mocks.request
        .mockResolvedValueOnce({
          success: false,
          status: "payment_required",
          x402: true,
          paymentAttempted: false,
          selectedOffer: {
            network: "eip155:8453",
            chainId: 8453,
            amount: "500",
          },
        })
        .mockResolvedValueOnce({
          success: true,
          status: "paid",
          x402: true,
          paymentAttempted: true,
          selectedOffer: {
            network: "eip155:8453",
            chainId: 8453,
            amount: "500",
          },
          result: { ok: true },
        });

      const result = await handlePaymentsTool("x402_request", {
        url: "https://paid.test/ttl",
        autoPay: true,
      }) as { status: string; result?: unknown };

      expect(result).toMatchObject({
        status: "paid",
        result: { ok: true },
      });
      expect(mocks.request).toHaveBeenCalledTimes(4);
    });
  });

  it("returns an error for unknown tools", async () => {
    const result = await handlePaymentsTool("nonexistent", {}) as { error: string };
    expect(result.error).toContain("Unknown payments tool");
  });
});
