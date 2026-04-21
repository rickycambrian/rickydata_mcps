import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SiyuanClient } from "../siyuan-client.js";
import { buildRdmWsUrl, RdmWsClient, type CellOutcome, type WebSocketFactory } from "../rdm-ws-client.js";
import { textResult } from "./response.js";

/**
 * Build the markdown fence text for an RDM cell, matching the format that
 * `buildImportMarkdown` in `kernel/api/rdm.go:368` emits and that
 * `app/src/protyle/ui/rdmCell.ts` renders.
 *
 * Fence info-string format (per rdm-engine convention):
 *   ```rdm-<lang>           (no options)
 *   ```rdm-<lang> {"k":"v"} (with options — JSON must be non-empty object)
 *
 * Strategy note: we always use /api/block/appendBlock (never /api/rdm/import)
 * because /api/rdm/import requires a Privy-wallet session that the
 * ?kfdb_token= iframe-auth bypass does not provide (see rdm-import-endpoint
 * skill, "Known 401 failure modes"). The fence info-string path works for all
 * cell languages; rdm-engine and the protyle renderer both tolerate options
 * supplied as a JSON object in the info-string.
 */
function buildCellFence(
  language: string,
  code: string,
  options?: Record<string, unknown> | null,
): string {
  const optStr =
    options && Object.keys(options).length > 0 ? " " + JSON.stringify(options) : "";
  // Trailing newline after the closing fence is required by SiYuan's markdown
  // parser to correctly terminate the code block.
  return `\`\`\`rdm-${language}${optStr}\n${code}\n\`\`\`\n`;
}

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

export const CELL_LANGUAGES = ["python", "r", "ggsql", "ggkql", "api", "mcp", "ai"] as const;
export type CellLanguage = (typeof CELL_LANGUAGES)[number];

/**
 * Shape a CellOutcome for MCP output. `mode: "capped"` truncates each display
 * payload to 2KB so a 1-MB inline PNG doesn't blow the caller's response
 * budget; `mode: "raw"` returns the full base64 blob for callers that
 * explicitly asked for it (e.g. `siyuan_read_cell_output`).
 */
function describeOutcome(
  o: CellOutcome,
  mode: "capped" | "raw" = "capped",
): Record<string, unknown> {
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
        data:
          mode === "raw" || d.data.length <= 2048
            ? d.data
            : d.data.slice(0, 2048) + "... [truncated]",
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
    "Append a new RDM cell to a SiYuan document over WebSocket. Returns the server-minted cell_id. Supported languages: python, r, ggsql, ggkql, api, mcp (KnowledgeFlow), ai. Pass `options` to set cell-type-specific fields rdm-engine's compilers require: e.g. ggsql/ggkql cells use the engine's canonical SQL/KQL shapes, mcp cells need `{server, tool, source, data, mode, columns, timeoutMs}`, ai cells need `{model, ...}`, and api cells need provider-specific keys. rdm-engine validates the shape — the MCP forwards verbatim.",
    {
      doc_id: z.string().describe("Document ID (the SiYuan block root) that hosts the RDM notebook."),
      language: z
        .enum(CELL_LANGUAGES)
        .describe(
          "Cell language. 'ggsql' = canonical SQL cell; 'ggkql' = canonical KQL cell; 'mcp' = KnowledgeFlow data cell; 'ai' = AI-assistance cell.",
        ),
      code: z.string().describe("Cell body (source code, markdown template, or provider config)."),
      after: z
        .string()
        .nullable()
        .optional()
        .describe("Cell ID to insert after, or null to append at the end of the notebook."),
      options: z
        .record(z.unknown())
        .optional()
        .describe(
          "Free-form cell options forwarded to rdm-engine as `AddCell.options`. Required for mcp/ai/api cells; optional for python/r (which ignore unknown keys). See rdm-engine's compile_* functions for the authoritative schema per language.",
        ),
    },
    async ({ doc_id, language, code, after, options }) => {
      const ws = await openWsForDoc(doc_id);
      let cell: Awaited<ReturnType<RdmWsClient["addCell"]>>;
      try {
        cell = await ws.addCell(
          language,
          code,
          after ?? null,
          options as Record<string, unknown> | undefined,
        );
      } finally {
        ws.close();
      }

      // Persist the cell as a real SiYuan block via /api/block/appendBlock so
      // it survives after the ephemeral WS session closes. Without this step
      // the cell only exists in the rdm-engine sidecar's in-memory notebook
      // and the doc's block_count never increases (FU-3 bug).
      //
      // We use appendBlock (not /api/rdm/import) because /api/rdm/import
      // requires a Privy-wallet session that the ?kfdb_token= iframe-auth
      // bypass does not provide — see rdm-import-endpoint skill §"Known 401
      // failure modes". The fence info-string options path works for all
      // languages; rdm-engine and the protyle renderer tolerate options as
      // inline JSON in the info-string.
      const fence = buildCellFence(language, code, options as Record<string, unknown> | undefined);
      await client.post<unknown>("/api/block/appendBlock", {
        dataType: "markdown",
        data: fence,
        parentID: doc_id,
      });

      return textResult({
        docId: doc_id,
        cellId: cell.id,
        language: cell.language,
        imports: cell.imports,
        exports: cell.exports,
        persisted: true,
      });
    },
  );

  server.tool(
    "siyuan_run_rdm_cell",
    "Execute an existing RDM cell inside a SiYuan document. Opens a WS session, sends RunCell, and awaits the terminal CellResult or CellError. Works for python / r / ggsql / ggkql / api / mcp / ai cells.",
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
    "Re-execute an existing RDM cell and return its FULL display payload (no 2KB cap). Use this after `siyuan_run_rdm_cell` when you need raw outputs — e.g. the complete base64 blob of a matplotlib PNG. Note: the RDM sidecar does not expose a cached-snapshot HTTP endpoint, so this tool opens a WS session, runs the cell, and waits for the terminal CellResult/CellError. For deterministic cells the output is identical to the previous run. Works for python / r / ggsql / ggkql / api / mcp / ai cells.",
    {
      doc_id: z.string().describe("Document ID hosting the notebook."),
      cell_id: z.string().describe("Target cell ID."),
      timeout_ms: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Max time to wait for the re-run to complete. Defaults to 120000 ms."),
    },
    async ({ doc_id, cell_id, timeout_ms }) => {
      const ws = await openWsForDoc(doc_id);
      try {
        ws.runCell(cell_id);
        const outcome = await ws.awaitResult(cell_id, timeout_ms ?? runTimeoutMs);
        // "raw" mode: emit the full display.data base64 without truncation so
        // callers can reconstruct large binary outputs.
        return textResult({
          docId: doc_id,
          ...describeOutcome(outcome, "raw"),
        });
      } finally {
        ws.close();
      }
    },
  );
}

export const CELL_TOOL_NAMES = [
  "siyuan_create_cell",
  "siyuan_run_rdm_cell",
  "siyuan_read_cell_output",
] as const;
