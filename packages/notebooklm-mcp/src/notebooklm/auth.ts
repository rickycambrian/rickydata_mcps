// ============================================================================
// AUTH — cookie loading, SAPISIDHASH, and HTML token bootstrap
// ============================================================================
//
// NotebookLM's batchexecute API authenticates with the standard Google web
// session: the auth COOKIES *plus* a SAPISIDHASH Authorization header (cookie-
// only requests 401). Two more tokens (`at`, `bl`, `f.sid`) live in the page's
// WIZ_global_data bootstrap, NOT in cookies, so we fetch the app shell once and
// scrape them.

import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  NOTEBOOKLM_ORIGIN,
  NOTEBOOKLM_COOKIES_ENV,
  NOTEBOOKLM_STATE_B64_ENV,
  NOTEBOOKLM_STATE_PATH,
} from "../config.js";
import { NotConnectedError, AuthExpiredError } from "./errors.js";
import type {
  StorageState,
  StoredCookie,
  BootstrapTokens,
  AuthHeaders,
} from "./types.js";

/**
 * The cookies that must be present for a valid Google/NotebookLM session.
 * Mirrors the existing notebooklm-mcp CRITICAL_COOKIE_NAMES so a session
 * captured by either tool is interchangeable.
 */
export const CRITICAL_COOKIE_NAMES = [
  "SID",
  "HSID",
  "SSID",
  "APISID",
  "SAPISID",
  "OSID",
  "__Secure-OSID",
  "__Secure-1PSID",
  "__Secure-3PSID",
] as const;

/** Default location `npm run connect` writes a local session to. */
export function defaultStatePath(): string {
  return join(
    homedir(),
    "Library",
    "Application Support",
    "notebooklm-mcp",
    "browser_state",
    "state.json",
  );
}

/**
 * Load the stored Google session as a cookie map.
 *
 * Priority: NOTEBOOKLM_COOKIES (raw JSON, vault-injected) → NOTEBOOKLM_STATE_B64
 * (base64 JSON — what `rickydata notebook-studio connect` uploads) → explicit/
 * default state.json → NotConnectedError. The decoded value may be either a
 * Playwright storageState object or a bare `{cookies:[...]}`.
 */
export function loadCookieJar(): Map<string, StoredCookie> {
  let raw: string | null = null;

  // Read the cookie-source vars at call time (env may be injected after import,
  // and this keeps the loader unit-testable per case).
  const cookiesEnv = process.env.NOTEBOOKLM_COOKIES || NOTEBOOKLM_COOKIES_ENV;
  const b64Env = process.env.NOTEBOOKLM_STATE_B64 || NOTEBOOKLM_STATE_B64_ENV;

  if (cookiesEnv) {
    raw = cookiesEnv;
  } else if (b64Env) {
    try {
      raw = Buffer.from(b64Env, "base64").toString("utf8");
    } catch {
      throw new NotConnectedError(
        "NOTEBOOKLM_STATE_B64 is not valid base64. Re-run connect.",
      );
    }
  } else {
    const path =
      NOTEBOOKLM_STATE_PATH ||
      process.env.NOTEBOOKLM_STATE_PATH ||
      defaultStatePath();
    if (existsSync(path)) raw = readFileSync(path, "utf8");
  }

  if (!raw) throw new NotConnectedError();

  let state: StorageState;
  try {
    state = JSON.parse(raw) as StorageState;
  } catch {
    throw new NotConnectedError(
      "NOTEBOOKLM_COOKIES / state.json is not valid JSON. Re-run connect.",
    );
  }

  const cookies = state.cookies ?? [];
  const jar = new Map<string, StoredCookie>();
  for (const c of cookies) {
    if (!c || typeof c.name !== "string") continue;
    // Google auth cookies live on .google.com; ignore unrelated domains.
    if (c.domain && !c.domain.includes("google.com")) continue;
    jar.set(c.name, c);
  }

  // A session without SAPISID can never produce a valid Authorization header.
  if (!jar.has("SAPISID") && !jar.has("__Secure-3PAPISID")) {
    throw new NotConnectedError(
      "Stored session has no SAPISID cookie (cannot sign requests). Re-run connect.",
    );
  }
  return jar;
}

/** True if a critical cookie carries a concrete (non-session) expiry in the past. */
export function hasExpiredCriticalCookie(jar: Map<string, StoredCookie>): boolean {
  const nowSec = Date.now() / 1000;
  for (const name of CRITICAL_COOKIE_NAMES) {
    const c = jar.get(name);
    if (!c) continue;
    const exp = c.expires ?? -1;
    if (exp > 0 && exp < nowSec) return true;
  }
  return false;
}

/** One SAPISIDHASH triple: `<prefix> <ts>_<sha1(ts SP sapisid SP origin)>`. */
function sapisidHash(prefix: string, sapisid: string, origin: string, ts: number): string {
  const digest = createHash("sha1")
    .update(`${ts} ${sapisid} ${origin}`)
    .digest("hex");
  return `${prefix} ${ts}_${digest}`;
}

/**
 * Build the Authorization header value Google expects for batchexecute. Includes
 * the 1P/3P variants when their cookies are present (matches the browser, which
 * sends all three so any cookie-partition is accepted).
 */
export function buildAuthorization(
  jar: Map<string, StoredCookie>,
  origin: string,
  nowMs: number = Date.now(),
): string {
  const ts = Math.floor(nowMs / 1000);
  const parts: string[] = [];
  const sapisid = jar.get("SAPISID")?.value;
  if (sapisid) parts.push(sapisidHash("SAPISIDHASH", sapisid, origin, ts));
  const oneP = jar.get("__Secure-1PAPISID")?.value;
  if (oneP) parts.push(sapisidHash("SAPISID1PHASH", oneP, origin, ts));
  const threeP = jar.get("__Secure-3PAPISID")?.value ?? sapisid;
  if (threeP) parts.push(sapisidHash("SAPISID3PHASH", threeP, origin, ts));
  return parts.join(" ");
}

/** Serialize the jar into a `Cookie:` header value. */
export function buildCookieHeader(jar: Map<string, StoredCookie>): string {
  const pairs: string[] = [];
  for (const c of jar.values()) {
    if (c.name && c.value != null) pairs.push(`${c.name}=${c.value}`);
  }
  return pairs.join("; ");
}

/** Assemble the full auth header set for a request. */
export function buildAuthHeaders(
  jar: Map<string, StoredCookie>,
  origin: string = NOTEBOOKLM_ORIGIN,
  nowMs: number = Date.now(),
): AuthHeaders {
  return {
    Cookie: buildCookieHeader(jar),
    Authorization: buildAuthorization(jar, origin, nowMs),
    Origin: origin,
    "X-Same-Domain": "1",
  };
}

/**
 * Parse the three bootstrap tokens out of a NotebookLM app-shell HTML body.
 * Exposed (pure) so it can be unit-tested against a fixture without network.
 * Tokens live in `window.WIZ_global_data = {...}` as keys:
 *   SNlM0e → at (XSRF) · cfb2h → bl (build) · FdrFJe → f.sid (session)
 */
export function parseBootstrapTokens(html: string): BootstrapTokens {
  const pick = (key: string): string | null => {
    // WIZ_global_data is a JS object literal: "key":"value" (value may contain
    // escaped chars but never an unescaped quote). Be liberal about whitespace.
    const m = html.match(new RegExp(`"${key}":"([^"]*)"`));
    return m ? m[1] : null;
  };
  const at = pick("SNlM0e");
  const bl = pick("cfb2h");
  const fsid = pick("FdrFJe");
  if (!at || !bl || !fsid) {
    throw new AuthExpiredError(
      `Could not read NotebookLM bootstrap tokens (at=${!!at} bl=${!!bl} f.sid=${!!fsid}). ` +
        `The session is likely expired/revoked — re-run connect.`,
    );
  }
  return { at, bl, fsid };
}

/**
 * Fetch the NotebookLM app shell with the session and extract the bootstrap
 * tokens. A login-page redirect (200 HTML with an accounts.google.com form, or a
 * 401/403) means the session is dead → AuthExpiredError.
 */
export async function bootstrapTokens(
  jar: Map<string, StoredCookie>,
  fetchImpl: typeof fetch = fetch,
  origin: string = NOTEBOOKLM_ORIGIN,
): Promise<BootstrapTokens> {
  const headers = buildAuthHeaders(jar, origin);
  const res = await fetchImpl(`${origin}/`, {
    method: "GET",
    headers: {
      ...headers,
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml",
    },
    redirect: "follow",
  });
  if (res.status === 401 || res.status === 403) {
    throw new AuthExpiredError();
  }
  const body = await res.text();
  // Redirected to the Google login flow — session is invalid even with 200.
  if (/accounts\.google\.com\/(v\d+\/)?signin|ServiceLogin/.test(body) && !/WIZ_global_data/.test(body)) {
    throw new AuthExpiredError();
  }
  return parseBootstrapTokens(body);
}
