import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

const execFileAsync = promisify(execFile);
const HYPERLIQUID_INFO_URL = "https://api.hyperliquid.xyz/info";
const DEFAULT_CONTAINER = "hyperliquid-clickhouse";

type DataSource = "auto" | "local_clickhouse" | "live_api";
type SlippageSide = "buy" | "sell";

interface L2Level {
  side: "bid" | "ask";
  price: number;
  size: number;
  notionalUsd: number;
}

export const TOOLS: Tool[] = [
  {
    name: "hl_discover_tradfi_markets",
    description: "Discover Hyperliquid traditional-style markets from local ClickHouse taxonomy or live Hyperliquid metadata.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "auto, local_clickhouse, or live_api. Default auto." },
        assetClass: { type: "string", description: "equity, commodity, fx, index, or all. Default all." },
        dexName: { type: "string", description: "HIP-3 dex name such as xyz. Default all for local, xyz for live." },
        limit: { type: "number", description: "Maximum markets. Default 50." },
      },
    },
  },
  {
    name: "hl_get_market_context",
    description: "Fetch Hyperliquid mark, mid, OI, volume, funding, and asset metadata for one or more markets.",
    inputSchema: {
      type: "object",
      properties: {
        coins: { type: "array", items: { type: "string" }, description: "Coins such as xyz:NVDA or SPX." },
        source: { type: "string", description: "auto, local_clickhouse, or live_api. Default auto." },
      },
      required: ["coins"],
    },
  },
  {
    name: "hl_get_local_depth",
    description: "Fetch local ClickHouse depth buckets for a Hyperliquid market.",
    inputSchema: {
      type: "object",
      properties: {
        coin: { type: "string", description: "Coin such as xyz:NVDA." },
        limit: { type: "number", description: "Maximum rows. Default 5." },
      },
      required: ["coin"],
    },
  },
  {
    name: "hl_estimate_slippage",
    description: "Estimate buy/sell execution cost for a notional amount using local L2 levels or live l2Book.",
    inputSchema: {
      type: "object",
      properties: {
        coin: { type: "string", description: "Coin such as xyz:NVDA." },
        side: { type: "string", description: "buy or sell." },
        requestedNotionalUsd: { type: "number", description: "Requested notional in USD." },
        source: { type: "string", description: "auto, local_clickhouse, or live_api. Default auto." },
      },
      required: ["coin", "side", "requestedNotionalUsd"],
    },
  },
  {
    name: "hl_get_local_validation_status",
    description: "Fetch local replay validation and taxonomy validation status for markets.",
    inputSchema: {
      type: "object",
      properties: {
        coins: { type: "array", items: { type: "string" }, description: "Optional coin filter." },
      },
    },
  },
  {
    name: "hl_export_capstone_pack",
    description: "Export a compact local Hyperliquid tradfi market pack for the capstone dashboard/report.",
    inputSchema: {
      type: "object",
      properties: {
        coins: { type: "array", items: { type: "string" }, description: "Optional selected coins." },
        limit: { type: "number", description: "Market limit when coins omitted. Default 12." },
      },
    },
  },
];

export async function handleToolCall(name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    if (name === "hl_discover_tradfi_markets") {
      return await discoverTradfiMarkets({
        source: parseSource(args.source),
        assetClass: optionalString(args.assetClass) || "all",
        dexName: optionalString(args.dexName),
        limit: numberArg(args.limit, 50),
      });
    }
    if (name === "hl_get_market_context") {
      return await getMarketContext(stringArrayArg(args.coins) || [], parseSource(args.source));
    }
    if (name === "hl_get_local_depth") {
      return await getLocalDepth(String(args.coin || ""), numberArg(args.limit, 5));
    }
    if (name === "hl_estimate_slippage") {
      return await estimateSlippage({
        coin: String(args.coin || ""),
        side: parseSide(args.side),
        requestedNotionalUsd: Number(args.requestedNotionalUsd),
        source: parseSource(args.source),
      });
    }
    if (name === "hl_get_local_validation_status") {
      return await getLocalValidationStatus(stringArrayArg(args.coins));
    }
    if (name === "hl_export_capstone_pack") {
      return await exportCapstonePack(stringArrayArg(args.coins), numberArg(args.limit, 12));
    }
    return { success: false, error: `Unknown tool: ${name}` };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function discoverTradfiMarkets(options: {
  source: DataSource;
  assetClass: string;
  dexName?: string;
  limit: number;
}): Promise<unknown> {
  if (options.source !== "live_api") {
    const local = await tryLocal(() => queryLocalTaxonomy(options.assetClass, options.dexName || "all", options.limit));
    if (local.success && local.rows.length > 0) {
      return { success: true, source: "local_clickhouse", count: local.rows.length, rows: local.rows };
    }
    if (options.source === "local_clickhouse") return local;
  }
  const dexName = options.dexName || "xyz";
  const payload = await postInfo<any>({ type: "metaAndAssetCtxs", dex: dexName });
  const rows = normalizeMetaAndCtxs(payload)
    .filter((row: any) => options.assetClass === "all" || classifyAsset(row.coin) === options.assetClass)
    .slice(0, clampLimit(options.limit, 1, 500));
  return { success: true, source: "live_api", dexName, count: rows.length, rows };
}

export async function getMarketContext(coins: string[], source: DataSource = "auto") {
  if (!coins.length) throw new Error("coins is required");
  if (source !== "live_api") {
    const local = await tryLocal(() => queryLocalCoins(coins));
    if (local.success && local.rows.length > 0) return { success: true, source: "local_clickhouse", rows: local.rows };
    if (source === "local_clickhouse") return local;
  }
  const dexNames = [...new Set(coins.map((coin) => coin.includes(":") ? coin.split(":")[0] : ""))].filter(Boolean);
  const contexts = [];
  for (const dex of dexNames.length ? dexNames : [""]) {
    const body: Record<string, unknown> = { type: "metaAndAssetCtxs" };
    if (dex) body.dex = dex;
    const payload = await postInfo<any>(body);
    contexts.push(...normalizeMetaAndCtxs(payload));
  }
  const wanted = new Set(coins.map((coin) => coin.toLowerCase()));
  return { success: true, source: "live_api", rows: contexts.filter((row) => wanted.has(row.coin.toLowerCase())) };
}

export async function getLocalDepth(coin: string, limit = 5) {
  if (!coin.trim()) throw new Error("coin is required");
  const rows = await clickhouseJsonEachRow(`
    SELECT
      coin,
      market_type AS marketType,
      interval,
      bucket_time AS bucketTime,
      block_number AS blockNumber,
      mid_price AS midPrice,
      best_bid AS bestBid,
      best_ask AS bestAsk,
      spread_bps AS spreadBps,
      bid_notional_10bps AS bidNotional10bps,
      ask_notional_10bps AS askNotional10bps,
      bid_notional_25bps AS bidNotional25bps,
      ask_notional_25bps AS askNotional25bps,
      bid_notional_50bps AS bidNotional50bps,
      ask_notional_50bps AS askNotional50bps,
      bid_notional_100bps AS bidNotional100bps,
      ask_notional_100bps AS askNotional100bps,
      depth_imbalance_25bps AS depthImbalance25bps,
      censored,
      replay_id AS replayId
    FROM hyperliquid.depth_by_bucket
    WHERE coin = ${chString(coin)}
    ORDER BY block_number DESC, bucket_time DESC
    LIMIT ${clampLimit(limit, 1, 100)}
    FORMAT JSONEachRow
  `);
  return { success: true, source: "local_clickhouse", coin, count: rows.length, rows };
}

export async function estimateSlippage(options: {
  coin: string;
  side: SlippageSide;
  requestedNotionalUsd: number;
  source: DataSource;
}) {
  if (!options.coin.trim()) throw new Error("coin is required");
  if (!Number.isFinite(options.requestedNotionalUsd) || options.requestedNotionalUsd <= 0) throw new Error("requestedNotionalUsd must be positive");
  if (options.source !== "live_api") {
    const local = await tryLocal(async () => {
      const levels = await getLocalL2Levels(options.coin);
      if (!levels.length) return { success: false, source: "local_clickhouse", error: `No local L2 levels found for ${options.coin}`, rows: [] };
      return { success: true, source: "local_clickhouse", ...computeSlippage(levels, options.side, options.requestedNotionalUsd) };
    });
    if (local.success) return local;
    if (options.source === "local_clickhouse") return local;
  }
  const liveLevels = await getLiveL2Levels(options.coin);
  return { success: true, source: "live_api", ...computeSlippage(liveLevels, options.side, options.requestedNotionalUsd) };
}

export async function getLocalValidationStatus(coins?: string[]) {
  const filter = coins && coins.length ? `WHERE coin IN (${coins.map(chString).join(", ")})` : "";
  const taxonomyFilter = coins && coins.length ? `WHERE coin IN (${coins.map(chString).join(", ")})` : "";
  const [taxonomy, replay] = await Promise.all([
    clickhouseJsonEachRow(`
      SELECT coin, asset_class AS assetClass, validation_status AS validationStatus, present_in_l4_snapshot AS presentInL4Snapshot, updated_at AS updatedAt
      FROM hyperliquid.market_taxonomy FINAL
      ${taxonomyFilter}
      ORDER BY is_traditional DESC, day_volume_usd DESC, coin
      FORMAT JSONEachRow
    `),
    clickhouseJsonEachRow(`
      SELECT coin, start_block AS startBlock, end_block AS endBlock, snapshot_match_score AS l2Score, l4_match_rate AS l4MatchRate, invariant_errors AS invariantErrors, coverage_status AS coverageStatus, created_at AS createdAt
      FROM hyperliquid.replay_validation
      ${filter}
      ORDER BY created_at DESC
      FORMAT JSONEachRow
    `),
  ]);
  return { success: true, source: "local_clickhouse", taxonomy, replay };
}

export async function exportCapstonePack(coins?: string[], limit = 12) {
  const markets = coins && coins.length
    ? await queryLocalCoins(coins)
    : await queryLocalTaxonomy("all", "all", limit);
  const selectedCoins = markets.rows.map((row: any) => row.coin);
  const [depth, validation] = await Promise.all([
    Promise.all(selectedCoins.map((coin: string) => getLocalDepth(coin, 1))),
    getLocalValidationStatus(selectedCoins),
  ]);
  return {
    success: true,
    generatedAt: new Date().toISOString(),
    source: "local_clickhouse",
    markets: markets.rows,
    depth,
    validation,
    limitations: [
      "Replay validation status depends on what has been loaded into local ClickHouse.",
      "Live API fallback is useful for discovery, but local indexer data is the proof source for capstone claims.",
    ],
  };
}

async function queryLocalTaxonomy(assetClass: string, dexName: string, limit: number) {
  const assetFilter = assetClass === "all" ? "" : `AND asset_class = ${chString(assetClass)}`;
  const dexFilter = dexName === "all" ? "" : `AND dex_name = ${chString(dexName)}`;
  const rows = await clickhouseJsonEachRow(`
    SELECT
      market_id AS marketId,
      coin,
      display_symbol AS displaySymbol,
      asset_class AS assetClass,
      is_hip3 AS isHip3,
      dex_name AS dexName,
      mark_price AS markPrice,
      mid_price AS midPrice,
      open_interest AS openInterest,
      day_volume_usd AS dayVolumeUsd,
      funding_rate AS fundingRate,
      present_in_l4_snapshot AS presentInL4Snapshot,
      validation_status AS validationStatus,
      updated_at AS updatedAt
    FROM hyperliquid.market_taxonomy FINAL
    WHERE is_traditional
      ${assetFilter}
      ${dexFilter}
    ORDER BY day_volume_usd DESC, coin
    LIMIT ${clampLimit(limit, 1, 500)}
    FORMAT JSONEachRow
  `);
  return { success: true, rows };
}

async function queryLocalCoins(coins: string[]) {
  const rows = await clickhouseJsonEachRow(`
    SELECT
      market_id AS marketId,
      coin,
      display_symbol AS displaySymbol,
      asset_class AS assetClass,
      is_hip3 AS isHip3,
      dex_name AS dexName,
      mark_price AS markPrice,
      mid_price AS midPrice,
      open_interest AS openInterest,
      day_volume_usd AS dayVolumeUsd,
      funding_rate AS fundingRate,
      present_in_l4_snapshot AS presentInL4Snapshot,
      validation_status AS validationStatus,
      updated_at AS updatedAt
    FROM hyperliquid.market_taxonomy FINAL
    WHERE coin IN (${coins.map(chString).join(", ")})
    ORDER BY day_volume_usd DESC, coin
    FORMAT JSONEachRow
  `);
  return { success: true, rows };
}

async function getLocalL2Levels(coin: string): Promise<L2Level[]> {
  const rows = await clickhouseJsonEachRow(`
    SELECT side, price, size, notional_usd AS notionalUsd
    FROM hyperliquid.l2_levels_by_block
    WHERE coin = ${chString(coin)}
      AND block_number = (SELECT max(block_number) FROM hyperliquid.l2_levels_by_block WHERE coin = ${chString(coin)})
    ORDER BY side, level
    FORMAT JSONEachRow
  `);
  return rows.map((row: any) => ({
    side: row.side === "bid" ? "bid" : "ask",
    price: Number(row.price),
    size: Number(row.size),
    notionalUsd: Number(row.notionalUsd),
  }));
}

async function getLiveL2Levels(coin: string): Promise<L2Level[]> {
  const payload = await postInfo<any>({ type: "l2Book", coin });
  const [bids, asks] = payload.levels || [[], []];
  const normalize = (side: "bid" | "ask", levels: any[]) => levels.map((row) => {
    const price = Number(row.px);
    const size = Number(row.sz);
    return { side, price, size, notionalUsd: price * size };
  });
  return [...normalize("bid", bids), ...normalize("ask", asks)];
}

export function computeSlippage(levels: L2Level[], side: SlippageSide, requestedNotionalUsd: number) {
  const eligible = levels
    .filter((level) => side === "buy" ? level.side === "ask" : level.side === "bid")
    .sort((a, b) => side === "buy" ? a.price - b.price : b.price - a.price);
  let remaining = requestedNotionalUsd;
  let executedNotionalUsd = 0;
  let filledSize = 0;
  let levelsConsumed = 0;
  for (const level of eligible) {
    if (remaining <= 0) break;
    const takeNotional = Math.min(remaining, level.notionalUsd);
    executedNotionalUsd += takeNotional;
    filledSize += takeNotional / level.price;
    remaining -= takeNotional;
    levelsConsumed += 1;
  }
  return {
    side,
    requestedNotionalUsd,
    executedNotionalUsd,
    filledSize,
    vwapPrice: filledSize > 0 ? executedNotionalUsd / filledSize : null,
    levelsConsumed,
    insufficientDepth: executedNotionalUsd + 1e-8 < requestedNotionalUsd,
  };
}

async function postInfo<T>(body: Record<string, unknown>): Promise<T> {
  const response = await fetch(HYPERLIQUID_INFO_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Hyperliquid info request failed ${response.status}: ${(await response.text()).slice(0, 300)}`);
  return await response.json() as T;
}

function normalizeMetaAndCtxs(payload: any) {
  const universe = payload?.[0]?.universe || [];
  const contexts = payload?.[1] || [];
  return universe.map((asset: any, index: number) => {
    const ctx = contexts[index] || {};
    return {
      coin: asset.name,
      displaySymbol: asset.name?.includes(":") ? asset.name.split(":").slice(1).join(":") : asset.name,
      assetClass: classifyAsset(asset.name || ""),
      szDecimals: asset.szDecimals,
      maxLeverage: asset.maxLeverage,
      marginTableId: asset.marginTableId,
      funding: parseNumber(ctx.funding),
      openInterest: parseNumber(ctx.openInterest),
      dayVolumeUsd: parseNumber(ctx.dayNtlVlm),
      oraclePrice: parseNumber(ctx.oraclePx),
      markPrice: parseNumber(ctx.markPx),
      midPrice: parseNumber(ctx.midPx),
      premium: parseNumber(ctx.premium),
    };
  });
}

function classifyAsset(coin: string): string {
  const symbol = coin.includes(":") ? coin.split(":").pop() || coin : coin;
  if (["GOLD", "SILVER", "BRENTOIL", "OIL", "COPPER", "NATGAS", "WHEAT", "CORN", "ALUMINIUM", "PALLADIUM", "PLATINUM", "URANIUM"].includes(symbol)) return "commodity";
  if (["EUR", "GBP", "JPY", "KRW", "DXY"].includes(symbol)) return "fx";
  if (["SPX", "SP500", "USA500", "USA100", "JP225", "KR200", "IBOV", "NIFTY", "EWY", "EWJ", "EWT", "EWZ", "XLE", "VIX"].includes(symbol)) return "index";
  return "equity";
}

async function tryLocal<T>(fn: () => Promise<T>): Promise<any> {
  try {
    return await fn();
  } catch (error) {
    return {
      success: false,
      source: "local_clickhouse",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function clickhouseJsonEachRow(query: string): Promise<any[]> {
  const container = process.env.HL_CLICKHOUSE_CONTAINER || DEFAULT_CONTAINER;
  const { stdout } = await execFileAsync("docker", [
    "exec",
    container,
    "clickhouse-client",
    "--query",
    query,
  ], { maxBuffer: 20 * 1024 * 1024 });
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function chString(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function parseSource(value: unknown): DataSource {
  if (value === "local_clickhouse" || value === "live_api") return value;
  return "auto";
}

function parseSide(value: unknown): SlippageSide {
  if (value === "sell") return "sell";
  return "buy";
}

function parseNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
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
