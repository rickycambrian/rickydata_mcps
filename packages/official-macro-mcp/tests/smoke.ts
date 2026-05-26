import { handleToolCall } from "../src/tools.js";

const treasury = await handleToolCall("macro_treasury_yield_curve", {
  year: new Date().getUTCFullYear(),
  limit: 3,
}) as any;
if (!treasury.success || !treasury.rows?.length) {
  throw new Error(`Treasury smoke failed: ${JSON.stringify(treasury).slice(0, 500)}`);
}

const currentYear = String(new Date().getUTCFullYear());
const previousYear = String(new Date().getUTCFullYear() - 1);
const bls = await handleToolCall("macro_bls_series", {
  seriesIds: ["CUUR0000SA0"],
  startYear: previousYear,
  endYear: currentYear,
}) as any;
if (!bls.success) {
  throw new Error(`BLS smoke failed: ${JSON.stringify(bls).slice(0, 500)}`);
}

console.log(JSON.stringify({
  ok: true,
  treasuryRows: treasury.rows.length,
  latestTreasuryDate: treasury.rows[0].date,
  blsStatus: bls.body.status,
  optionalKeys: {
    fredConfigured: Boolean(process.env.FRED_API_KEY),
    eiaConfigured: Boolean(process.env.EIA_API_KEY),
  },
}, null, 2));
