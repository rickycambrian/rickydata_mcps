import { describe, it, expect, beforeEach, afterEach } from "vitest";
import nock from "nock";
import { createServer, type Server as HttpServer } from "node:http";
import { AddressInfo } from "node:net";
import { WebSocketServer, WebSocket } from "ws";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SiyuanClient } from "../src/siyuan-client.js";
import { registerCellTools } from "../src/tools/cells.js";

const SIYUAN_BASE = "https://siyuan.test";

interface ToolEntry {
  name: string;
  handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;
}

/**
 * Spin up a mock RDM WS server on an ephemeral port and return both a ready
 * teardown hook and the wsFactory / wsUrlFactory that `registerCellTools`
 * needs in order to dial it.
 */
function startMockRdm(
  script: (socket: WebSocket, msg: Record<string, unknown>) => void,
): Promise<{
  baseUrl: string;
  http: HttpServer;
  close: () => Promise<void>;
}> {
  return new Promise((resolve) => {
    const http = createServer();
    const wss = new WebSocketServer({ server: http });

    wss.on("connection", (socket) => {
      socket.on("message", (raw) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(raw.toString()) as Record<string, unknown>;
        } catch {
          return;
        }
        script(socket, msg);
      });
    });

    http.listen(0, "127.0.0.1", () => {
      const port = (http.address() as AddressInfo).port;
      resolve({
        baseUrl: `ws://127.0.0.1:${port}`,
        http,
        close: () =>
          new Promise<void>((r) => {
            wss.close(() => http.close(() => r()));
          }),
      });
    });
  });
}

function harness(wsUrl: string): { tools: Map<string, ToolEntry>; client: SiyuanClient } {
  const tools = new Map<string, ToolEntry>();
  const fakeServer = {
    tool(
      name: string,
      _desc: string,
      _shape: unknown,
      handler: ToolEntry["handler"],
    ) {
      tools.set(name, { name, handler });
    },
  } as unknown as McpServer;

  const client = new SiyuanClient({ baseUrl: SIYUAN_BASE, apiKey: "sekret" });
  registerCellTools(fakeServer, client, {
    wsUrlFactory: (_base, _apiKey, _docId) => wsUrl,
    runTimeoutMs: 5_000,
  });
  return { tools, client };
}

async function call(tools: Map<string, ToolEntry>, name: string, args: Record<string, unknown>) {
  const entry = tools.get(name);
  if (!entry) throw new Error(`tool not registered: ${name}`);
  const out = await entry.handler(args);
  return JSON.parse(out.content[0].text);
}

function sendServer(ws: WebSocket, msg: unknown): void {
  ws.send(JSON.stringify(msg));
}

let teardown: (() => Promise<void>) | null = null;

beforeEach(() => {
  nock.disableNetConnect();
  nock.enableNetConnect(/127\.0\.0\.1/);
});

afterEach(async () => {
  nock.cleanAll();
  nock.enableNetConnect();
  if (teardown) {
    await teardown();
    teardown = null;
  }
});

describe("siyuan_create_cell", () => {
  it("returns the server-minted cell id for each supported language", async () => {
    for (const language of ["python", "r", "api", "mcp", "ai"] as const) {
      const { baseUrl, close } = await startMockRdm((ws, msg) => {
        if (msg.type === "OpenNotebook") {
          sendServer(ws, { type: "NotebookLoaded", cells: [], title: null });
          return;
        }
        if (msg.type === "AddCell") {
          sendServer(ws, {
            type: "CellAdded",
            cell: {
              id: `cell-${language}`,
              language: msg.language,
              code: msg.code,
              options: {},
              imports: [],
              exports: [],
            },
          });
        }
      });
      teardown = close;

      const wsUrl = `${baseUrl}/api/rdm/ws?kfdb_token=sekret`;
      const { tools } = harness(wsUrl);
      const out = await call(tools, "siyuan_create_cell", {
        doc_id: "doc-1",
        language,
        code: `# ${language} body`,
      });
      expect(out.cellId).toBe(`cell-${language}`);
      expect(out.language).toBe(language);
      await close();
      teardown = null;
    }
  });
});

describe("siyuan_run_rdm_cell", () => {
  it.each(["python", "r", "api", "mcp", "ai"])(
    "drives AddCell → RunCell → CellResult for %s",
    async (language) => {
      const { baseUrl, close } = await startMockRdm((ws, msg) => {
        if (msg.type === "OpenNotebook") {
          sendServer(ws, { type: "NotebookLoaded", cells: [], title: null });
          return;
        }
        if (msg.type === "AddCell") {
          sendServer(ws, {
            type: "CellAdded",
            cell: {
              id: "cell-42",
              language,
              code: msg.code,
              options: {},
              imports: [],
              exports: [],
            },
          });
          return;
        }
        if (msg.type === "RunCell" && msg.cell_id === "cell-42") {
          sendServer(ws, { type: "CellStdout", cell_id: "cell-42", data: `${language} says hi` });
          sendServer(ws, {
            type: "CellResult",
            cell_id: "cell-42",
            display: [{ mime_type: "text/plain", data: "done" }],
            stdout: `${language} says hi`,
            stderr: "",
            defines: [],
            duration_ms: 3,
          });
        }
      });
      teardown = close;

      const wsUrl = `${baseUrl}/api/rdm/ws?kfdb_token=sekret`;
      const { tools } = harness(wsUrl);

      const created = await call(tools, "siyuan_create_cell", {
        doc_id: "d1",
        language,
        code: "body",
      });
      expect(created.cellId).toBe("cell-42");

      const run = await call(tools, "siyuan_run_rdm_cell", {
        doc_id: "d1",
        cell_id: created.cellId,
        timeout_ms: 5_000,
      });
      expect(run.ok).toBe(true);
      expect(run.stdout).toContain(`${language} says hi`);
    },
  );

  it("surfaces CellError as ok:false", async () => {
    const { baseUrl, close } = await startMockRdm((ws, msg) => {
      if (msg.type === "OpenNotebook") {
        sendServer(ws, { type: "NotebookLoaded", cells: [], title: null });
        return;
      }
      if (msg.type === "AddCell") {
        sendServer(ws, {
          type: "CellAdded",
          cell: { id: "c-e", language: "python", code: "", options: {}, imports: [], exports: [] },
        });
        return;
      }
      if (msg.type === "RunCell") {
        sendServer(ws, {
          type: "CellError",
          cell_id: "c-e",
          message: "division by zero",
          traceback: null,
          line: 2,
          kind: "execution",
        });
      }
    });
    teardown = close;
    const wsUrl = `${baseUrl}/api/rdm/ws?kfdb_token=sekret`;
    const { tools } = harness(wsUrl);
    await call(tools, "siyuan_create_cell", { doc_id: "d", language: "python", code: "1/0" });
    const run = await call(tools, "siyuan_run_rdm_cell", { doc_id: "d", cell_id: "c-e" });
    expect(run.ok).toBe(false);
    expect(run.errorMessage).toBe("division by zero");
    expect(run.errorKind).toBe("execution");
  });

  it("caps inline display payloads at 2KB", async () => {
    const giant = "x".repeat(10_000);
    const { baseUrl, close } = await startMockRdm((ws, msg) => {
      if (msg.type === "OpenNotebook") {
        sendServer(ws, { type: "NotebookLoaded", cells: [], title: null });
        return;
      }
      if (msg.type === "AddCell") {
        sendServer(ws, {
          type: "CellAdded",
          cell: { id: "c-big", language: "python", code: "", options: {}, imports: [], exports: [] },
        });
        return;
      }
      if (msg.type === "RunCell") {
        sendServer(ws, {
          type: "CellResult",
          cell_id: "c-big",
          display: [{ mime_type: "image/png", data: giant }],
          stdout: "",
          stderr: "",
          defines: [],
          duration_ms: 1,
        });
      }
    });
    teardown = close;
    const wsUrl = `${baseUrl}/api/rdm/ws?kfdb_token=sekret`;
    const { tools } = harness(wsUrl);
    await call(tools, "siyuan_create_cell", { doc_id: "d", language: "python", code: "" });
    const run = await call(tools, "siyuan_run_rdm_cell", { doc_id: "d", cell_id: "c-big" });
    expect(run.display[0].dataSizeBytes).toBe(10_000);
    expect(run.display[0].data.length).toBeLessThan(giant.length);
    expect(run.display[0].data).toContain("[truncated]");
  });
});

describe("siyuan_read_cell_output", () => {
  it("re-runs the cell over WS and returns the UNCAPPED display payload", async () => {
    const giant = "P".repeat(10_000);
    const { baseUrl, close } = await startMockRdm((ws, msg) => {
      if (msg.type === "OpenNotebook") {
        sendServer(ws, { type: "NotebookLoaded", cells: [], title: null });
        return;
      }
      if (msg.type === "RunCell" && msg.cell_id === "cell-raw") {
        sendServer(ws, {
          type: "CellResult",
          cell_id: "cell-raw",
          display: [{ mime_type: "image/png", data: giant }],
          stdout: "",
          stderr: "",
          defines: [],
          duration_ms: 2,
        });
      }
    });
    teardown = close;

    const wsUrl = `${baseUrl}/api/rdm/ws?kfdb_token=sekret`;
    const { tools } = harness(wsUrl);

    const out = await call(tools, "siyuan_read_cell_output", {
      doc_id: "doc-9",
      cell_id: "cell-raw",
    });
    expect(out.ok).toBe(true);
    expect(out.cellId).toBe("cell-raw");
    // Crucially: no "[truncated]" suffix — the raw blob is returned in full.
    const display = (out.display as Array<{ data: string; dataSizeBytes: number }>)[0];
    expect(display.data).toBe(giant);
    expect(display.data).not.toContain("[truncated]");
    expect(display.dataSizeBytes).toBe(10_000);
  });

  it("surfaces CellError cleanly via the same WS path", async () => {
    const { baseUrl, close } = await startMockRdm((ws, msg) => {
      if (msg.type === "OpenNotebook") {
        sendServer(ws, { type: "NotebookLoaded", cells: [], title: null });
        return;
      }
      if (msg.type === "RunCell") {
        sendServer(ws, {
          type: "CellError",
          cell_id: "c-fail",
          message: "boom",
          traceback: null,
          line: 1,
          kind: "execution",
        });
      }
    });
    teardown = close;
    const wsUrl = `${baseUrl}/api/rdm/ws?kfdb_token=sekret`;
    const { tools } = harness(wsUrl);
    const out = await call(tools, "siyuan_read_cell_output", {
      doc_id: "d",
      cell_id: "c-fail",
    });
    expect(out.ok).toBe(false);
    expect(out.errorMessage).toBe("boom");
  });
});
