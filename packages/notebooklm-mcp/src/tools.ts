// ============================================================================
// TOOL DEFINITIONS + HANDLERS — notebooklm-mcp
// ============================================================================
//
// Uncaptured actions (rpcid not yet captured) are OMITTED from tools/list so an
// agent is never offered a tool that can only error. `download_audio` ships
// first; the rest light up as their rpcids are captured (see rpc.ts).

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { BatchExecuteClient } from "./notebooklm/client.js";
import { isCaptured, capturedActions, RPC_REGISTRY } from "./notebooklm/rpc.js";
import { loadCookieJar, hasExpiredCriticalCookie, bootstrapTokens } from "./notebooklm/auth.js";
import {
  NotConnectedError,
  AuthExpiredError,
  DailyLimitError,
  NotebookLMError,
} from "./notebooklm/errors.js";
import {
  CONTRACT_VERSION,
  CAPTURED_BL,
  DAILY_LIMIT,
  MAX_INLINE_BYTES,
} from "./config.js";

// ---------------------------------------------------------------------------
// Tool definitions (full set; tools/list filters to captured actions)
// ---------------------------------------------------------------------------

const ALL_TOOL_DEFS: Tool[] = [
  {
    name: "create_notebook",
    description:
      "Create a new NotebookLM notebook and return its id. Use this before adding sources.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Notebook title." },
      },
      required: ["title"],
    },
  },
  {
    name: "add_source",
    description:
      "Add a source to a notebook. `type=text` pastes raw text; `type=url` ingests a web page. Add sources before generating audio.",
    inputSchema: {
      type: "object",
      properties: {
        notebook_id: { type: "string", description: "Target notebook id." },
        type: { type: "string", enum: ["text", "url"], description: "Source kind." },
        content: {
          type: "string",
          description: "The pasted text (type=text) or the URL to ingest (type=url).",
        },
        title: { type: "string", description: "Optional source title (type=text)." },
      },
      required: ["notebook_id", "type", "content"],
    },
  },
  {
    name: "generate_audio",
    description:
      "Start generating an Audio Overview (the NotebookLM podcast) for a notebook from the given sources. Returns immediately; poll get_audio_status until ready, then download_audio. Subject to a per-day generation ceiling.",
    inputSchema: {
      type: "object",
      properties: {
        notebook_id: { type: "string", description: "Notebook to generate audio for." },
        source_ids: {
          type: "array",
          items: { type: "string" },
          description: "Source ids to base the audio on (from add_source results).",
        },
        instructions: {
          type: "string",
          description: "Optional focus/steering instructions for the hosts.",
        },
      },
      required: ["notebook_id", "source_ids"],
    },
  },
  {
    name: "get_audio_status",
    description:
      "Check whether a notebook's Audio Overview is still generating or ready. Poll this after generate_audio (no server-side long-poll).",
    inputSchema: {
      type: "object",
      properties: {
        notebook_id: { type: "string", description: "Notebook id." },
      },
      required: ["notebook_id"],
    },
  },
  {
    name: "download_audio",
    description:
      "Authorize download of a generated Audio Overview by its artifact id (from get_audio_status / generate_audio). " +
      "Returns the authorization result; if NotebookLM returns a signed media URL inline it is surfaced, and with `inline=true` (under the size cap) the audio is also returned as base64.",
    inputSchema: {
      type: "object",
      properties: {
        notebook_id: { type: "string", description: "Notebook id (for the request source-path)." },
        artifact_id: {
          type: "string",
          description: "The audio artifact id to download (from get_audio_status / generate_audio).",
        },
        inline: {
          type: "boolean",
          description: "If a media URL is returned, also fetch the audio bytes as base64 (when under the size cap).",
        },
      },
      required: ["notebook_id", "artifact_id"],
    },
  },
  {
    name: "ask_question",
    description:
      "Ask a question grounded in a notebook's sources (NotebookLM chat). Returns the answer text.",
    inputSchema: {
      type: "object",
      properties: {
        notebook_id: { type: "string", description: "Notebook id." },
        question: { type: "string", description: "The question to ask." },
      },
      required: ["notebook_id", "question"],
    },
  },
  {
    name: "list_notebooks",
    description: "List the notebooks in the connected Google account.",
    inputSchema: { type: "object", properties: {} },
  },
];

/** The tools to expose: only those whose rpcid has been captured + verified. */
export function buildToolList(): Tool[] {
  return ALL_TOOL_DEFS.filter((t) => isCaptured(t.name));
}

// ---------------------------------------------------------------------------
// Per-process daily generation counter (account-flag guard)
// ---------------------------------------------------------------------------

let genDay = "";
let genCount = 0;

function dayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function checkAndCountGeneration(): void {
  const today = dayKey();
  if (today !== genDay) {
    genDay = today;
    genCount = 0;
  }
  if (genCount >= DAILY_LIMIT) throw new DailyLimitError(DAILY_LIMIT);
  genCount += 1;
}

// ---------------------------------------------------------------------------
// Lazy client (tools/list never needs a session; only CALLS do)
// ---------------------------------------------------------------------------

let _client: BatchExecuteClient | null = null;

function getClient(): BatchExecuteClient {
  if (!_client) _client = new BatchExecuteClient();
  return _client;
}

function sourcePathFor(args: Record<string, unknown>): string | undefined {
  const id = args.notebook_id;
  return typeof id === "string" && id ? `/notebook/${id}` : undefined;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleDownloadAudio(args: Record<string, unknown>): Promise<unknown> {
  const client = getClient();
  const result = (await client.callAction("download_audio", args, {
    sourcePath: sourcePathFor(args),
  })) as { authorized: boolean; url: string | null; note?: string };

  const out: Record<string, unknown> = {
    notebook_id: args.notebook_id,
    artifact_id: args.artifact_id,
    authorized: result.authorized,
    url: result.url,
    bl: client.bl,
  };
  if (!result.url) {
    out.note =
      result.note ??
      "Download authorized but no inline media URL was returned (HpN0Ub returns an empty frame). The audio is delivered via a browser download navigation — capture the signed URL with the Playwright download event (capture.ts).";
    return out;
  }
  if (args.inline === true) {
    // The signed URL is pre-authenticated (googleusercontent/blobstore), so a
    // plain fetch suffices — no session headers required.
    const r = await fetch(result.url);
    const len = Number(r.headers.get("content-length") || "0");
    if (r.ok && (len === 0 || len <= MAX_INLINE_BYTES)) {
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.byteLength <= MAX_INLINE_BYTES) {
        out.content_type = r.headers.get("content-type") || "audio/mpeg";
        out.bytes = buf.byteLength;
        out.base64 = buf.toString("base64");
      } else {
        out.note = `Audio is ${buf.byteLength} bytes (> cap ${MAX_INLINE_BYTES}); returning URL only.`;
      }
    } else {
      out.note = `Audio is ${len} bytes (> cap ${MAX_INLINE_BYTES}) or unreachable; returning URL only.`;
    }
  }
  return out;
}

async function handleGeneric(action: string, args: Record<string, unknown>): Promise<unknown> {
  if (action === "generate_audio") checkAndCountGeneration();
  const client = getClient();
  return client.callAction(action, args, { sourcePath: sourcePathFor(args) });
}

export async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  // Hard gate: only captured actions may execute, even if a client asks for one
  // filtered out of tools/list.
  if (!isCaptured(name)) {
    const spec = RPC_REGISTRY[name];
    return {
      success: false,
      error: spec
        ? `tool "${name}" is not available yet (rpcid not captured). ${spec.note ?? ""}`.trim()
        : `Unknown tool: ${name}`,
    };
  }

  try {
    let result: unknown;
    if (name === "download_audio") result = await handleDownloadAudio(args);
    else result = await handleGeneric(name, args);
    return result;
  } catch (err) {
    if (err instanceof NotebookLMError) {
      return {
        success: false,
        error: err.message,
        error_type: err.name,
      };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Health / auth status (for /health and the connect helper)
// ---------------------------------------------------------------------------

export interface HealthInfo {
  auth: "authenticated" | "expired" | "not_connected";
  contract_version: string;
  captured_bl: string;
  live_bl: string | null;
  tools: string[];
  daily_used: number;
  daily_limit: number;
}

/**
 * Report auth + contract state. By default this is a cheap LOCAL check (cookies
 * present + not locally expired). With `probe=true` it makes ONE authenticated
 * request to confirm the session is live server-side (cookies can look valid
 * locally while Google has revoked them) and reports the live `bl`.
 */
export async function getHealthInfo(probe = false): Promise<HealthInfo> {
  const base: HealthInfo = {
    auth: "not_connected",
    contract_version: CONTRACT_VERSION,
    captured_bl: CAPTURED_BL,
    live_bl: null,
    tools: capturedActions(),
    daily_used: genDay === dayKey() ? genCount : 0,
    daily_limit: DAILY_LIMIT,
  };

  let jar;
  try {
    jar = loadCookieJar();
  } catch (e) {
    if (e instanceof NotConnectedError) return base;
    throw e;
  }

  if (hasExpiredCriticalCookie(jar)) {
    return { ...base, auth: "expired" };
  }
  if (!probe) {
    return { ...base, auth: "authenticated" };
  }

  // Live probe: a revoked-but-locally-valid session only fails on a real call.
  try {
    const tokens = await bootstrapTokens(jar);
    return { ...base, auth: "authenticated", live_bl: tokens.bl };
  } catch (e) {
    if (e instanceof AuthExpiredError) return { ...base, auth: "expired" };
    throw e;
  }
}
