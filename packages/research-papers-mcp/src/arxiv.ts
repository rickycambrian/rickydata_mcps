/**
 * arXiv API Client — Queries the arXiv Atom feed for paper discovery.
 *
 * arXiv API docs: https://info.arxiv.org/help/api/basics.html
 * Rate limit: max 1 request per 3 seconds.
 * Max results per query: 50.
 */

import { ARXIV_RATE_LIMIT_MS } from "./config.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface ArxivPaper {
  arxivId: string;
  title: string;
  authors: string[];
  abstract: string;
  published: string;
  updated: string;
  categories: string[];
  pdfUrl: string;
}

export interface ArxivSearchParams {
  /** arXiv categories, e.g. ['cs.AI', 'cs.CL'] */
  categories?: string[];
  /** Free-text keyword to search in title + abstract */
  keyword?: string;
  /** ISO date string — only papers submitted on or after this date */
  startDate?: string;
  /** ISO date string — only papers submitted on or before this date */
  endDate?: string;
  /** Max results (capped at 50 per arXiv API limit) */
  maxResults?: number;
  /** Sort by: relevance, lastUpdatedDate, submittedDate */
  sortBy?: 'relevance' | 'lastUpdatedDate' | 'submittedDate';
}

// ── Rate Limiter ───────────────────────────────────────────────────────────

let lastRequestTime = 0;

async function enforceRateLimit(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < ARXIV_RATE_LIMIT_MS) {
    await new Promise(resolve => setTimeout(resolve, ARXIV_RATE_LIMIT_MS - elapsed));
  }
  lastRequestTime = Date.now();
}

// ── XML Parsing Helpers ────────────────────────────────────────────────────

/**
 * Extract text content of the first matching tag.
 * Handles both `<tag>text</tag>` and `<ns:tag>text</ns:tag>`.
 */
function extractTag(xml: string, tag: string): string {
  const re = new RegExp(`<(?:[a-z]+:)?${tag}[^>]*>([\\s\\S]*?)</(?:[a-z]+:)?${tag}>`, 'i');
  const match = xml.match(re);
  return match ? match[1].trim() : '';
}

/**
 * Extract all occurrences of a tag's text content.
 */
function extractAllTags(xml: string, tag: string): string[] {
  const re = new RegExp(`<(?:[a-z]+:)?${tag}[^>]*>([\\s\\S]*?)</(?:[a-z]+:)?${tag}>`, 'gi');
  const results: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null) {
    results.push(match[1].trim());
  }
  return results;
}

/**
 * Extract attribute value from a tag.
 */
function extractAttr(xml: string, tag: string, attr: string): string {
  const re = new RegExp(`<(?:[a-z]+:)?${tag}[^>]*?${attr}="([^"]*)"`, 'i');
  const match = xml.match(re);
  return match ? match[1] : '';
}

/**
 * Extract all attribute values from matching tags.
 */
function extractAllAttrs(xml: string, tag: string, attr: string): string[] {
  const re = new RegExp(`<(?:[a-z]+:)?${tag}[^>]*?${attr}="([^"]*)"`, 'gi');
  const results: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null) {
    results.push(match[1]);
  }
  return results;
}

// ── Entry Parsing ──────────────────────────────────────────────────────────

function parseEntry(entryXml: string): ArxivPaper | null {
  const idUrl = extractTag(entryXml, 'id');
  // arXiv ID is the last path segment: http://arxiv.org/abs/2301.07041v2
  const idMatch = idUrl.match(/abs\/(\d{4}\.\d{4,5}(?:v\d+)?)/);
  if (!idMatch) return null;

  const rawId = idMatch[1];
  // Strip version suffix for canonical ID
  const arxivId = rawId.replace(/v\d+$/, '');

  const title = extractTag(entryXml, 'title').replace(/\s+/g, ' ');
  const abstract = extractTag(entryXml, 'summary').replace(/\s+/g, ' ');
  const published = extractTag(entryXml, 'published');
  const updated = extractTag(entryXml, 'updated');

  // Authors: each <author><name>...</name></author>
  const authorBlocks = entryXml.match(/<author>([\s\S]*?)<\/author>/gi) || [];
  const authors = authorBlocks
    .map(block => extractTag(block, 'name'))
    .filter(Boolean);

  // Categories: <category term="cs.AI" />
  const categories = extractAllAttrs(entryXml, 'category', 'term');

  // PDF link: <link title="pdf" href="..." />
  let pdfUrl = '';
  const linkMatches = entryXml.match(/<link[^>]*>/gi) || [];
  for (const link of linkMatches) {
    if (link.includes('title="pdf"')) {
      const href = link.match(/href="([^"]*)"/);
      if (href) pdfUrl = href[1];
    }
  }

  if (!title || !arxivId) return null;

  return { arxivId, title, authors, abstract, published, updated, categories, pdfUrl };
}

// ── Query Builder ──────────────────────────────────────────────────────────

function buildSearchQuery(params: ArxivSearchParams): string {
  const parts: string[] = [];

  if (params.categories && params.categories.length > 0) {
    const catQuery = params.categories.map(c => `cat:${c}`).join('+OR+');
    parts.push(params.categories.length > 1 ? `(${catQuery})` : catQuery);
  }

  if (params.keyword) {
    const escaped = encodeURIComponent(params.keyword);
    parts.push(`(ti:${escaped}+OR+abs:${escaped})`);
  }

  return parts.length > 0 ? parts.join('+AND+') : 'cat:cs.AI';
}

// ── Public API ─────────────────────────────────────────────────────────────

const ARXIV_API_BASE = 'http://export.arxiv.org/api/query';
const MAX_RESULTS_CAP = 50;

/**
 * Search arXiv for papers matching the given parameters.
 * Enforces rate limiting between requests.
 */
export async function searchPapers(params: ArxivSearchParams = {}): Promise<ArxivPaper[]> {
  await enforceRateLimit();

  const query = buildSearchQuery(params);
  const maxResults = Math.min(params.maxResults || 25, MAX_RESULTS_CAP);
  const sortBy = params.sortBy || 'submittedDate';

  const url = `${ARXIV_API_BASE}?search_query=${query}&start=0&max_results=${maxResults}&sortBy=${sortBy}&sortOrder=descending`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`arXiv API returned ${res.status}: ${res.statusText}`);
  }

  const xml = await res.text();

  const entryBlocks = xml.match(/<entry>([\s\S]*?)<\/entry>/gi) || [];
  const papers: ArxivPaper[] = [];

  for (const block of entryBlocks) {
    const paper = parseEntry(block);
    if (!paper) continue;

    if (params.startDate && paper.published < params.startDate) continue;
    if (params.endDate && paper.published > params.endDate) continue;

    papers.push(paper);
  }

  return papers;
}

/**
 * Fetch a single paper by arXiv ID.
 */
export async function fetchPaper(arxivId: string): Promise<ArxivPaper | null> {
  await enforceRateLimit();

  const url = `${ARXIV_API_BASE}?id_list=${arxivId}&max_results=1`;
  const res = await fetch(url);
  if (!res.ok) return null;

  const xml = await res.text();
  const entryBlocks = xml.match(/<entry>([\s\S]*?)<\/entry>/gi) || [];
  const first = entryBlocks[0];
  if (!first) return null;

  return parseEntry(first);
}

/**
 * Search for recent papers in multiple categories.
 * Combines results and deduplicates by arXiv ID.
 */
export async function discoverRecent(
  categories: string[],
  keyword?: string,
  maxResults = 25,
): Promise<ArxivPaper[]> {
  const papers = await searchPapers({
    categories,
    keyword,
    maxResults,
    sortBy: 'submittedDate',
  });

  const seen = new Set<string>();
  return papers.filter(p => {
    if (seen.has(p.arxivId)) return false;
    seen.add(p.arxivId);
    return true;
  });
}

/**
 * Fetch arXiv HTML page for a paper. Returns body text or null on 404/redirect.
 */
export async function fetchHtml(arxivId: string): Promise<string | null> {
  try {
    const res = await fetch(`https://arxiv.org/html/${arxivId}`, {
      redirect: 'follow',
    });
    if (!res.ok) return null;
    // If redirected away from html path, treat as not available
    const finalUrl = res.url;
    if (!finalUrl.includes('/html/')) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/**
 * Fetch arXiv PDF as a Buffer. Returns null on 404 or error.
 */
export async function fetchPdfBuffer(arxivId: string): Promise<Buffer | null> {
  try {
    const res = await fetch(`https://arxiv.org/pdf/${arxivId}`);
    if (!res.ok) return null;
    const arrayBuf = await res.arrayBuffer();
    return Buffer.from(arrayBuf);
  } catch {
    return null;
  }
}
