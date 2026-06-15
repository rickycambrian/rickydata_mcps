// ============================================================================
// BATCHEXECUTE CLIENT — drives NotebookLM's internal RPC API over plain fetch
// ============================================================================
//
//   POST {origin}/_/{APP}/data/batchexecute
//     ?rpcids=<ID>&source-path=/notebook/<id>&bl=<build>&f.sid=<sid>
//     &hl=en&_reqid=<n>&rt=c
//   Body (form-urlencoded):
//     f.req = [[[ "<rpcid>", "<JSON inner payload>", null, "generic" ]]]
//     at    = <XSRF token>
//
// No DOM, no page-load waits (NotebookLM's persistent SSE means `networkidle`
// never fires — irrelevant here, we issue a single POST). Tokens are cached and
// refreshed once on an auth failure; a second failure is terminal.

import { NOTEBOOKLM_ORIGIN, NOTEBOOKLM_APP } from "../config.js";
import {
  loadCookieJar,
  buildAuthHeaders,
  bootstrapTokens,
  hasExpiredCriticalCookie,
} from "./auth.js";
import { extractRpcPayload, looksLikeLoginHtml } from "./parse.js";
import {
  AuthExpiredError,
  RateLimitError,
  ContractBrokenError,
} from "./errors.js";
import { getSpec } from "./rpc.js";
import type { BootstrapTokens, StoredCookie } from "./types.js";

export interface CallOptions {
  /** Notebook source path → the `source-path` query param. */
  sourcePath?: string;
}

/**
 * Build the `f.req` field value Google expects:
 *   [[[ rpcid, JSON.stringify(payload), null, "generic" ]]]
 * Pure + exported for byte-equality testing against captured fixtures.
 */
export function encodeFReq(rpcid: string, payload: unknown[]): string {
  return JSON.stringify([[[rpcid, JSON.stringify(payload), null, "generic"]]]);
}

export class BatchExecuteClient {
  private jar: Map<string, StoredCookie>;
  private tokens: BootstrapTokens | null = null;
  private reqid: number;
  private readonly fetchImpl: typeof fetch;
  private readonly origin: string;

  constructor(opts?: { fetchImpl?: typeof fetch; origin?: string }) {
    this.fetchImpl = opts?.fetchImpl ?? fetch;
    this.origin = opts?.origin ?? NOTEBOOKLM_ORIGIN;
    // Loading the jar validates that a session exists (throws NotConnectedError).
    this.jar = loadCookieJar();
    // Seed reqid with a pseudo-random base like the browser does (avoid Date in
    // tests by deriving from jar size; collisions are harmless — server ignores).
    this.reqid = 100000 + Math.floor((this.jar.size * 7919) % 800000);
  }

  /** True if a critical cookie is already expired locally (cheap pre-check). */
  hasLocallyExpiredCookie(): boolean {
    return hasExpiredCriticalCookie(this.jar);
  }

  /** Live build label, once bootstrapped (else null). */
  get bl(): string | null {
    return this.tokens?.bl ?? null;
  }

  /** Ensure we have bootstrap tokens, fetching them once if needed. */
  private async ensureTokens(force = false): Promise<BootstrapTokens> {
    if (!this.tokens || force) {
      this.tokens = await bootstrapTokens(this.jar, this.fetchImpl, this.origin);
    }
    return this.tokens;
  }

  private batchUrl(rpcid: string, tokens: BootstrapTokens, sourcePath?: string): string {
    const params = new URLSearchParams({
      rpcids: rpcid,
      "source-path": sourcePath || "/",
      bl: tokens.bl,
      "f.sid": tokens.fsid,
      hl: "en",
      _reqid: String((this.reqid += 100000)),
      rt: "c",
    });
    return `${this.origin}/_/${NOTEBOOKLM_APP}/data/batchexecute?${params.toString()}`;
  }

  private buildFReq(rpcid: string, payload: unknown[]): string {
    return encodeFReq(rpcid, payload);
  }

  /**
   * Execute one action by name. Looks up the rpcid + codec in the registry,
   * encodes the args, POSTs, parses the wrb.fr frame, and decodes the result.
   * Refreshes tokens once on an auth failure, then gives up (no infinite loop).
   */
  async callAction(
    action: string,
    args: Record<string, unknown>,
    opts: CallOptions = {},
  ): Promise<unknown> {
    const spec = getSpec(action);
    if (!spec || !spec.rpcid) {
      // Registry/encoder will surface NotCapturedError for uncaptured actions.
      spec?.encode(args);
      throw new ContractBrokenError(action, spec?.rpcid ?? "?", this.bl, "unknown action");
    }
    const rpcid = spec.rpcid;
    const payload = spec.encode(args);

    const exec = async (force: boolean): Promise<unknown> => {
      const tokens = await this.ensureTokens(force);
      const url = this.batchUrl(rpcid, tokens, opts.sourcePath);
      const headers = buildAuthHeaders(this.jar, this.origin);
      const body = new URLSearchParams({
        "f.req": this.buildFReq(rpcid, payload),
        at: tokens.at,
      }).toString();

      const res = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          ...headers,
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
          Accept: "*/*",
        },
        body,
      });

      if (res.status === 429) throw new RateLimitError();
      if (res.status === 401 || res.status === 403) throw new AuthExpiredError();

      const text = await res.text();
      if (looksLikeLoginHtml(text)) throw new AuthExpiredError();
      if (!res.ok) {
        throw new ContractBrokenError(
          action,
          rpcid,
          tokens.bl,
          `HTTP ${res.status}: ${text.slice(0, 160)}`,
        );
      }
      return extractRpcPayload(text, rpcid, action, tokens.bl);
    };

    try {
      const data = await exec(false);
      return spec.decode(data);
    } catch (err) {
      // One token refresh + retry on auth failure (cookies valid, tokens stale).
      if (err instanceof AuthExpiredError && this.tokens) {
        this.tokens = null;
        const data = await exec(true);
        return spec.decode(data);
      }
      throw err;
    }
  }
}
