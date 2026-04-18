import {
  DEFAULT_SIYUAN_URL,
  resolveToken,
  type FetchLike,
  type ResolveTokenOptions,
} from "./auth.js";

export interface SiyuanClientOptions extends ResolveTokenOptions {
  baseUrl?: string;
  /** Injectable fetch for testing. Defaults to `globalThis.fetch`. */
  fetchImpl?: FetchLike;
  /** If provided, bypasses resolveToken() — useful for tests. */
  apiKey?: string;
}

export interface RequestOptions {
  /**
   * Override the `Accept` header. Default `application/json`.
   * Rarely needed; API endpoints always return JSON.
   */
  accept?: string;
  /** Abort signal forwarded to fetch. */
  signal?: AbortSignal;
}

export class SiyuanApiError extends Error {
  readonly status: number;
  readonly url: string;
  readonly body: string;
  readonly code?: number;
  constructor(opts: {
    message: string;
    status: number;
    url: string;
    body: string;
    code?: number;
  }) {
    super(opts.message);
    this.name = "SiyuanApiError";
    this.status = opts.status;
    this.url = opts.url;
    this.body = opts.body;
    this.code = opts.code;
  }
}

interface SiyuanEnvelope<T> {
  code: number;
  msg: string;
  data: T;
}

/**
 * HTTP client for SiYuan's `/api/*` endpoints. Injects the `kfdb_token`
 * query parameter on every request so the SiYuan iframe-auth bypass accepts
 * the call, and unwraps the `{code,msg,data}` envelope that SiYuan returns.
 *
 * The client resolves its API key lazily on first use and caches it for the
 * lifetime of the instance. Call `invalidateToken()` to force re-resolution
 * (e.g. after `siyuan-mcp login` rewrites the credential file).
 */
export class SiyuanClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly explicitApiKey: string | undefined;
  private readonly resolveOptions: ResolveTokenOptions;
  private cachedApiKey: string | null = null;

  constructor(opts: SiyuanClientOptions = {}) {
    // Resolve base URL in priority order:
    //   1. explicit opts.baseUrl
    //   2. SIYUAN_URL from opts.env (explicit env injection for tests)
    //   3. SIYUAN_URL from process.env (common runtime path — prior versions
    //      forgot this fallback, so callers that passed no options always
    //      hit DEFAULT_SIYUAN_URL even when the operator set SIYUAN_URL=… on
    //      the process. Bug surfaced in M1-DV-1 smoke.)
    //   4. DEFAULT_SIYUAN_URL
    const envUrl =
      opts.env?.SIYUAN_URL ??
      (typeof process !== "undefined" ? process.env?.SIYUAN_URL : undefined);
    this.baseUrl = (opts.baseUrl ?? envUrl ?? DEFAULT_SIYUAN_URL).replace(/\/+$/, "");
    const fallback =
      typeof globalThis.fetch === "function"
        ? (globalThis.fetch.bind(globalThis) as FetchLike)
        : undefined;
    if (!opts.fetchImpl && !fallback) {
      throw new Error("global fetch is not available; pass fetchImpl explicitly");
    }
    this.fetchImpl = (opts.fetchImpl ?? fallback) as FetchLike;
    this.explicitApiKey = opts.apiKey;
    this.resolveOptions = {
      env: opts.env,
      siyuanUrl: this.baseUrl,
      credentialOptions: opts.credentialOptions,
      fetchImpl: this.fetchImpl,
    };
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  invalidateToken(): void {
    this.cachedApiKey = null;
  }

  async getApiKey(): Promise<string> {
    if (this.explicitApiKey) return this.explicitApiKey;
    if (this.cachedApiKey) return this.cachedApiKey;
    const { apiKey } = await resolveToken(this.resolveOptions);
    this.cachedApiKey = apiKey;
    return apiKey;
  }

  /**
   * Build a fully-qualified URL for the given SiYuan API path, appending
   * the `kfdb_token` query param for the iframe-auth bypass.
   */
  async buildUrl(path: string, extraQuery?: Record<string, string>): Promise<string> {
    if (!path.startsWith("/")) path = "/" + path;
    const apiKey = await this.getApiKey();
    const url = new URL(this.baseUrl + path);
    url.searchParams.set("kfdb_token", apiKey);
    if (extraQuery) {
      for (const [k, v] of Object.entries(extraQuery)) {
        url.searchParams.set(k, v);
      }
    }
    return url.toString();
  }

  /**
   * POST a JSON body to a SiYuan API endpoint and return the unwrapped
   * `data` field. Throws `SiyuanApiError` for non-2xx responses or when
   * the envelope `code` is non-zero.
   */
  async post<T = unknown>(
    path: string,
    body: unknown,
    reqOpts: RequestOptions = {},
  ): Promise<T> {
    const url = await this.buildUrl(path);
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: reqOpts.accept ?? "application/json",
      },
      body: JSON.stringify(body ?? {}),
      signal: reqOpts.signal,
    });

    const text = await res.text();
    if (!res.ok) {
      throw new SiyuanApiError({
        message: `SiYuan POST ${path} returned ${res.status} ${res.statusText}`,
        status: res.status,
        url: redactUrl(url),
        body: text.slice(0, 2_000),
      });
    }

    return this.unwrap<T>(path, redactUrl(url), res.status, text);
  }

  /**
   * GET a SiYuan API endpoint (used for a small number of endpoints that
   * are GET-only, e.g. `/api/auth/wallet/status`). Unwraps the envelope.
   */
  async get<T = unknown>(
    path: string,
    query?: Record<string, string>,
    reqOpts: RequestOptions = {},
  ): Promise<T> {
    const url = await this.buildUrl(path, query);
    const res = await this.fetchImpl(url, {
      method: "GET",
      headers: { accept: reqOpts.accept ?? "application/json" },
      signal: reqOpts.signal,
    });

    const text = await res.text();
    if (!res.ok) {
      throw new SiyuanApiError({
        message: `SiYuan GET ${path} returned ${res.status} ${res.statusText}`,
        status: res.status,
        url: redactUrl(url),
        body: text.slice(0, 2_000),
      });
    }

    return this.unwrap<T>(path, redactUrl(url), res.status, text);
  }

  private unwrap<T>(path: string, safeUrl: string, status: number, text: string): T {
    let parsed: SiyuanEnvelope<T>;
    try {
      parsed = JSON.parse(text) as SiyuanEnvelope<T>;
    } catch (err) {
      throw new SiyuanApiError({
        message: `SiYuan ${path} returned non-JSON body: ${(err as Error).message}`,
        status,
        url: safeUrl,
        body: text.slice(0, 2_000),
      });
    }

    if (typeof parsed.code !== "number") {
      throw new SiyuanApiError({
        message: `SiYuan ${path} returned an envelope without a 'code' field`,
        status,
        url: safeUrl,
        body: text.slice(0, 2_000),
      });
    }

    if (parsed.code !== 0) {
      throw new SiyuanApiError({
        message: `SiYuan ${path} rejected request (code=${parsed.code}): ${parsed.msg}`,
        status,
        url: safeUrl,
        body: text.slice(0, 2_000),
        code: parsed.code,
      });
    }

    return parsed.data;
  }
}

/** Redact the `kfdb_token` query param so it never leaks into error messages. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.searchParams.has("kfdb_token")) {
      u.searchParams.set("kfdb_token", "<redacted>");
    }
    return u.toString();
  } catch {
    return url;
  }
}
