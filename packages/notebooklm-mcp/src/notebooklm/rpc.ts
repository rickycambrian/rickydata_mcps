// ============================================================================
// RPC REGISTRY — the versioned single source of truth for NotebookLM rpcids
// ============================================================================
//
// Each NotebookLM action maps to one batchexecute rpcid plus an `encode` (typed
// args → the inner f.req payload array) and a `decode` (parsed wrb.fr payload →
// typed result). This is the ONLY place rpcids and payload shapes live.
//
// CAPTURE STATUS
//   - "verified": rpcid + payload shape confirmed from a live network capture
//     (see fixtures/<rpcid>.{request,response}.txt).
//   - "todo_capture": rpcid not yet fully captured (null). OMITTED from
//     tools/list (see tools.ts isCaptured) so the server is always shippable.
//
// All rpcids/payloads below for the verified set were captured live on
// bl=boq_labs-tailwind-frontend_20260609.22_p0 (2026-06-15).
//
// To (re)capture: `npm run capture -- --action=<name>`, update the rpcid +
// fixture here, flip status, add a codec round-trip test.

import { NotCapturedError, NotebookLMError } from "./errors.js";

export type CaptureStatus = "verified" | "todo_capture";

export interface RpcSpec {
  action: string;
  /** The batchexecute rpcid, or null when not yet captured. */
  rpcid: string | null;
  status: CaptureStatus;
  /** Human note on what still needs capturing / how the payload was derived. */
  note?: string;
  /** Build the inner payload array that becomes f.req[0][0][1] (JSON-stringified). */
  encode: (args: Record<string, unknown>) => unknown[];
  /** Turn the decoded wrb.fr payload into a typed, agent-friendly result. */
  decode: (data: unknown) => unknown;
}

// ---------------------------------------------------------------------------
// Captured constants (the request "preamble" NotebookLM prepends)
// ---------------------------------------------------------------------------

// Read/generate calls carry a context preamble with a trailing field-mask.
const PREAMBLE_MASK = [2, null, null, [1, null, null, null, null, null, null, null, null, null, [1]], [[1, 4, 8, 2, 3, 6]]];
// add_source uses the same preamble WITHOUT the field-mask tail.
const PREAMBLE = [2, null, null, [1, null, null, null, null, null, null, null, null, null, [1]]];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Recursively collect every string in a decoded payload (depth-first). */
function* allStrings(node: unknown): Generator<string> {
  if (typeof node === "string") yield node;
  else if (Array.isArray(node)) for (const v of node) yield* allStrings(v);
  else if (node && typeof node === "object") for (const v of Object.values(node)) yield* allStrings(v);
}

/** Find the first audio download URL in a decoded payload. */
export function findAudioUrl(data: unknown): string | null {
  for (const s of allStrings(data)) {
    if (/^https?:\/\/[^\s"']+/.test(s) && /(\.mp3|\.m4a|audio|googleusercontent|blobstore)/i.test(s)) {
      return s;
    }
  }
  return null;
}

/** First UUID-shaped string anywhere in the payload (artifact/source id). */
function firstId(data: unknown): string | null {
  for (const s of allStrings(data)) {
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return s;
  }
  return null;
}

function asString(v: unknown): string {
  return v == null ? "" : String(v);
}

function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || !v) {
    throw new NotebookLMError(`"${key}" is required and must be a non-empty string.`);
  }
  return v;
}

/** Normalize source ids into the captured [[[id],[id],…]] wrapper. */
function wrapSourceIds(ids: string[]): unknown[] {
  return [ids.map((id) => [id])];
}

const todo = (action: string): RpcSpec["encode"] => () => {
  throw new NotCapturedError(action);
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const RPC_REGISTRY: Record<string, RpcSpec> = {
  // ── add_source (text) — izAoDd ─────────────────────────────────────────────
  add_source: {
    action: "add_source",
    rpcid: "izAoDd",
    status: "verified",
    note: "Text (Pasted Text) flow captured. URL/website flow not yet captured.",
    encode: (args) => {
      const notebookId = requireString(args, "notebook_id");
      const type = asString(args.type) || "text";
      if (type !== "text") {
        throw new NotCapturedError("add_source(url) — only the text/paste flow is captured");
      }
      const content = requireString(args, "content");
      const title = asString(args.title) || "Pasted Text";
      // [[[null,[title, content], null, 2, null×6, 1]], notebookId, PREAMBLE]
      return [
        [[null, [title, content], null, 2, null, null, null, null, null, null, 1]],
        notebookId,
        PREAMBLE,
      ];
    },
    decode: (data) => {
      // [[ [ [sourceId], title, [meta…], [null,2] ] ]]
      const root = Array.isArray(data) ? (data[0] as unknown[]) : null;
      const rec = root && Array.isArray(root[0]) ? (root[0] as unknown[]) : null;
      let sourceId: string | null = null;
      if (rec && Array.isArray(rec[0]) && typeof rec[0][0] === "string") {
        sourceId = rec[0][0];
      } else {
        sourceId = firstId(data); // fallback if the shape shifts
      }
      const title = rec && typeof rec[1] === "string" ? rec[1] : null;
      return { source_id: sourceId, title };
    },
  },

  // ── generate_audio (Audio Overview) — R7cb6c ───────────────────────────────
  generate_audio: {
    action: "generate_audio",
    rpcid: "R7cb6c",
    status: "verified",
    note: "Requires source_ids (from add_source results). type 1 = Audio Overview.",
    encode: (args) => {
      const notebookId = requireString(args, "notebook_id");
      const ids = Array.isArray(args.source_ids)
        ? (args.source_ids as unknown[]).map(String).filter(Boolean)
        : [];
      if (ids.length === 0) {
        throw new NotebookLMError(
          "generate_audio requires source_ids: pass the source ids returned by add_source.",
        );
      }
      const wrapped = wrapSourceIds(ids);
      // [PREAMBLE_MASK, notebookId, [null,null,1, sources, null,null,[null,[null,null,null, sources]]]]
      return [
        PREAMBLE_MASK,
        notebookId,
        [null, null, 1, wrapped, null, null, [null, [null, null, null, wrapped]]],
      ];
    },
    decode: (data) => {
      // ["artifactId", title, type, [[[sourceId]]], statusCode, …]
      const arr = Array.isArray(data) ? data : [];
      return {
        artifact_id: typeof arr[0] === "string" ? arr[0] : firstId(data),
        title: typeof arr[1] === "string" ? arr[1] : null,
        status_code: typeof arr[4] === "number" ? arr[4] : null,
      };
    },
  },

  // ── get_audio_status (list studio artifacts) — gArtLc ──────────────────────
  get_audio_status: {
    action: "get_audio_status",
    rpcid: "gArtLc",
    status: "verified",
    note: "Lists studio artifacts + status. status_code enum not fully mapped; download_audio returning a URL is the definitive ready signal.",
    encode: (args) => {
      const notebookId = requireString(args, "notebook_id");
      return [PREAMBLE_MASK, notebookId, 'NOT artifact.status = "ARTIFACT_STATUS_SUGGESTED"'];
    },
    decode: (data) => {
      // [[ [id,title,type,[[[srcId]]],statusCode,…], … ]]
      const list = Array.isArray(data) && Array.isArray(data[0]) ? (data[0] as unknown[]) : [];
      const artifacts = list
        .filter((r): r is unknown[] => Array.isArray(r))
        .map((r) => ({
          artifact_id: typeof r[0] === "string" ? r[0] : null,
          title: typeof r[1] === "string" ? r[1] : null,
          type: typeof r[2] === "number" ? r[2] : null,
          status_code: typeof r[4] === "number" ? r[4] : null,
        }));
      return { artifacts, count: artifacts.length };
    },
  },

  // ── download_audio — HpN0Ub ────────────────────────────────────────────────
  // CAPTURED LIVE (2026-06-15): HpN0Ub is the download-AUTHORIZE call. Its
  // payload keys on the AUDIO ARTIFACT id (not the notebook id) and its response
  // is an empty frame `[]`. The audio bytes are then delivered by a browser
  // download navigation whose URL is not exposed to page JS — capture it via the
  // Playwright `download` event (capture.ts / `npm run capture -- --action=download_audio`).
  // decode still scans for a URL so that if a future build returns one inline we
  // surface it automatically.
  download_audio: {
    action: "download_audio",
    rpcid: "HpN0Ub",
    status: "verified",
    note: "Authorize-download RPC: encode=[PREAMBLE,null,[artifactId]], response empty. Media URL is captured via the Playwright download event (see README / capture.ts), not this RPC's body.",
    encode: (args) => {
      const artifactId = requireString(args, "artifact_id");
      return [PREAMBLE_MASK, null, [artifactId]];
    },
    decode: (data) => {
      const url = findAudioUrl(data);
      return {
        authorized: true,
        url, // usually null — HpN0Ub returns an empty frame
        note: url
          ? undefined
          : "Download authorized. NotebookLM returns the audio via a browser download navigation, not in this RPC. Use the Playwright download capture (capture.ts) to obtain the signed media URL.",
      };
    },
  },

  // ── TODO_CAPTURE (omitted from tools/list until rpcid is captured) ──────────
  // create_notebook fires on the landing→notebook navigation (full reload),
  // which complicates body capture. list_notebooks rpcid is known (ozz5Z,
  // source-path=/) but its payload was not captured under the XHR hook.
  create_notebook: {
    action: "create_notebook",
    rpcid: null,
    status: "todo_capture",
    note: "Fires during the create→navigate transition; capture its body with --action=create_notebook.",
    encode: todo("create_notebook"),
    decode: (data) => data,
  },
  list_notebooks: {
    action: "list_notebooks",
    rpcid: null,
    status: "todo_capture",
    note: "rpcid observed = ozz5Z (source-path=/); payload not yet captured under the request hook.",
    encode: todo("list_notebooks"),
    decode: (data) => data,
  },
  ask_question: {
    action: "ask_question",
    rpcid: null,
    status: "todo_capture",
    note: "Optional: capture the chat/ask RPC.",
    encode: todo("ask_question"),
    decode: (data) => data,
  },
};

/** Actions whose rpcid is captured + verified (drive tools/list + canary). */
export function capturedActions(): string[] {
  return Object.values(RPC_REGISTRY)
    .filter((s) => s.status === "verified" && s.rpcid)
    .map((s) => s.action);
}

export function getSpec(action: string): RpcSpec | undefined {
  return RPC_REGISTRY[action];
}

export function isCaptured(action: string): boolean {
  const s = RPC_REGISTRY[action];
  return !!s && s.status === "verified" && !!s.rpcid;
}
