// ============================================================================
// KFDB API CLIENT — Research Papers MCP
// ============================================================================

import { KFDB_API_URL, KFDB_API_KEY } from "./config.js";
import type { PaperChunk } from "./parser.js";

export async function kfdbFetch(
  path: string,
  options?: RequestInit,
): Promise<Response> {
  const url = `${KFDB_API_URL}${path}`;
  const apiKey = KFDB_API_KEY;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    ...((options?.headers as Record<string, string>) || {}),
  };
  return fetch(url, { ...options, headers });
}

// ============================================================================
// WRITE API
// ============================================================================

export interface CreateNodeOp {
  operation: "create_node";
  label: string;
  id: string;
  properties: Record<string, unknown>;
}

export interface CreateEdgeOp {
  operation: "create_edge";
  edge_type: string;
  from_id: string;
  to_id: string;
  properties?: Record<string, unknown>;
}

export type WriteOp = CreateNodeOp | CreateEdgeOp;

export async function kfdbWrite(operations: WriteOp[]): Promise<unknown> {
  const res = await kfdbFetch("/api/v1/write", {
    method: "POST",
    body: JSON.stringify({ operations }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`KFDB write error: ${res.status} ${text}`);
  }
  return res.json();
}

// ============================================================================
// SEMANTIC SEARCH API
// ============================================================================

export interface SemanticSearchResult {
  id: string;
  label: string;
  similarity: number;
  properties: Record<string, unknown>;
  file_path?: string;
}

export async function kfdbSemanticSearch(
  query: string,
  limit = 10,
  label?: string,
  file_path_prefix?: string,
  include_entities?: boolean,
  use_context?: boolean,
): Promise<SemanticSearchResult[]> {
  const body: Record<string, unknown> = {
    query,
    limit,
    min_similarity: 0.4,
  };
  if (label) body.label = label;
  if (file_path_prefix) body.file_path_prefix = file_path_prefix;
  if (include_entities) body.include_entities = true;
  if (use_context) body.use_context = true;
  const res = await kfdbFetch("/api/v1/semantic/search", {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!res.ok) return [];
  const data = (await res.json()) as { results?: SemanticSearchResult[] };
  return data.results ?? [];
}

// ============================================================================
// PROPERTY HELPERS
// ============================================================================

export function wrapString(val: string): { String: string } {
  return { String: val };
}

export function wrapInteger(val: number): { Integer: number } {
  return { Integer: val };
}

export function wrapBoolean(val: boolean): { Boolean: boolean } {
  return { Boolean: val };
}

export function unwrap(val: unknown): unknown {
  if (val === null || val === undefined) return val;
  if (typeof val !== "object") return val;
  const obj = val as Record<string, unknown>;
  if ("String" in obj) return obj.String;
  if ("Integer" in obj) return obj.Integer;
  if ("Float" in obj) return obj.Float;
  if ("Boolean" in obj) return obj.Boolean;
  if ("Array" in obj) return (obj.Array as unknown[]).map(unwrap);
  if ("Object" in obj) return unwrapProps(obj.Object as Record<string, unknown>);
  return val;
}

export function unwrapProps(
  props: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(props)) {
    result[key] = unwrap(val);
  }
  return result;
}

export function extractKqlNode(
  row: Record<string, unknown>,
  alias = "n",
): Record<string, unknown> | null {
  const wrapper = row[alias] as Record<string, unknown> | undefined;
  if (wrapper && "Object" in wrapper) {
    return unwrapProps(wrapper.Object as Record<string, unknown>);
  }
  if (wrapper && typeof wrapper === "object") {
    return unwrapProps(wrapper);
  }
  if (Object.keys(row).length > 0 && !wrapper) {
    return unwrapProps(row);
  }
  return null;
}

// ============================================================================
// KQL QUERY API
// ============================================================================

export async function kfdbKQL(
  query: string,
): Promise<Record<string, unknown>[]> {
  const res = await kfdbFetch("/api/v1/query", {
    method: "POST",
    body: JSON.stringify({ query }),
  });
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 401 || res.status === 403) {
      throw new Error(`KFDB auth failed (${res.status}). Check KFDB_API_KEY.`);
    }
    throw new Error(`KFDB KQL error: ${res.status} ${text}`);
  }
  const result = (await res.json()) as { data?: Record<string, unknown>[] };
  return result.data ?? [];
}

// ============================================================================
// RESEARCH PAPER SPECIFIC OPERATIONS
// ============================================================================

/**
 * Store a single chunk via the file-embeddings API for Gemini auto-embedding.
 * file_path: ResearchPaper://{arxivId}/chunk-{ordinal} (globally unique across sections)
 */
export async function storeChunkEmbedding(
  arxivId: string,
  chunk: PaperChunk,
): Promise<void> {
  await kfdbFetch("/api/v1/file-embeddings/store-content", {
    method: "POST",
    body: JSON.stringify({
      file_path: `ResearchPaper://${arxivId}/chunk-${chunk.ordinal}`,
      content: chunk.text,
      repo_name: "research-papers",
    }),
  });
}

/**
 * Store multimodal (PDF) embedding in KFDB.
 */
export async function storeMultimodalEmbedding(
  pdfBase64: string,
): Promise<unknown> {
  const res = await kfdbFetch("/api/v1/semantic/embed/multimodal", {
    method: "POST",
    body: JSON.stringify({
      image_base64: pdfBase64,
      mime_type: "application/pdf",
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Multimodal embed error: ${res.status} ${text}`);
  }
  return res.json();
}

/**
 * Check if a ResearchPaper node already exists in KFDB.
 */
export async function checkPaperExists(arxivId: string): Promise<boolean> {
  try {
    const rows = await kfdbKQL(
      `MATCH (n:ResearchPaper {arxiv_id: "${arxivId}"}) RETURN n`,
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

export interface PaperNodeMetadata {
  arxivId: string;
  title: string;
  authors: string[];
  abstract: string;
  published: string;
  categories: string[];
  sectionCount: number;
  chunkCount: number;
  totalChars: number;
  sourceFormat: "html" | "pdf";
  fetchedAt: string;
}

/**
 * Create a ResearchPaper graph node in KFDB.
 */
export async function storePaperNode(meta: PaperNodeMetadata): Promise<unknown> {
  const op: CreateNodeOp = {
    operation: "create_node",
    label: "ResearchPaper",
    id: `ResearchPaper://${meta.arxivId}`,
    properties: {
      arxiv_id: wrapString(meta.arxivId),
      title: wrapString(meta.title),
      authors: wrapString(meta.authors.join(", ")),
      abstract: wrapString(meta.abstract.slice(0, 2000)),
      published: wrapString(meta.published),
      categories: wrapString(meta.categories.join(", ")),
      section_count: wrapInteger(meta.sectionCount),
      chunk_count: wrapInteger(meta.chunkCount),
      total_chars: wrapInteger(meta.totalChars),
      source_format: wrapString(meta.sourceFormat),
      fetched_at: wrapString(meta.fetchedAt),
    },
  };
  return kfdbWrite([op]);
}

/**
 * List ResearchPaper nodes from KFDB.
 */
export async function listPaperNodes(
  limit = 20,
): Promise<Record<string, unknown>[]> {
  const rows = await kfdbKQL(
    `MATCH (n:ResearchPaper) RETURN n LIMIT ${limit}`,
  );
  return rows.map((row) => extractKqlNode(row) ?? row);
}
