import { afterEach, describe, expect, it, vi } from "vitest";
import { handleToolCall, TOOLS } from "../src/tools.js";

const tickers = {
  "0": { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." },
  "1": { cik_str: 1045810, ticker: "NVDA", title: "NVIDIA CORP" },
};

describe("SEC EDGAR MCP tools", () => {
  afterEach(() => vi.restoreAllMocks());

  it("defines unique MCP tools", () => {
    const names = TOOLS.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("searches company ticker metadata", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(tickers)));
    const result = await handleToolCall("sec_search_company", { query: "NVDA" }) as any;
    expect(result.success).toBe(true);
    expect(result.results[0].cik).toBe("0001045810");
  });

  it("returns recent submissions with form filtering", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("company_tickers")) return response(tickers);
      return response({
        cik: "0001045810",
        name: "NVIDIA CORP",
        tickers: ["NVDA"],
        filings: {
          recent: {
            accessionNumber: ["0001045810-26-000001", "0001045810-26-000002"],
            filingDate: ["2026-03-01", "2026-02-01"],
            reportDate: ["2026-01-31", "2026-01-01"],
            form: ["10-K", "8-K"],
            primaryDocument: ["nvda-10k.htm", "nvda-8k.htm"],
            primaryDocDescription: ["10-K", "8-K"],
          },
        },
      });
    }));
    const result = await handleToolCall("sec_get_submissions", { cikOrTicker: "NVDA", forms: ["10-K"] }) as any;
    expect(result.success).toBe(true);
    expect(result.filings).toHaveLength(1);
    expect(result.filings[0].form).toBe("10-K");
  });

  it("summarizes company facts", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("company_tickers")) return response(tickers);
      return response({
        cik: 1045810,
        entityName: "NVIDIA CORP",
        facts: {
          "us-gaap": {
            Revenues: {
              units: {
                USD: [
                  { val: 100, accn: "a", filed: "2026-03-01", form: "10-K", fy: 2026 },
                  { val: 80, accn: "b", filed: "2025-03-01", form: "10-K", fy: 2025 },
                ],
              },
            },
          },
        },
      });
    }));
    const result = await handleToolCall("sec_get_companyfacts", { cikOrTicker: "NVDA", concepts: ["Revenues"] }) as any;
    expect(result.success).toBe(true);
    expect(result.facts[0].observations[0].val).toBe(100);
  });
});

function response(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => typeof body === "string" ? body : JSON.stringify(body),
  } as Response;
}
