import { afterEach, describe, expect, it, vi } from "vitest";
import { handleToolCall, TOOLS } from "../src/tools.js";

describe("Official Macro MCP tools", () => {
  afterEach(() => vi.restoreAllMocks());

  it("defines unique MCP tools", () => {
    const names = TOOLS.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("parses Treasury XML feed rows", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => responseText(`
      <feed>
        <entry><content><m:properties>
          <d:NEW_DATE m:type="Edm.DateTime">2026-05-22T00:00:00</d:NEW_DATE>
          <d:BC_1MONTH m:type="Edm.Double">3.72</d:BC_1MONTH>
          <d:BC_10YEAR m:type="Edm.Double">4.10</d:BC_10YEAR>
        </m:properties></content></entry>
      </feed>
    `)));
    const result = await handleToolCall("macro_treasury_yield_curve", { year: 2026 }) as any;
    expect(result.success).toBe(true);
    expect(result.rows[0]["10Y"]).toBe(4.1);
  });

  it("calls BLS public API", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => responseJson({ status: "REQUEST_SUCCEEDED", Results: { series: [] } })));
    const result = await handleToolCall("macro_bls_series", {
      seriesIds: ["CUUR0000SA0"],
      startYear: "2025",
      endYear: "2026",
    }) as any;
    expect(result.success).toBe(true);
  });

  it("reports missing FRED configuration without throwing", async () => {
    vi.stubEnv("FRED_API_KEY", "");
    const result = await handleToolCall("macro_fred_series", { seriesId: "DGS10" }) as any;
    expect(result.success).toBe(false);
    expect(result.configured).toBe(false);
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

function responseText(body: string) {
  return {
    ok: true,
    status: 200,
    text: async () => body,
    json: async () => JSON.parse(body),
  } as Response;
}
