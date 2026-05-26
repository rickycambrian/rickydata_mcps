import type { Tool } from "@modelcontextprotocol/sdk/types.js";

const SEC_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";
const SEC_DATA_BASE = "https://data.sec.gov";
const SEC_ARCHIVES_BASE = "https://www.sec.gov/Archives/edgar/data";
const DEFAULT_USER_AGENT = "rickydata_mcps/0.1 local research (set SEC_USER_AGENT)";

interface CompanyTickerRow {
  cik_str: number;
  ticker: string;
  title: string;
}

interface CompanyRef {
  cik: string;
  cikNumber: number;
  ticker: string;
  title: string;
}

interface RecentFiling {
  accessionNumber: string;
  filingDate: string;
  reportDate: string;
  form: string;
  primaryDocument: string;
  description: string;
}

interface CompanySubmissions {
  cik: string;
  name: string;
  tickers: string[];
  sic?: string;
  sicDescription?: string;
  entityType?: string;
  fiscalYearEnd?: string;
  filings: {
    recent: {
      accessionNumber: string[];
      filingDate: string[];
      reportDate: string[];
      form: string[];
      primaryDocument: string[];
      primaryDocDescription: string[];
    };
  };
}

interface CompanyFactUnit {
  val: number;
  accn: string;
  fy?: number;
  fp?: string;
  form?: string;
  filed?: string;
  end?: string;
}

type FactUnits = Record<string, CompanyFactUnit[]>;

const COMMON_FACTS = [
  "Revenues",
  "RevenueFromContractWithCustomerExcludingAssessedTax",
  "NetIncomeLoss",
  "Assets",
  "Liabilities",
  "StockholdersEquity",
  "CashAndCashEquivalentsAtCarryingValue",
  "OperatingIncomeLoss",
  "OperatingCashFlow",
  "NetCashProvidedByUsedInOperatingActivities",
  "LongTermDebt",
  "LongTermDebtCurrent",
  "CommonStocksIncludingAdditionalPaidInCapital",
];

export const TOOLS: Tool[] = [
  {
    name: "sec_search_company",
    description: "Search SEC company ticker metadata by ticker, CIK, or company name.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Ticker, CIK, or company name search text." },
        limit: { type: "number", description: "Maximum matches to return. Default 10." },
      },
      required: ["query"],
    },
  },
  {
    name: "sec_get_submissions",
    description: "Fetch recent SEC EDGAR submissions for a company.",
    inputSchema: {
      type: "object",
      properties: {
        cikOrTicker: { type: "string", description: "Ticker or CIK." },
        forms: { type: "array", items: { type: "string" }, description: "Optional forms filter, e.g. ['10-K','10-Q']." },
        limit: { type: "number", description: "Maximum filings to return. Default 20." },
      },
      required: ["cikOrTicker"],
    },
  },
  {
    name: "sec_get_companyfacts",
    description: "Fetch XBRL company facts and summarize latest common CFA financial-statement concepts.",
    inputSchema: {
      type: "object",
      properties: {
        cikOrTicker: { type: "string", description: "Ticker or CIK." },
        concepts: { type: "array", items: { type: "string" }, description: "Optional us-gaap concept names." },
        limitPerConcept: { type: "number", description: "Maximum recent facts per concept. Default 4." },
      },
      required: ["cikOrTicker"],
    },
  },
  {
    name: "sec_extract_filing_sections",
    description: "Fetch an SEC filing document and extract selected textual 10-K or 10-Q sections with citations.",
    inputSchema: {
      type: "object",
      properties: {
        cikOrTicker: { type: "string", description: "Ticker or CIK." },
        accessionNumber: { type: "string", description: "Optional accession number. Defaults to latest requested form." },
        form: { type: "string", description: "Form to use when accessionNumber is omitted. Default 10-K." },
        sections: { type: "array", items: { type: "string" }, description: "Section labels such as Item 1A or Item 7." },
        maxCharsPerSection: { type: "number", description: "Maximum characters per extracted section. Default 4000." },
      },
      required: ["cikOrTicker"],
    },
  },
  {
    name: "sec_export_equity_research_pack",
    description: "Assemble SEC company metadata, recent filings, summarized company facts, and optional filing sections for an equity research pack.",
    inputSchema: {
      type: "object",
      properties: {
        cikOrTicker: { type: "string", description: "Ticker or CIK." },
        includeFilingSections: { type: "boolean", description: "Whether to include latest 10-K section extracts. Default false." },
      },
      required: ["cikOrTicker"],
    },
  },
];

export async function handleToolCall(name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    if (name === "sec_search_company") {
      return await searchCompany(String(args.query || ""), numberArg(args.limit, 10));
    }
    if (name === "sec_get_submissions") {
      return await getSubmissions(String(args.cikOrTicker || ""), stringArrayArg(args.forms), numberArg(args.limit, 20));
    }
    if (name === "sec_get_companyfacts") {
      return await getCompanyFacts(String(args.cikOrTicker || ""), stringArrayArg(args.concepts), numberArg(args.limitPerConcept, 4));
    }
    if (name === "sec_extract_filing_sections") {
      return await extractFilingSections({
        cikOrTicker: String(args.cikOrTicker || ""),
        accessionNumber: optionalString(args.accessionNumber),
        form: optionalString(args.form) || "10-K",
        sections: stringArrayArg(args.sections) || ["Item 1", "Item 1A", "Item 7"],
        maxCharsPerSection: numberArg(args.maxCharsPerSection, 4000),
      });
    }
    if (name === "sec_export_equity_research_pack") {
      return await exportEquityResearchPack(String(args.cikOrTicker || ""), Boolean(args.includeFilingSections));
    }
    return { success: false, error: `Unknown tool: ${name}` };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function searchCompany(query: string, limit = 10) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) throw new Error("query is required");
  const rows = await getCompanyTickerRows();
  const matches = rows
    .filter((row) => {
      const cik = String(row.cik_str);
      return (
        row.ticker.toLowerCase() === normalized ||
        row.ticker.toLowerCase().includes(normalized) ||
        row.title.toLowerCase().includes(normalized) ||
        cik === normalized.replace(/^0+/, "")
      );
    })
    .slice(0, clampLimit(limit, 1, 50))
    .map(toCompanyRef);
  return { success: true, sourceUrl: SEC_TICKERS_URL, count: matches.length, results: matches };
}

export async function getSubmissions(cikOrTicker: string, forms?: string[], limit = 20) {
  const company = await resolveCompany(cikOrTicker);
  const url = `${SEC_DATA_BASE}/submissions/CIK${company.cik}.json`;
  const payload = await fetchJson<CompanySubmissions>(url);
  const formSet = forms && forms.length ? new Set(forms.map((form) => form.toUpperCase())) : null;
  const filings: RecentFiling[] = [];
  const recent = payload.filings.recent;
  for (let i = 0; i < recent.accessionNumber.length; i += 1) {
    const form = recent.form[i];
    if (formSet && !formSet.has(form.toUpperCase())) continue;
    filings.push({
      accessionNumber: recent.accessionNumber[i],
      filingDate: recent.filingDate[i],
      reportDate: recent.reportDate[i],
      form,
      primaryDocument: recent.primaryDocument[i],
      description: recent.primaryDocDescription[i],
    });
    if (filings.length >= clampLimit(limit, 1, 100)) break;
  }
  return {
    success: true,
    sourceUrl: url,
    company: {
      ...company,
      name: payload.name,
      tickers: payload.tickers,
      sic: payload.sic,
      sicDescription: payload.sicDescription,
      entityType: payload.entityType,
      fiscalYearEnd: payload.fiscalYearEnd,
    },
    filings,
  };
}

export async function getCompanyFacts(cikOrTicker: string, concepts?: string[], limitPerConcept = 4) {
  const company = await resolveCompany(cikOrTicker);
  const url = `${SEC_DATA_BASE}/api/xbrl/companyfacts/CIK${company.cik}.json`;
  const payload = await fetchJson<any>(url);
  const usGaap = payload.facts?.["us-gaap"] || {};
  const wanted = concepts && concepts.length ? concepts : COMMON_FACTS;
  const facts = wanted
    .filter((concept) => usGaap[concept])
    .map((concept) => summarizeConcept(concept, usGaap[concept].units || {}, limitPerConcept));
  return {
    success: true,
    sourceUrl: url,
    company,
    entityName: payload.entityName,
    cik: payload.cik,
    facts,
  };
}

export async function extractFilingSections(options: {
  cikOrTicker: string;
  accessionNumber?: string;
  form: string;
  sections: string[];
  maxCharsPerSection: number;
}) {
  const company = await resolveCompany(options.cikOrTicker);
  let accessionNumber = options.accessionNumber;
  let primaryDocument = "";
  let form = options.form;
  if (!accessionNumber) {
    const submissions = await getSubmissions(options.cikOrTicker, [options.form], 1) as any;
    const filing = submissions.filings[0];
    if (!filing) throw new Error(`No ${options.form} filing found for ${options.cikOrTicker}`);
    accessionNumber = filing.accessionNumber;
    primaryDocument = filing.primaryDocument;
    form = filing.form;
  } else {
    const submissions = await getSubmissions(options.cikOrTicker, undefined, 100) as any;
    const filing = submissions.filings.find((row: RecentFiling) => row.accessionNumber === accessionNumber);
    if (!filing) throw new Error(`Accession ${accessionNumber} not present in recent submissions for ${options.cikOrTicker}`);
    primaryDocument = filing.primaryDocument;
    form = filing.form;
  }
  if (!accessionNumber) throw new Error("No accession number resolved for filing section extraction");
  const accessionCompact = accessionNumber.replaceAll("-", "");
  const cikNoLeadingZeros = String(company.cikNumber);
  const sourceUrl = `${SEC_ARCHIVES_BASE}/${cikNoLeadingZeros}/${accessionCompact}/${primaryDocument}`;
  const html = await fetchText(sourceUrl);
  const text = normalizeFilingText(htmlToText(html));
  const sections = options.sections.map((section) => ({
    section,
    text: extractSection(text, section, options.maxCharsPerSection),
  }));
  return { success: true, sourceUrl, company, form, accessionNumber, sections };
}

export async function exportEquityResearchPack(cikOrTicker: string, includeFilingSections = false) {
  const [submissions, facts] = await Promise.all([
    getSubmissions(cikOrTicker, ["10-K", "10-Q", "8-K"], 12),
    getCompanyFacts(cikOrTicker, undefined, 4),
  ]);
  const pack: Record<string, unknown> = {
    success: true,
    generatedAt: new Date().toISOString(),
    sourceSystem: "SEC EDGAR",
    submissions,
    facts,
    cfaUseCases: [
      "Financial statement analysis",
      "Earnings quality and red-flag review",
      "Equity valuation inputs",
      "Corporate governance and risk disclosure review",
    ],
  };
  if (includeFilingSections) {
    pack.latestFilingSections = await extractFilingSections({
      cikOrTicker,
      form: "10-K",
      sections: ["Item 1", "Item 1A", "Item 7"],
      maxCharsPerSection: 2500,
    });
  }
  return pack;
}

async function resolveCompany(cikOrTicker: string): Promise<CompanyRef> {
  const query = cikOrTicker.trim();
  if (!query) throw new Error("cikOrTicker is required");
  const rows = await getCompanyTickerRows();
  const normalized = query.toLowerCase().replace(/^0+/, "");
  const row = rows.find((candidate) => (
    candidate.ticker.toLowerCase() === query.toLowerCase() ||
    String(candidate.cik_str) === normalized
  ));
  if (!row) throw new Error(`No SEC company ticker match found for ${cikOrTicker}`);
  return toCompanyRef(row);
}

let tickerCache: CompanyTickerRow[] | null = null;

async function getCompanyTickerRows(): Promise<CompanyTickerRow[]> {
  if (tickerCache) return tickerCache;
  const payload = await fetchJson<Record<string, CompanyTickerRow>>(SEC_TICKERS_URL);
  tickerCache = Object.values(payload);
  return tickerCache;
}

function toCompanyRef(row: CompanyTickerRow): CompanyRef {
  return {
    cik: String(row.cik_str).padStart(10, "0"),
    cikNumber: row.cik_str,
    ticker: row.ticker,
    title: row.title,
  };
}

function summarizeConcept(concept: string, units: FactUnits, limitPerConcept: number) {
  const unitEntries = Object.entries(units)
    .flatMap(([unit, rows]) => rows.map((row) => ({ unit, ...row })))
    .filter((row) => Number.isFinite(row.val))
    .sort((a, b) => String(b.filed || "").localeCompare(String(a.filed || "")))
    .slice(0, clampLimit(limitPerConcept, 1, 20));
  return { concept, observations: unitEntries };
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: secHeaders() });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`SEC request failed ${response.status} for ${url}: ${body.slice(0, 300)}`);
  }
  return await response.json() as T;
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { headers: secHeaders() });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`SEC request failed ${response.status} for ${url}: ${body.slice(0, 300)}`);
  }
  return await response.text();
}

function secHeaders(): Record<string, string> {
  return {
    "User-Agent": process.env.SEC_USER_AGENT || DEFAULT_USER_AGENT,
    "Accept-Encoding": "gzip, deflate",
    Accept: "application/json, text/html;q=0.9, */*;q=0.8",
  };
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#160;/gi, " ");
}

function normalizeFilingText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function extractSection(text: string, section: string, maxChars: number): string {
  const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  const startRegex = new RegExp(`\\b${escaped}\\b[\\.\\s:-]`, "i");
  const start = text.search(startRegex);
  if (start < 0) return "";
  const nextItem = text.slice(start + section.length).search(/\bItem\s+\d+[A-Z]?\b[\.\s:-]/i);
  const end = nextItem > 200 ? start + section.length + nextItem : start + maxChars;
  return text.slice(start, Math.min(end, start + maxChars)).trim();
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
