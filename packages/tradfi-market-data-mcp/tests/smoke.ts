import { handleToolCall } from "../src/tools.js";

const symbol = process.env.TRADFI_SMOKE_SYMBOL || "NVDA";
const prices = await handleToolCall("market_get_daily_prices", {
  symbol,
  startDate: "2026-05-01",
  endDate: "2026-05-26",
  limit: 5,
}) as any;

if (!prices.success || !prices.rows?.length) {
  throw new Error(`TradFi daily price smoke failed: ${JSON.stringify(prices).slice(0, 500)}`);
}

const quote = await handleToolCall("market_get_quote", { symbol }) as any;
if (!quote.success || !quote.price) {
  throw new Error(`TradFi quote smoke failed: ${JSON.stringify(quote).slice(0, 500)}`);
}

console.log(JSON.stringify({
  ok: true,
  symbol,
  provider: prices.provider,
  rows: prices.rows.length,
  latest: quote,
}, null, 2));
