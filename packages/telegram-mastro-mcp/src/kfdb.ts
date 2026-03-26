// ============================================================================
// KFDB API CLIENT — Telegram Mastro
// ============================================================================
// Unlike agent0-mcp (global/public reads), Telegram data is PRIVATE:
// ALL requests include X-Wallet-Address to scope to the user's tenant.

const KFDB_BASE_URL = process.env.KFDB_API_URL || "http://34.60.37.158";

// Mutable config — set at runtime via telegram_configure_kfdb tool
let kfdbApiKey = process.env.KFDB_API_KEY || "";
let walletAddress = process.env.WALLET_ADDRESS || "";

export function getKfdbApiKey(): string {
  return kfdbApiKey;
}

export function getWalletAddress(): string {
  return walletAddress;
}

export function setKfdbApiKey(key: string): void {
  kfdbApiKey = key;
}

export function setWalletAddress(addr: string): void {
  walletAddress = addr;
}

function requireAuth(): void {
  if (!kfdbApiKey) {
    throw new Error(
      "KFDB_API_KEY not configured. Use telegram_configure_kfdb or set KFDB_API_KEY env var.",
    );
  }
  if (!walletAddress) {
    throw new Error(
      "WALLET_ADDRESS not configured. Use telegram_configure_kfdb or set WALLET_ADDRESS env var.",
    );
  }
}

export async function kfdbFetch(
  path: string,
  options?: RequestInit,
): Promise<Response> {
  requireAuth();
  const url = `${KFDB_BASE_URL}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${kfdbApiKey}`,
    "X-Wallet-Address": walletAddress,
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
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `KFDB auth failed (${res.status}). Check KFDB_API_KEY and WALLET_ADDRESS.`,
      );
    }
    throw new Error(`KFDB write error: ${res.status} ${text}`);
  }
  return res.json();
}

// ============================================================================
// QUERY API (KQL)
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
      throw new Error(
        `KFDB auth failed (${res.status}). Check KFDB_API_KEY and WALLET_ADDRESS.`,
      );
    }
    throw new Error(`KFDB KQL error: ${res.status} ${text}`);
  }
  const result = (await res.json()) as { data?: Record<string, unknown>[] };
  return result.data ?? [];
}

// ============================================================================
// SEMANTIC SEARCH API
// ============================================================================

export async function kfdbSemanticSearch(
  query: string,
  limit = 10,
  label?: string,
): Promise<Record<string, unknown>[] | null> {
  const body: Record<string, unknown> = {
    query,
    limit,
    min_similarity: 0.5,
  };
  if (label) body.label = label;
  const res = await kfdbFetch("/api/v1/semantic/search", {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { results?: Record<string, unknown>[] };
  return data.results ?? null;
}

// ============================================================================
// ENTITY API
// ============================================================================

export interface KfdbEntityResponse {
  label: string;
  items: Record<string, unknown>[];
  total: number;
  limit: number;
  offset: number;
}

export async function kfdbEntities(
  label: string,
  limit = 20,
  offset = 0,
): Promise<KfdbEntityResponse> {
  const res = await kfdbFetch(
    `/api/v1/entities/${label}?limit=${limit}&offset=${offset}`,
  );
  if (!res.ok) {
    throw new Error(
      `KFDB entity API error: ${res.status} ${await res.text()}`,
    );
  }
  return res.json() as Promise<KfdbEntityResponse>;
}

export async function kfdbLabels(): Promise<{
  labels: { label: string; count: number }[];
}> {
  const res = await kfdbFetch("/api/v1/entities/labels");
  if (!res.ok) {
    throw new Error(
      `KFDB labels API error: ${res.status} ${await res.text()}`,
    );
  }
  return res.json() as Promise<{ labels: { label: string; count: number }[] }>;
}

// ============================================================================
// PROPERTY HELPERS
// ============================================================================

// Wrap raw values into KFDB typed wrappers for write operations
export function wrapString(val: string): { String: string } {
  return { String: val };
}

export function wrapInteger(val: number): { Integer: number } {
  return { Integer: val };
}

export function wrapBoolean(val: boolean): { Boolean: boolean } {
  return { Boolean: val };
}

// Unwrap KFDB typed wrappers from read results
export function unwrap(val: unknown): unknown {
  if (val === null || val === undefined) return val;
  if (typeof val !== "object") return val;
  const obj = val as Record<string, unknown>;
  if ("String" in obj) return obj.String;
  if ("Integer" in obj) return obj.Integer;
  if ("Float" in obj) return obj.Float;
  if ("Boolean" in obj) return obj.Boolean;
  if ("Array" in obj) {
    return (obj.Array as unknown[]).map(unwrap);
  }
  if ("Object" in obj) {
    return unwrapProps(obj.Object as Record<string, unknown>);
  }
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
