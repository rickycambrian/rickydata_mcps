import type { Tool } from "@modelcontextprotocol/sdk/types.js";

const TREASURY_XML_URL = "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml";
const BLS_URL = "https://api.bls.gov/publicAPI/v2/timeseries/data/";
const FRED_URL = "https://api.stlouisfed.org/fred/series/observations";
const EIA_BASE = "https://api.eia.gov/v2/petroleum/pri/spt/data/";

interface TreasuryYieldRow {
  date: string;
  [tenor: string]: string | number | null;
}

export const TOOLS: Tool[] = [
  {
    name: "macro_treasury_yield_curve",
    description: "Fetch U.S. Treasury daily par yield curve rates from the official Treasury XML feed.",
    inputSchema: {
      type: "object",
      properties: {
        year: { type: "number", description: "Calendar year. Defaults to current year." },
        month: { type: "string", description: "Optional YYYYMM month filter." },
        limit: { type: "number", description: "Max rows returned after latest-first sort. Default 10." },
      },
    },
  },
  {
    name: "macro_bls_series",
    description: "Fetch official BLS public API time-series observations.",
    inputSchema: {
      type: "object",
      properties: {
        seriesIds: { type: "array", items: { type: "string" }, description: "BLS series ids, e.g. CUUR0000SA0." },
        startYear: { type: "string", description: "Start year." },
        endYear: { type: "string", description: "End year." },
      },
      required: ["seriesIds", "startYear", "endYear"],
    },
  },
  {
    name: "macro_fred_series",
    description: "Fetch FRED series observations. Requires FRED_API_KEY unless apiKey is provided.",
    inputSchema: {
      type: "object",
      properties: {
        seriesId: { type: "string", description: "FRED series id, e.g. DGS10." },
        limit: { type: "number", description: "Observation limit. Default 24." },
        sortOrder: { type: "string", description: "asc or desc. Default desc." },
        apiKey: { type: "string", description: "Optional FRED API key override." },
      },
      required: ["seriesId"],
    },
  },
  {
    name: "macro_eia_petroleum_spot_price",
    description: "Fetch EIA petroleum spot price observations. Requires EIA_API_KEY unless apiKey is provided.",
    inputSchema: {
      type: "object",
      properties: {
        series: { type: "string", description: "EIA petroleum spot price series facet, e.g. RWTC." },
        frequency: { type: "string", description: "daily, weekly, or monthly. Default daily." },
        length: { type: "number", description: "Number of observations. Default 30." },
        apiKey: { type: "string", description: "Optional EIA API key override." },
      },
      required: ["series"],
    },
  },
  {
    name: "macro_snapshot_for_asset",
    description: "Build a compact macro context pack for equity, rates, FX, commodity, or crypto research.",
    inputSchema: {
      type: "object",
      properties: {
        assetClass: { type: "string", description: "equity, rates, fx, commodity, or crypto." },
        blsStartYear: { type: "string", description: "BLS start year. Default previous year." },
        blsEndYear: { type: "string", description: "BLS end year. Default current year." },
      },
    },
  },
];

export async function handleToolCall(name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    if (name === "macro_treasury_yield_curve") {
      return await treasuryYieldCurve({
        year: numberArg(args.year, new Date().getUTCFullYear()),
        month: optionalString(args.month),
        limit: numberArg(args.limit, 10),
      });
    }
    if (name === "macro_bls_series") {
      return await blsSeries(stringArrayArg(args.seriesIds) || [], String(args.startYear || ""), String(args.endYear || ""));
    }
    if (name === "macro_fred_series") {
      return await fredSeries(String(args.seriesId || ""), numberArg(args.limit, 24), optionalString(args.sortOrder) || "desc", optionalString(args.apiKey));
    }
    if (name === "macro_eia_petroleum_spot_price") {
      return await eiaPetroleumSpotPrice(String(args.series || ""), optionalString(args.frequency) || "daily", numberArg(args.length, 30), optionalString(args.apiKey));
    }
    if (name === "macro_snapshot_for_asset") {
      return await macroSnapshot(optionalString(args.assetClass) || "equity", optionalString(args.blsStartYear), optionalString(args.blsEndYear));
    }
    return { success: false, error: `Unknown tool: ${name}` };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function treasuryYieldCurve(options: { year: number; month?: string; limit: number }) {
  const params = new URLSearchParams({ data: "daily_treasury_yield_curve" });
  if (options.month) params.set("field_tdr_date_value_month", options.month);
  else params.set("field_tdr_date_value", String(options.year));
  const sourceUrl = `${TREASURY_XML_URL}?${params.toString()}`;
  const xml = await fetchText(sourceUrl);
  const rows = parseTreasuryYieldCurve(xml)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, clampLimit(options.limit, 1, 500));
  return { success: true, sourceUrl, count: rows.length, rows };
}

export async function blsSeries(seriesIds: string[], startYear: string, endYear: string) {
  if (!seriesIds.length) throw new Error("seriesIds is required");
  if (!startYear || !endYear) throw new Error("startYear and endYear are required");
  const response = await fetch(BLS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ seriesid: seriesIds, startyear: startYear, endyear: endYear }),
  });
  if (!response.ok) throw new Error(`BLS request failed ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const body = await response.json() as { status?: string };
  return { success: body.status === "REQUEST_SUCCEEDED", sourceUrl: BLS_URL, body };
}

export async function fredSeries(seriesId: string, limit = 24, sortOrder = "desc", apiKey?: string) {
  const key = apiKey || process.env.FRED_API_KEY;
  if (!key) {
    return { success: false, configured: false, error: "FRED_API_KEY is required for macro_fred_series" };
  }
  if (!seriesId) throw new Error("seriesId is required");
  const params = new URLSearchParams({
    series_id: seriesId,
    api_key: key,
    file_type: "json",
    sort_order: sortOrder,
    limit: String(clampLimit(limit, 1, 100000)),
  });
  const sourceUrl = `${FRED_URL}?${params.toString()}`;
  const body = await fetchJson(sourceUrl);
  return { success: true, sourceUrl: redactApiKey(sourceUrl), body };
}

export async function eiaPetroleumSpotPrice(series: string, frequency = "daily", length = 30, apiKey?: string) {
  const key = apiKey || process.env.EIA_API_KEY;
  if (!key) {
    return { success: false, configured: false, error: "EIA_API_KEY is required for macro_eia_petroleum_spot_price" };
  }
  if (!series) throw new Error("series is required");
  const params = new URLSearchParams({
    api_key: key,
    frequency,
    "data[0]": "value",
    "facets[series][]": series,
    "sort[0][column]": "period",
    "sort[0][direction]": "desc",
    length: String(clampLimit(length, 1, 5000)),
  });
  const sourceUrl = `${EIA_BASE}?${params.toString()}`;
  const body = await fetchJson(sourceUrl);
  return { success: true, sourceUrl: redactApiKey(sourceUrl), body };
}

export async function macroSnapshot(assetClass: string, blsStartYear?: string, blsEndYear?: string) {
  const currentYear = String(new Date().getUTCFullYear());
  const previousYear = String(new Date().getUTCFullYear() - 1);
  const [treasury, cpi] = await Promise.all([
    treasuryYieldCurve({ year: Number(currentYear), limit: 5 }),
    blsSeries(["CUUR0000SA0"], blsStartYear || previousYear, blsEndYear || currentYear),
  ]);
  return {
    success: true,
    generatedAt: new Date().toISOString(),
    assetClass,
    treasury,
    inflation: cpi,
    cfaUseCases: macroUseCases(assetClass),
  };
}

function parseTreasuryYieldCurve(xml: string): TreasuryYieldRow[] {
  const entries = xml.match(/<entry>[\s\S]*?<\/entry>/g) || [];
  return entries.map((entry) => {
    const row: TreasuryYieldRow = {
      date: parseXmlTag(entry, "NEW_DATE")?.slice(0, 10) || "",
    };
    for (const [tag, field] of [
      ["BC_1MONTH", "1M"],
      ["BC_2MONTH", "2M"],
      ["BC_3MONTH", "3M"],
      ["BC_4MONTH", "4M"],
      ["BC_6MONTH", "6M"],
      ["BC_1YEAR", "1Y"],
      ["BC_2YEAR", "2Y"],
      ["BC_3YEAR", "3Y"],
      ["BC_5YEAR", "5Y"],
      ["BC_7YEAR", "7Y"],
      ["BC_10YEAR", "10Y"],
      ["BC_20YEAR", "20Y"],
      ["BC_30YEAR", "30Y"],
    ]) {
      row[field] = parseNumberOrNull(parseXmlTag(entry, tag));
    }
    return row;
  }).filter((row) => row.date);
}

function parseXmlTag(xml: string, tag: string): string | null {
  const re = new RegExp(`<d:${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/d:${tag}>`);
  const match = xml.match(re);
  return match ? decodeXml(match[1].trim()) : null;
}

function decodeXml(value: string): string {
  return value.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

function parseNumberOrNull(value: string | null): number | null {
  if (!value || value === "N/A") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function fetchJson(url: string): Promise<any> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Request failed ${response.status}: ${(await response.text()).slice(0, 300)}`);
  return await response.json();
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Request failed ${response.status}: ${(await response.text()).slice(0, 300)}`);
  return await response.text();
}

function macroUseCases(assetClass: string): string[] {
  if (assetClass === "commodity") return ["Inflation hedge context", "Real-rate sensitivity", "Supply/demand scenario analysis"];
  if (assetClass === "fx") return ["Rate differentials", "Inflation differentials", "Macro stress testing"];
  if (assetClass === "rates") return ["Duration and convexity framing", "Yield curve shape", "Policy expectations"];
  if (assetClass === "crypto") return ["Liquidity regime", "Real-rate backdrop", "Risk appetite proxy"];
  return ["Discount-rate context", "Business-cycle sensitivity", "Equity risk premium framing"];
}

function redactApiKey(url: string): string {
  return url.replace(/api_key=[^&]+/g, "api_key=<redacted>");
}

function numberArg(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArrayArg(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function clampLimit(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(value)));
}
