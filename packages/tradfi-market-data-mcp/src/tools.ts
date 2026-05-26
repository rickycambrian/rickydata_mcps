import type { Tool } from "@modelcontextprotocol/sdk/types.js";

const NASDAQ_BASE = "https://api.nasdaq.com/api";
const ALPHA_BASE = "https://www.alphavantage.co/query";
const FMP_BASE = "https://financialmodelingprep.com/api/v3";

type PriceProvider = "nasdaq_public" | "alpha_vantage" | "fmp";

interface DailyPrice {
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
}

export const TOOLS: Tool[] = [
  {
    name: "market_data_provider_status",
    description: "Report configured traditional market-data providers and caveats.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "market_get_daily_prices",
    description: "Fetch daily OHLCV prices for a traditional asset from a configured provider.",
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Ticker symbol, e.g. NVDA." },
        provider: { type: "string", description: "nasdaq_public, alpha_vantage, or fmp. Default nasdaq_public." },
        startDate: { type: "string", description: "YYYY-MM-DD start date. Default 30 calendar days ago." },
        endDate: { type: "string", description: "YYYY-MM-DD end date. Default today." },
        limit: { type: "number", description: "Maximum rows. Default 30." },
      },
      required: ["symbol"],
    },
  },
  {
    name: "market_get_quote",
    description: "Fetch latest available quote/close from daily market data.",
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Ticker symbol, e.g. NVDA." },
        provider: { type: "string", description: "nasdaq_public, alpha_vantage, or fmp. Default nasdaq_public." },
      },
      required: ["symbol"],
    },
  },
  {
    name: "market_get_company_profile",
    description: "Fetch company profile from configured paid provider when available.",
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Ticker symbol." },
        provider: { type: "string", description: "fmp or alpha_vantage. Default fmp." },
      },
      required: ["symbol"],
    },
  },
  {
    name: "market_compare_perp_underlying",
    description: "Compare a Hyperliquid perp mark price to the latest traditional underlying close.",
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Underlying ticker symbol, e.g. NVDA." },
        hyperliquidMarkPrice: { type: "number", description: "Hyperliquid mark price." },
        provider: { type: "string", description: "Price provider. Default nasdaq_public." },
      },
      required: ["symbol", "hyperliquidMarkPrice"],
    },
  },
];

export async function handleToolCall(name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    if (name === "market_data_provider_status") return providerStatus();
    if (name === "market_get_daily_prices") {
      return await getDailyPrices({
        symbol: String(args.symbol || ""),
        provider: parseProvider(args.provider, "nasdaq_public"),
        startDate: optionalString(args.startDate) || daysAgoIso(30),
        endDate: optionalString(args.endDate) || todayIso(),
        limit: numberArg(args.limit, 30),
      });
    }
    if (name === "market_get_quote") {
      return await getQuote(String(args.symbol || ""), parseProvider(args.provider, "nasdaq_public"));
    }
    if (name === "market_get_company_profile") {
      return await getCompanyProfile(String(args.symbol || ""), parseProvider(args.provider, "fmp"));
    }
    if (name === "market_compare_perp_underlying") {
      return await comparePerpUnderlying(String(args.symbol || ""), Number(args.hyperliquidMarkPrice), parseProvider(args.provider, "nasdaq_public"));
    }
    return { success: false, error: `Unknown tool: ${name}` };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function providerStatus() {
  return {
    success: true,
    generatedAt: new Date().toISOString(),
    providers: [
      {
        provider: "nasdaq_public",
        configured: true,
        auth: "none",
        use: "Local development and capstone evidence for U.S. equity daily prices.",
        caveat: "Public web endpoint, not a contracted institutional data feed.",
      },
      {
        provider: "alpha_vantage",
        configured: Boolean(process.env.ALPHAVANTAGE_API_KEY),
        auth: "ALPHAVANTAGE_API_KEY",
        use: "Fallback prices and overview once an API key is configured.",
      },
      {
        provider: "fmp",
        configured: Boolean(process.env.FMP_API_KEY),
        auth: "FMP_API_KEY",
        use: "Company profiles, financials, estimates, and prices once configured.",
      },
      {
        provider: "polygon",
        configured: Boolean(process.env.POLYGON_API_KEY),
        auth: "POLYGON_API_KEY",
        use: "Preferred production-grade U.S. market data adapter to add before publishing.",
      },
    ],
  };
}

export async function getDailyPrices(options: {
  symbol: string;
  provider: PriceProvider;
  startDate: string;
  endDate: string;
  limit: number;
}) {
  if (!options.symbol.trim()) throw new Error("symbol is required");
  if (options.provider === "nasdaq_public") return await getNasdaqDailyPrices(options);
  if (options.provider === "alpha_vantage") return await getAlphaDailyPrices(options);
  if (options.provider === "fmp") return await getFmpDailyPrices(options);
  throw new Error(`Unsupported provider ${options.provider}`);
}

export async function getQuote(symbol: string, provider: PriceProvider = "nasdaq_public") {
  const prices = await getDailyPrices({
    symbol,
    provider,
    startDate: daysAgoIso(14),
    endDate: todayIso(),
    limit: 10,
  }) as any;
  if (!prices.success || !prices.rows?.length) return prices;
  const latest = prices.rows[0];
  return {
    success: true,
    provider,
    symbol: symbol.toUpperCase(),
    asOf: latest.date,
    price: latest.close,
    sourceUrl: prices.sourceUrl,
    row: latest,
  };
}

export async function getCompanyProfile(symbol: string, provider: PriceProvider = "fmp") {
  if (!symbol.trim()) throw new Error("symbol is required");
  if (provider === "fmp") {
    const key = process.env.FMP_API_KEY;
    if (!key) return { success: false, configured: false, error: "FMP_API_KEY is required for market_get_company_profile" };
    const sourceUrl = `${FMP_BASE}/profile/${encodeURIComponent(symbol.toUpperCase())}?apikey=${encodeURIComponent(key)}`;
    const body = await fetchJson(sourceUrl);
    return { success: true, provider, sourceUrl: redactKey(sourceUrl), body };
  }
  if (provider === "alpha_vantage") {
    const key = process.env.ALPHAVANTAGE_API_KEY;
    if (!key) return { success: false, configured: false, error: "ALPHAVANTAGE_API_KEY is required for market_get_company_profile" };
    const sourceUrl = `${ALPHA_BASE}?function=OVERVIEW&symbol=${encodeURIComponent(symbol.toUpperCase())}&apikey=${encodeURIComponent(key)}`;
    const body = await fetchJson(sourceUrl);
    return { success: true, provider, sourceUrl: redactKey(sourceUrl), body };
  }
  return { success: false, configured: false, error: `${provider} does not provide company profiles in this MCP` };
}

export async function comparePerpUnderlying(symbol: string, hyperliquidMarkPrice: number, provider: PriceProvider = "nasdaq_public") {
  if (!Number.isFinite(hyperliquidMarkPrice) || hyperliquidMarkPrice <= 0) throw new Error("hyperliquidMarkPrice must be positive");
  const quote = await getQuote(symbol, provider) as any;
  if (!quote.success) return quote;
  const basis = hyperliquidMarkPrice - quote.price;
  return {
    success: true,
    symbol: symbol.toUpperCase(),
    provider,
    hyperliquidMarkPrice,
    underlyingPrice: quote.price,
    underlyingAsOf: quote.asOf,
    basis,
    basisBps: (basis / quote.price) * 10000,
    sourceUrl: quote.sourceUrl,
  };
}

async function getNasdaqDailyPrices(options: { symbol: string; startDate: string; endDate: string; limit: number }) {
  const symbol = options.symbol.toUpperCase();
  const params = new URLSearchParams({
    assetclass: "stocks",
    fromdate: options.startDate,
    todate: options.endDate,
    limit: String(clampLimit(options.limit, 1, 1000)),
  });
  const sourceUrl = `${NASDAQ_BASE}/quote/${encodeURIComponent(symbol)}/historical?${params.toString()}`;
  const body = await fetchJson<any>(sourceUrl, {
    "User-Agent": "Mozilla/5.0 rickydata-mcps",
    Accept: "application/json",
  });
  const rows = (body.data?.tradesTable?.rows || []).map(parseNasdaqRow).filter(Boolean) as DailyPrice[];
  return {
    success: true,
    provider: "nasdaq_public",
    symbol,
    sourceUrl,
    count: rows.length,
    rows,
    caveat: "Nasdaq public web endpoint; use a contracted vendor before production use.",
  };
}

async function getAlphaDailyPrices(options: { symbol: string; limit: number }) {
  const key = process.env.ALPHAVANTAGE_API_KEY;
  if (!key) return { success: false, configured: false, error: "ALPHAVANTAGE_API_KEY is required for alpha_vantage daily prices" };
  const sourceUrl = `${ALPHA_BASE}?function=TIME_SERIES_DAILY&symbol=${encodeURIComponent(options.symbol.toUpperCase())}&outputsize=compact&apikey=${encodeURIComponent(key)}`;
  const body = await fetchJson<any>(sourceUrl);
  const series = body["Time Series (Daily)"];
  if (!series) return { success: false, provider: "alpha_vantage", sourceUrl: redactKey(sourceUrl), body };
  const rows = Object.entries(series).map(([date, row]: [string, any]) => ({
    date,
    open: parseNumber(row["1. open"]),
    high: parseNumber(row["2. high"]),
    low: parseNumber(row["3. low"]),
    close: parseNumber(row["4. close"]),
    volume: parseNumber(row["5. volume"]),
  })).slice(0, clampLimit(options.limit, 1, 1000));
  return { success: true, provider: "alpha_vantage", sourceUrl: redactKey(sourceUrl), count: rows.length, rows };
}

async function getFmpDailyPrices(options: { symbol: string; startDate: string; endDate: string; limit: number }) {
  const key = process.env.FMP_API_KEY;
  if (!key) return { success: false, configured: false, error: "FMP_API_KEY is required for fmp daily prices" };
  const sourceUrl = `${FMP_BASE}/historical-price-full/${encodeURIComponent(options.symbol.toUpperCase())}?from=${options.startDate}&to=${options.endDate}&apikey=${encodeURIComponent(key)}`;
  const body = await fetchJson<any>(sourceUrl);
  const rows = (body.historical || []).slice(0, clampLimit(options.limit, 1, 1000)).map((row: any) => ({
    date: row.date,
    open: parseNumber(row.open),
    high: parseNumber(row.high),
    low: parseNumber(row.low),
    close: parseNumber(row.close),
    volume: parseNumber(row.volume),
  }));
  return { success: true, provider: "fmp", sourceUrl: redactKey(sourceUrl), count: rows.length, rows };
}

function parseNasdaqRow(row: any): DailyPrice | null {
  if (!row?.date) return null;
  return {
    date: toIsoDate(row.date),
    open: parseMoney(row.open),
    high: parseMoney(row.high),
    low: parseMoney(row.low),
    close: parseMoney(row.close),
    volume: parseMoney(row.volume),
  };
}

function parseProvider(value: unknown, fallback: PriceProvider): PriceProvider {
  if (value === "nasdaq_public" || value === "alpha_vantage" || value === "fmp") return value;
  return fallback;
}

function parseMoney(value: unknown): number | null {
  if (value == null) return null;
  const clean = String(value).replace(/[$,]/g, "");
  return parseNumber(clean);
}

function parseNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toIsoDate(value: string): string {
  const [month, day, year] = value.split("/");
  if (!month || !day || !year) return value;
  return `${year.padStart(4, "0")}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

async function fetchJson<T = unknown>(url: string, headers?: Record<string, string>): Promise<T> {
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`Market data request failed ${response.status}: ${(await response.text()).slice(0, 300)}`);
  return await response.json() as T;
}

function redactKey(url: string): string {
  return url.replace(/apikey=[^&]+/g, "apikey=<redacted>");
}

function numberArg(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function clampLimit(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysAgoIso(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}
