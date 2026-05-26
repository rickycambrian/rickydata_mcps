import { afterEach, describe, expect, it, vi } from "vitest";
import { handleToolCall, TOOLS } from "../src/tools.js";

describe("TradFi Market Data MCP tools", () => {
  afterEach(() => vi.restoreAllMocks());

  it("defines unique MCP tools", () => {
    const names = TOOLS.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("reports provider status", async () => {
    const result = await handleToolCall("market_data_provider_status", {}) as any;
    expect(result.success).toBe(true);
    expect(result.providers.some((provider: any) => provider.provider === "nasdaq_public")).toBe(true);
  });

  it("parses Nasdaq historical daily prices", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => responseJson({
      data: {
        tradesTable: {
          rows: [
            { date: "05/22/2026", close: "$215.33", volume: "169,275,700", open: "$220.904", high: "$221.01", low: "$214.80" },
          ],
        },
      },
    })));
    const result = await handleToolCall("market_get_daily_prices", {
      symbol: "NVDA",
      startDate: "2026-05-01",
      endDate: "2026-05-26",
    }) as any;
    expect(result.success).toBe(true);
    expect(result.rows[0].date).toBe("2026-05-22");
    expect(result.rows[0].close).toBe(215.33);
  });

  it("compares perp mark to underlying close", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => responseJson({
      data: {
        tradesTable: {
          rows: [
            { date: "05/22/2026", close: "$200.00", volume: "1,000", open: "$199", high: "$201", low: "$198" },
          ],
        },
      },
    })));
    const result = await handleToolCall("market_compare_perp_underlying", {
      symbol: "NVDA",
      hyperliquidMarkPrice: 202,
    }) as any;
    expect(result.success).toBe(true);
    expect(result.basisBps).toBe(100);
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
