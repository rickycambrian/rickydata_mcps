// ============================================================================
// PARSE — batchexecute response envelope decoding
// ============================================================================
//
// A batchexecute response looks like:
//
//   )]}'
//
//   <len>
//   [["wrb.fr","<rpcid>","<json-string-payload>",null,null,null,"generic"],...]
//   <len>
//   [["di",NN],["af.httprm",...]]
//   ...
//
// The leading )]}' is the standard Google anti-JSON-hijack prefix. The body is a
// sequence of length-prefixed chunks; each chunk is a JSON array of frames. The
// frame we want is the `wrb.fr` frame whose 2nd element matches our rpcid; its
// 3rd element is the *string-encoded* JSON payload for that RPC.

import { ContractBrokenError, AuthExpiredError } from "./errors.js";

const XSSI_PREFIX = ")]}'";

/** Strip the )]}' anti-hijack prefix (and any leading whitespace) if present. */
export function stripXssiPrefix(body: string): string {
  const trimmed = body.replace(/^\s*/, "");
  if (trimmed.startsWith(XSSI_PREFIX)) {
    return trimmed.slice(XSSI_PREFIX.length);
  }
  return trimmed;
}

/** True when a response body is actually a Google login page, not RPC data. */
export function looksLikeLoginHtml(body: string): boolean {
  const head = body.slice(0, 4000);
  return (
    /<html/i.test(head) &&
    /(accounts\.google\.com|ServiceLogin|signin\/v\d)/i.test(head)
  );
}

/**
 * Split the (prefix-stripped) body into chunk JSON strings. Google length-prefix
 * frames the payload: a line containing a decimal byte length, then that many
 * bytes of JSON. We tolerate this strictly (count chars) but also fall back to
 * brace-scanning so a length mismatch from multi-byte chars never loses a frame.
 */
export function splitChunks(stripped: string): string[] {
  const chunks: string[] = [];
  let i = 0;
  const n = stripped.length;
  while (i < n) {
    // Skip whitespace/newlines between chunks.
    while (i < n && /\s/.test(stripped[i])) i++;
    if (i >= n) break;
    // Optional length prefix (digits on their own line).
    const lenMatch = /^(\d+)\r?\n/.exec(stripped.slice(i));
    if (lenMatch) {
      i += lenMatch[0].length;
      const len = parseInt(lenMatch[1], 10);
      const candidate = stripped.slice(i, i + len);
      // Trust the length only if it yields parseable JSON; else brace-scan.
      try {
        JSON.parse(candidate);
        chunks.push(candidate);
        i += len;
        continue;
      } catch {
        /* fall through to brace scan from current i */
      }
    }
    // Brace/bracket scan: capture one balanced JSON array/object.
    const scanned = scanBalanced(stripped, i);
    if (!scanned) break;
    chunks.push(scanned.text);
    i = scanned.end;
  }
  return chunks;
}

/** Scan a single balanced [...]/{...} value starting at `start`; returns text+end. */
function scanBalanced(s: string, start: number): { text: string; end: number } | null {
  let i = start;
  while (i < s.length && s[i] !== "[" && s[i] !== "{") i++;
  if (i >= s.length) return null;
  const open = s[i];
  const close = open === "[" ? "]" : "}";
  let depth = 0;
  let inStr = false;
  let esc = false;
  const from = i;
  for (; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return { text: s.slice(from, i + 1), end: i + 1 };
    }
  }
  return null;
}

/**
 * Find the wrb.fr frame for `rpcid` and JSON.parse its inner payload string.
 * Throws AuthExpiredError on a login page, ContractBrokenError otherwise.
 */
export function extractRpcPayload(
  body: string,
  rpcid: string,
  action: string,
  bl: string | null,
): unknown {
  if (looksLikeLoginHtml(body)) {
    throw new AuthExpiredError();
  }
  const stripped = stripXssiPrefix(body);
  const chunks = splitChunks(stripped);
  if (chunks.length === 0) {
    throw new ContractBrokenError(
      action,
      rpcid,
      bl,
      `response had no decodable chunks (first 120 chars: ${JSON.stringify(body.slice(0, 120))})`,
    );
  }

  for (const chunk of chunks) {
    let frames: unknown;
    try {
      frames = JSON.parse(chunk);
    } catch {
      continue;
    }
    if (!Array.isArray(frames)) continue;
    for (const frame of frames) {
      if (
        Array.isArray(frame) &&
        frame[0] === "wrb.fr" &&
        frame[1] === rpcid
      ) {
        const inner = frame[2];
        if (inner == null) {
          // A null payload with no error frame usually means "accepted, empty".
          return null;
        }
        if (typeof inner !== "string") return inner;
        try {
          return JSON.parse(inner);
        } catch (e) {
          throw new ContractBrokenError(
            action,
            rpcid,
            bl,
            `wrb.fr payload was not valid JSON (${(e as Error).message})`,
          );
        }
      }
    }
  }

  // No frame for our rpcid. If there's an `er`/error frame, surface it.
  throw new ContractBrokenError(
    action,
    rpcid,
    bl,
    `no wrb.fr frame for rpcid ${rpcid} in ${chunks.length} chunk(s)`,
  );
}
