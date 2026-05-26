import { handleToolCall } from "../src/tools.js";

const coin = process.env.HL_SMOKE_COIN || "xyz:NVDA";

const discovery = await handleToolCall("hl_discover_tradfi_markets", {
  source: "auto",
  assetClass: "equity",
  limit: 5,
}) as any;
if (!discovery.success || !discovery.rows?.length) {
  throw new Error(`Hyperliquid discovery smoke failed: ${JSON.stringify(discovery).slice(0, 500)}`);
}

const context = await handleToolCall("hl_get_market_context", {
  coins: [coin],
  source: "auto",
}) as any;
if (!context.success || !context.rows?.length) {
  throw new Error(`Hyperliquid context smoke failed: ${JSON.stringify(context).slice(0, 500)}`);
}

const slippage = await handleToolCall("hl_estimate_slippage", {
  coin,
  side: "buy",
  requestedNotionalUsd: 100000,
  source: "auto",
}) as any;
if (!slippage.success || !Number.isFinite(slippage.executedNotionalUsd)) {
  throw new Error(`Hyperliquid slippage smoke failed: ${JSON.stringify(slippage).slice(0, 500)}`);
}

console.log(JSON.stringify({
  ok: true,
  discoverySource: discovery.source,
  discovered: discovery.rows.slice(0, 3).map((row: any) => row.coin),
  contextSource: context.source,
  coin,
  slippageSource: slippage.source,
  slippage,
}, null, 2));
