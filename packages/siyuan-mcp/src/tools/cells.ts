import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SiyuanClient } from "../siyuan-client.js";
import { buildRdmWsUrl, RdmWsClient, type CellOutcome, type WebSocketFactory } from "../rdm-ws-client.js";
import { textResult } from "./response.js";

/**
 * A handful of knobs the cell tools expose so the same code can drive live
 * SiYuan traffic (default) and the in-process mock WS server in tests.
 */
export interface CellToolOptions {
  /** Override the `ws.WebSocket` ctor. Test-only. */
  wsFactory?: WebSocketFactory;
  /** Override the `buildRdmWsUrl` output. Test-only. */
  wsUrlFactory?: (siyuanBaseUrl: string, apiKey: string, docID: string) => string;
  /** Max time to wait for a `CellResult`/`CellError`. Default 120s. */
  runTimeoutMs?: number;
}

export const CELL_LANGUAGES = ["python", "r", "api", "mcp", "ai"] as const;
export type CellLanguage = (typeof CELL_LANGUAGES)[number];

function describeOutcome(o: CellOutcome): Record<string, unknown> {
  if (o.ok) {
    return {
      ok: true,
      cellId: o.cellId,
      durationMs: o.durationMs,
      defines: o.defines,
      stdout: o.stdout,
      stderr: o.stderr,
      display: o.display.map((d) => ({
        mime_type: d.mime_type,
        // Always include mime type, but cap the preview of data to 2KB so a
        // large inline PNG doesn't blow the response budget. Callers who want
        // the full blob should use `siyuan_read_cell_output`.
        data: d.data.length > 2048 ? d.data.slice(0, 2048) + "... [truncated]" : d.data,
        dataSizeBytes: d.data.length,
      })),
    };
  }
  return {
    ok: false,
    cellId: o.cellId,
    errorKind: o.kind,
    errorMessage: o.message,
    traceback: o.traceback,
    line: o.line,
    stdout: o.stdout,
    stderr: o.stderr,
  };
}

export function registerCellTools(
  server: McpServer,
  client: SiyuanClient,
  opts: CellToolOptions = {},
): void {
  const runTimeoutMs = opts.runTimeoutMs ?? 120_000;

  async function openWsForDoc(docID: string): Promise<RdmWsClient> {
    const apiKey = await client.getApiKey();
    const url = (opts.wsUrlFactory ?? buildRdmWsUrl)(client.getBaseUrl(), apiKey, docID);
    const ws = new RdmWsClient({ wsUrl: url, wsFactory: opts.wsFactory });
    await ws.openNotebook(docID);
    return ws;
  }

  server.tool(
    "siyuan_create_cell",
    "Append a new RDM cell to a SiYuan document over WebSocket. Returns the server-minted cell_id. Supported languages: python, r, api, mcp (KnowledgeFlow), ai.",
    {
      doc_id: z.string().describe("Document ID (the SiYuan block root) that hosts the RDM notebook."),
      language: z
        .enum(CELL_LANGUAGES)
        .describe("Cell language. 'mcp' = KnowledgeFlow data cell; 'ai' = AI-assistance cell."),
      code: z.string().describe("Cell body (source code, markdown template, or provider config)."),
      after: z
        .string()
        .nullable()
        .optional()
        .describe("Cell ID to insert after, or null to append at the end of the notebook."),
    },
    async ({ doc_id, language, code, after }) => {
      const ws = await openWsForDoc(doc_id);
      try {
        const cell = await ws.addCell(language, code, after ?? null);
        return textResult({
          docId: doc_id,
          cellId: cell.id,
          language: cell.language,
          imports: cell.imports,
          exports: cell.exports,
        });
      } finally {
        ws.close();
      }
    },
  );

  server.tool(
    "siyuan_run_rdm_cell",
    "Execute an existing RDM cell inside a SiYuan document. Opens a WS session, sends RunCell, and awaits the terminal CellResult or CellError. Works for python / r / api / mcp / ai cells.",
    {
      doc_id: z.string().describe("Document ID hosting the notebook."),
      cell_id: z.string().describe("Target cell ID (returned by siyuan_create_cell)."),
      timeout_ms: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Max time to wait for terminal result. Defaults to 120000 ms."),
    },
    async ({ doc_id, cell_id, timeout_ms }) => {
      const ws = await openWsForDoc(doc_id);
      try {
        ws.runCell(cell_id);
        const outcome = await ws.awaitResult(cell_id, timeout_ms ?? runTimeoutMs);
        return textResult(describeOutcome(outcome));
      } finally {
        ws.close();
      }
    },
  );

  server.tool(
    "siyuan_read_cell_output",
    "Fetch the latest cached snapshot for an RDM cell via the HTTP proxy. Returns the full display payload (no 2KB cap). Use after siyuan_run_rdm_cell when you need the raw outputs (e.g. base64-encoded PNGs).",
    {
      doc_id: z.string().describe("Document ID hosting the notebook."),
      cell_id: z.string().describe("Target cell ID."),
    },
    async ({ doc_id, cell_id }) => {
      const data = await client.get<unknown>(
        `/api/rdm/http/api/notebooks/${encodeURIComponent(doc_id)}/cells/${encodeURIComponent(cell_id)}/output`,
      );
      return textResult({ cellId: cell_id, docId: doc_id, output: data });
    },
  );
}

export const CELL_TOOL_NAMES = [
  "siyuan_create_cell",
  "siyuan_run_rdm_cell",
  "siyuan_read_cell_output",
] as const;
