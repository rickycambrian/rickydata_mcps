import {
  extractApiKey,
  readCredential,
  type CredentialStoreOptions,
} from "./credential-store.js";

/**
 * Minimal structural type we need from `fetch`. Using a structural type
 * instead of importing `typeof undici.fetch` keeps the tests free to inject
 * `nock`'s request-interceptor-compatible `globalThis.fetch`.
 */
export type FetchLike = (
  input: string | URL,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  text(): Promise<string>;
  json(): Promise<unknown>;
}>;

function defaultFetch(): FetchLike {
  if (typeof globalThis.fetch === "function") {
    return globalThis.fetch.bind(globalThis) as FetchLike;
  }
  throw new Error("global fetch is not available; running on Node < 18?");
}

export const DEFAULT_SIYUAN_URL = "https://siyuan.rickydata.org";

export type TokenSource =
  | "env:SIYUAN_KFDB_TOKEN"
  | "env:SIYUAN_KFDB_JWT"
  | "credential-file";

export interface ResolvedToken {
  /** Raw KFDB API key — the value to send as `?kfdb_token=`. */
  apiKey: string;
  source: TokenSource;
}

export interface ResolveTokenOptions {
  env?: NodeJS.ProcessEnv;
  siyuanUrl?: string;
  credentialOptions?: CredentialStoreOptions;
  /** Injectable fetch for testing. Defaults to `globalThis.fetch`. */
  fetchImpl?: FetchLike;
}

interface JwtExchangeResponse {
  code?: number;
  msg?: string;
  data?: {
    token?: string;
    api_key?: string;
    apiKey?: string;
  } | null;
}

/**
 * In-memory cache of the key derived by JWT exchange. **Never** persisted to
 * disk — the credential file is reserved for paste-back tokens minted by the
 * user. Cleared by `resetJwtExchangeCache()` for tests.
 */
let jwtExchangeCache: { jwt: string; apiKey: string } | null = null;

export function resetJwtExchangeCache(): void {
  jwtExchangeCache = null;
}

/**
 * Exchange a KnowledgeFlow Google-OAuth JWT for a KFDB API key by calling
 * `POST /api/auth/kfdb/token`. The resulting key is cached in-memory keyed
 * on the JWT so repeated calls are cheap.
 *
 * Throws on non-2xx responses or malformed bodies. The JWT value is never
 * included in thrown Error messages.
 */
export async function exchangeJwtForApiKey(
  jwt: string,
  opts: { siyuanUrl?: string; fetchImpl?: FetchLike } = {},
): Promise<string> {
  if (!jwt) throw new Error("SIYUAN_KFDB_JWT is empty");
  if (jwtExchangeCache && jwtExchangeCache.jwt === jwt) {
    return jwtExchangeCache.apiKey;
  }

  const base = (opts.siyuanUrl ?? DEFAULT_SIYUAN_URL).replace(/\/+$/, "");
  const fetchImpl = opts.fetchImpl ?? defaultFetch();
  const url = `${base}/api/auth/kfdb/token`;

  let res;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: jwt }),
    });
  } catch (err) {
    throw new Error(
      `JWT exchange request to ${url} failed: ${(err as Error).message}`,
    );
  }

  if (!res.ok) {
    throw new Error(
      `JWT exchange returned ${res.status} ${res.statusText} from ${url}`,
    );
  }

  let body: JwtExchangeResponse;
  try {
    body = (await res.json()) as JwtExchangeResponse;
  } catch (err) {
    throw new Error(
      `JWT exchange response from ${url} was not JSON: ${(err as Error).message}`,
    );
  }

  if (typeof body.code === "number" && body.code !== 0) {
    throw new Error(
      `JWT exchange rejected (code=${body.code}): ${body.msg ?? "unknown error"}`,
    );
  }

  const apiKey =
    body.data?.token ?? body.data?.api_key ?? body.data?.apiKey ?? null;
  if (!apiKey || typeof apiKey !== "string") {
    throw new Error(`JWT exchange response missing api key (url=${url})`);
  }

  jwtExchangeCache = { jwt, apiKey };
  return apiKey;
}

/**
 * Resolve the KFDB API key to use for outgoing SiYuan calls, following the
 * documented priority order. Throws a descriptive error if no source yields
 * a usable token.
 *
 * The returned `apiKey` is the raw value to send as `?kfdb_token=` — the
 * `siymcp_v1_` prefix is already stripped.
 */
export async function resolveToken(
  options: ResolveTokenOptions = {},
): Promise<ResolvedToken> {
  const env = options.env ?? process.env;

  const raw = env.SIYUAN_KFDB_TOKEN;
  if (raw && raw.trim().length > 0) {
    return { apiKey: raw.trim(), source: "env:SIYUAN_KFDB_TOKEN" };
  }

  const jwt = env.SIYUAN_KFDB_JWT;
  if (jwt && jwt.trim().length > 0) {
    const apiKey = await exchangeJwtForApiKey(jwt.trim(), {
      siyuanUrl: options.siyuanUrl,
      fetchImpl: options.fetchImpl,
    });
    return { apiKey, source: "env:SIYUAN_KFDB_JWT" };
  }

  const record = readCredential(options.credentialOptions);
  if (record) {
    return {
      apiKey: extractApiKey(record.token),
      source: "credential-file",
    };
  }

  throw new Error(
    "no SiYuan auth credential found. Set SIYUAN_KFDB_TOKEN, SIYUAN_KFDB_JWT, or run `siyuan-mcp login`.",
  );
}
