import { handleToolCall } from "../src/tools.js";

const query = process.env.SEC_SMOKE_TICKER || "NVDA";

const search = await handleToolCall("sec_search_company", { query, limit: 3 }) as any;
if (!search.success || !search.results?.length) {
  throw new Error(`SEC company search failed: ${JSON.stringify(search)}`);
}

const submissions = await handleToolCall("sec_get_submissions", {
  cikOrTicker: query,
  forms: ["10-K", "10-Q"],
  limit: 3,
}) as any;
if (!submissions.success || !submissions.filings?.length) {
  throw new Error(`SEC submissions smoke failed: ${JSON.stringify(submissions).slice(0, 500)}`);
}

const facts = await handleToolCall("sec_get_companyfacts", {
  cikOrTicker: query,
  concepts: ["Revenues", "NetIncomeLoss", "Assets"],
  limitPerConcept: 2,
}) as any;
if (!facts.success || !facts.facts?.length) {
  throw new Error(`SEC company facts smoke failed: ${JSON.stringify(facts).slice(0, 500)}`);
}

console.log(JSON.stringify({
  ok: true,
  query,
  company: search.results[0],
  filings: submissions.filings.length,
  facts: facts.facts.map((row: any) => row.concept),
}, null, 2));
