import { EventEmitter } from "node:events";
import WebSocket from "ws";

/**
 * Minimal ClientMessage / ServerMessage typings. We model only the subset the
 * MCP server actually sends or consumes — everything else is either dropped
 * (incoming) or un-implemented (outgoing). The full protocol lives in
 * `rickydata_markdown/app/src/types.ts`.
 */

export interface CellInfo {
  id: string;
  language: string;
  code: string;
  options: Record<string, unknown>;
  imports: string[];
  exports: string[];
}

export interface DisplayOutput {
  mime_type: string;
  data: string;
}

export type ClientMessage =
  | { type: "OpenNotebook"; path: string | null }
  | { type: "AddCell"; language: string; code: string; after: string | null }
  | { type: "RunCell"; cell_id: string }
  | { type: "Ping" };

export type ServerMessage =
  | { type: "NotebookLoaded"; cells: CellInfo[]; title: string | null }
  | { type: "CellAdded"; cell: CellInfo }
  | { type: "CellUpdated"; cell: CellInfo }
  | { type: "CellRunning"; cell_id: string }
  | { type: "CellStdout"; cell_id: string; data: string }
  | { type: "CellStderr"; cell_id: string; data: string }
  | {
      type: "CellResult";
      cell_id: string;
      display: DisplayOutput[];
      stdout: string;
      stderr: string;
      defines: string[];
      duration_ms: number;
    }
  | {
      type: "CellError";
      cell_id: string;
      message: string;
      traceback: string | null;
      line: number | null;
      kind: string;
      upstream_cell_id?: string | null;
      upstream_cell_name?: string | null;
      upstream_language?: string | null;
    }
  | { type: "Error"; message: string }
  | { type: "Pong" }
  // Ignored — we only keep the types we act on; everything else is dropped
  // by the client at parse time, so we don't need to enumerate the full set.
  | { type: string; [k: string]: unknown };

export interface CellResult {
  cellId: string;
  ok: true;
  display: DisplayOutput[];
  stdout: string;
  stderr: string;
  defines: string[];
  durationMs: number;
}

export interface CellFailure {
  cellId: string;
  ok: false;
  message: string;
  traceback: string | null;
  line: number | null;
  kind: string;
  stdout: string;
  stderr: string;
}

export type CellOutcome = CellResult | CellFailure;

export interface WebSocketFactoryOptions {
  headers?: Record<string, string>;
}

/**
 * Factory alias for constructors compatible with the `ws` package's
 * `WebSocket` class. The real runtime passes `new WebSocket(url, opts)`;
 * tests pass an in-process mock server's client constructor.
 */
export type WebSocketFactory = (
  url: string,
  opts?: WebSocketFactoryOptions,
) => WebSocket;

export interface RdmWsClientOptions {
  /** Full WS URL, including `kfdb_token` query param. */
  wsUrl: string;
  /** Replace the `ws` constructor (for tests). */
  wsFactory?: WebSocketFactory;
  /** How long to wait for the WS to connect. Default 10s. */
  connectTimeoutMs?: number;
  /** How long to wait for NotebookLoaded after OpenNotebook. Default 15s. */
  openTimeoutMs?: number;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_OPEN_TIMEOUT_MS = 15_000;
const DEFAULT_AWAIT_TIMEOUT_MS = 60_000;

/**
 * Thin wrapper over `ws.WebSocket` that exposes the three operations the MCP
 * cell tools need. Every call is a one-shot Promise — callers are expected to
 * `await` in sequence, matching the request/response pairing of the embed UI.
 *
 * The client is single-use: after `close()` it cannot be reopened.
 */
export class RdmWsClient extends EventEmitter {
  private readonly opts: Required<RdmWsClientOptions>;
  private ws: WebSocket | null = null;
  private openedNotebook: string | null = null;
  private closed = false;

  constructor(opts: RdmWsClientOptions) {
    super();
    this.opts = {
      wsUrl: opts.wsUrl,
      wsFactory:
        opts.wsFactory ??
        ((url, wsOpts) => new WebSocket(url, wsOpts as WebSocket.ClientOptions)),
      connectTimeoutMs: opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      openTimeoutMs: opts.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS,
    };
  }

  /** Connect, then send OpenNotebook(docID) and wait for NotebookLoaded. */
  async openNotebook(docID: string): Promise<CellInfo[]> {
    if (this.ws) throw new Error("RdmWsClient: already connected");
    await this.connect();
    const loaded = await this.waitFor<{ type: "NotebookLoaded"; cells: CellInfo[] }>(
      "NotebookLoaded",
      this.opts.openTimeoutMs,
      () => this.send({ type: "OpenNotebook", path: docID }),
    );
    this.openedNotebook = docID;
    return loaded.cells;
  }

  /**
   * Append a cell to the currently-open notebook. Returns the newly-created
   * cell's full CellInfo (including its server-minted ID).
   */
  async addCell(language: string, code: string, after: string | null = null): Promise<CellInfo> {
    this.requireOpen();
    const added = await this.waitFor<{ type: "CellAdded"; cell: CellInfo }>(
      "CellAdded",
      this.opts.openTimeoutMs,
      () => this.send({ type: "AddCell", language, code, after }),
    );
    return added.cell;
  }

  /**
   * Send RunCell(cellId) and resolve when either a `CellResult` or `CellError`
   * arrives for that cell. Intermediate `CellStdout`/`CellStderr` frames are
   * accumulated and returned alongside the terminal outcome.
   */
  runCell(cellId: string): void {
    this.requireOpen();
    this.send({ type: "RunCell", cell_id: cellId });
  }

  async awaitResult(cellId: string, timeoutMs = DEFAULT_AWAIT_TIMEOUT_MS): Promise<CellOutcome> {
    this.requireOpen();

    let stdout = "";
    let stderr = "";

    return new Promise<CellOutcome>((resolve, reject) => {
      const ws = this.ws!;
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`awaitResult(${cellId}) timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const onMessage = (raw: WebSocket.RawData) => {
        let msg: ServerMessage;
        try {
          msg = JSON.parse(raw.toString()) as ServerMessage;
        } catch {
          return;
        }
        // Only act on messages addressed to this cell.
        if ("cell_id" in msg && msg.cell_id !== cellId) return;

        switch (msg.type) {
          case "CellStdout":
            stdout += (msg as { data: string }).data;
            break;
          case "CellStderr":
            stderr += (msg as { data: string }).data;
            break;
          case "CellResult": {
            const m = msg as Extract<ServerMessage, { type: "CellResult" }>;
            cleanup();
            resolve({
              cellId,
              ok: true,
              display: m.display,
              stdout: m.stdout || stdout,
              stderr: m.stderr || stderr,
              defines: m.defines,
              durationMs: m.duration_ms,
            });
            break;
          }
          case "CellError": {
            const m = msg as Extract<ServerMessage, { type: "CellError" }>;
            cleanup();
            resolve({
              cellId,
              ok: false,
              message: m.message,
              traceback: m.traceback,
              line: m.line,
              kind: m.kind,
              stdout,
              stderr,
            });
            break;
          }
          default:
            break;
        }
      };

      const onClose = () => {
        cleanup();
        reject(new Error(`WebSocket closed before cell ${cellId} finished`));
      };
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };

      const cleanup = () => {
        clearTimeout(timer);
        ws.off("message", onMessage);
        ws.off("close", onClose);
        ws.off("error", onError);
      };

      ws.on("message", onMessage);
      ws.once("close", onClose);
      ws.once("error", onError);
    });
  }

  close(): void {
    this.closed = true;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }

  // ── internals ─────────────────────────────────────────────────────────

  private connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = this.opts.wsFactory(this.opts.wsUrl);
      this.ws = ws;

      const timer = setTimeout(() => {
        cleanup();
        try {
          ws.close();
        } catch {
          // ignore
        }
        reject(new Error(`RdmWsClient: connect timed out after ${this.opts.connectTimeoutMs}ms`));
      }, this.opts.connectTimeoutMs);

      const cleanup = () => {
        clearTimeout(timer);
        ws.off("open", onOpen);
        ws.off("error", onError);
      };

      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };

      ws.once("open", onOpen);
      ws.once("error", onError);
    });
  }

  /**
   * Send a payload, start listening, fire the optional `trigger` AFTER the
   * listener is wired, and resolve on the next message of the given type.
   * Avoids the lost-wakeup race where the server responds faster than we can
   * attach the listener.
   */
  private waitFor<T extends { type: string }>(
    type: T["type"],
    timeoutMs: number,
    trigger: () => void,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const ws = this.ws!;
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`RdmWsClient: timed out waiting for ${type} after ${timeoutMs}ms`));
      }, timeoutMs);

      const onMessage = (raw: WebSocket.RawData) => {
        let msg: ServerMessage;
        try {
          msg = JSON.parse(raw.toString()) as ServerMessage;
        } catch {
          return;
        }
        if (msg.type === type) {
          cleanup();
          resolve(msg as unknown as T);
        } else if (msg.type === "Error") {
          cleanup();
          reject(new Error(`RDM server error while waiting for ${type}: ${(msg as { message?: string }).message ?? "unknown"}`));
        }
      };
      const onClose = () => {
        cleanup();
        reject(new Error(`RdmWsClient: socket closed while waiting for ${type}`));
      };
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };

      const cleanup = () => {
        clearTimeout(timer);
        ws.off("message", onMessage);
        ws.off("close", onClose);
        ws.off("error", onError);
      };

      ws.on("message", onMessage);
      ws.once("close", onClose);
      ws.once("error", onError);

      try {
        trigger();
      } catch (err) {
        cleanup();
        reject(err as Error);
      }
    });
  }

  private requireOpen(): void {
    if (!this.ws) throw new Error("RdmWsClient: not connected — call openNotebook() first");
    if (this.closed) throw new Error("RdmWsClient: client is closed");
    if (!this.openedNotebook) throw new Error("RdmWsClient: openNotebook() must be called first");
  }

  private send(msg: ClientMessage): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error("RdmWsClient: socket is not open");
    }
    ws.send(JSON.stringify(msg));
  }
}

/**
 * Helper to build the WS URL SiYuan exposes for RDM. SiYuan's
 * `/api/rdm/ws` endpoint strips the prefix and forwards to the sidecar's
 * `/ws` — so from the MCP's perspective there is exactly one URL:
 *
 *   wss://<siyuan-host>/api/rdm/ws?kfdb_token=<key>[&notebook=<docID>]
 *
 * The `notebook` query param is informational — the actual notebook is
 * selected via the first `OpenNotebook` message. We still include it when
 * known so server-side logs and multi-client tests can group sessions by
 * doc.
 */
export function buildRdmWsUrl(siyuanBaseUrl: string, apiKey: string, docID?: string): string {
  const base = siyuanBaseUrl.replace(/\/+$/, "");
  const wsBase = base.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
  const url = new URL(`${wsBase}/api/rdm/ws`);
  url.searchParams.set("kfdb_token", apiKey);
  if (docID) url.searchParams.set("notebook", docID);
  return url.toString();
}
