import { afterEach, describe, expect, it, vi } from "vitest";
import { computeSlippage, handleToolCall, TOOLS } from "../src/tools.js";

describe("Hyperliquid TradFi Microstructure MCP tools", () => {
  afterEach(() => vi.restoreAllMocks());

  it("defines unique MCP tools", () => {
    const names = TOOLS.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("computes buy slippage with partial final level", () => {
    const result = computeSlippage([
      { side: "ask", price: 100, size: 5, notionalUsd: 500 },
      { side: "ask", price: 101, size: 10, notionalUsd: 1010 },
      { side: "bid", price: 99, size: 10, notionalUsd: 990 },
    ], "buy", 1000);
    expect(result.insufficientDepth).toBe(false);
    expect(result.levelsConsumed).toBe(2);
    expect(result.executedNotionalUsd).toBe(1000);
  });

  it("computes insufficient depth", () => {
    const result = computeSlippage([
      { side: "bid", price: 99, size: 1, notionalUsd: 99 },
    ], "sell", 1000);
    expect(result.insufficientDepth).toBe(true);
    expect(result.executedNotionalUsd).toBe(99);
  });

  it("uses live metadata fallback when requested", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => responseJson([
      { universe: [{ name: "xyz:NVDA", szDecimals: 4, maxLeverage: 20, marginTableId: 1 }] },
      [{ funding: "0.1", openInterest: "10", dayNtlVlm: "1000", markPx: "200", midPx: "200.1", oraclePx: "199.9" }],
    ])));
    const result = await handleToolCall("hl_discover_tradfi_markets", {
      source: "live_api",
      dexName: "xyz",
    }) as any;
    expect(result.success).toBe(true);
    expect(result.rows[0].coin).toBe("xyz:NVDA");
    expect(result.rows[0].assetClass).toBe("equity");
  });
});

function responseJson(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}
