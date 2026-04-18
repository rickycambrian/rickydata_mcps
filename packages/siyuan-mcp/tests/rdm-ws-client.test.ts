import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server as HttpServer } from "node:http";
import { AddressInfo } from "node:net";
import { WebSocketServer, WebSocket } from "ws";
import { RdmWsClient, buildRdmWsUrl } from "../src/rdm-ws-client.js";

/**
 * Spin up a WebSocketServer on an ephemeral port and return its ws:// URL.
 * The `script` callback drives the server side of the conversation — it
 * receives each incoming message (already JSON-parsed) and the connected
 * socket, and is responsible for sending back canned ServerMessage frames.
 */
function startMockServer(
  script: (socket: WebSocket, msg: Record<string, unknown>) => void,
): Promise<{ url: string; close: () => Promise<void>; http: HttpServer }> {
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
      const url = `ws://127.0.0.1:${port}/api/rdm/ws?kfdb_token=test`;
      resolve({
        url,
        http,
        close: () =>
          new Promise<void>((r) => {
            wss.close(() => http.close(() => r()));
          }),
      });
    });
  });
}

function sendServer(ws: WebSocket, msg: unknown): void {
  ws.send(JSON.stringify(msg));
}

let teardown: (() => Promise<void>) | null = null;

afterEach(async () => {
  if (teardown) {
    await teardown();
    teardown = null;
  }
});

describe("buildRdmWsUrl", () => {
  it("rewrites https → wss and injects kfdb_token", () => {
    const url = buildRdmWsUrl("https://siyuan.test/", "sekret", "doc-1");
    expect(url).toBe("wss://siyuan.test/api/rdm/ws?kfdb_token=sekret&notebook=doc-1");
  });

  it("rewrites http → ws when docID is omitted", () => {
    const url = buildRdmWsUrl("http://localhost:6806", "k");
    expect(url).toBe("ws://localhost:6806/api/rdm/ws?kfdb_token=k");
  });
});

describe("RdmWsClient.openNotebook", () => {
  it("connects, sends OpenNotebook, and resolves on NotebookLoaded", async () => {
    const recv: Record<string, unknown>[] = [];
    const { url, close } = await startMockServer((ws, msg) => {
      recv.push(msg);
      if (msg.type === "OpenNotebook") {
        sendServer(ws, { type: "NotebookLoaded", cells: [], title: "t" });
      }
    });
    teardown = close;

    const client = new RdmWsClient({ wsUrl: url });
    const cells = await client.openNotebook("doc-abc");
    expect(cells).toEqual([]);
    expect(recv[0]).toEqual({ type: "OpenNotebook", path: "doc-abc" });
    client.close();
  });

  it("rejects with the server's Error message if it arrives before NotebookLoaded", async () => {
    const { url, close } = await startMockServer((ws, msg) => {
      if (msg.type === "OpenNotebook") {
        sendServer(ws, { type: "Error", message: "missing derive session" });
      }
    });
    teardown = close;

    const client = new RdmWsClient({ wsUrl: url });
    await expect(client.openNotebook("doc-x")).rejects.toThrow(/missing derive session/);
    client.close();
  });
});

describe("RdmWsClient.addCell — options forwarding (M4-FIX-1 HEADER_GAP)", () => {
  it("omits `options` from the wire frame when caller does not pass it (backwards compat)", async () => {
    const recv: Record<string, unknown>[] = [];
    const { url, close } = await startMockServer((ws, msg) => {
      recv.push(msg);
      if (msg.type === "OpenNotebook") {
        sendServer(ws, { type: "NotebookLoaded", cells: [], title: null });
      } else if (msg.type === "AddCell") {
        sendServer(ws, {
          type: "CellAdded",
          cell: {
            id: "c-plain",
            language: "python",
            code: "x",
            options: {},
            imports: [],
            exports: [],
          },
        });
      }
    });
    teardown = close;

    const client = new RdmWsClient({ wsUrl: url });
    await client.openNotebook("d");
    await client.addCell("python", "x");
    client.close();

    const addCell = recv.find((m) => m.type === "AddCell");
    expect(addCell).toBeDefined();
    // Backwards compat guard: older rdm-engine builds may treat an undefined
    // `options` key differently from a missing one. Keep the frame shape
    // identical to pre-M4-FIX-1 when the caller didn't provide options.
    expect(Object.keys(addCell as object)).not.toContain("options");
  });

  it("forwards caller-supplied options verbatim on the AddCell frame", async () => {
    const recv: Record<string, unknown>[] = [];
    const { url, close } = await startMockServer((ws, msg) => {
      recv.push(msg);
      if (msg.type === "OpenNotebook") {
        sendServer(ws, { type: "NotebookLoaded", cells: [], title: null });
      } else if (msg.type === "AddCell") {
        sendServer(ws, {
          type: "CellAdded",
          cell: {
            id: "c-mcp",
            language: "mcp",
            code: "",
            options: (msg as { options?: Record<string, unknown> }).options ?? {},
            imports: [],
            exports: [],
          },
        });
      }
    });
    teardown = close;

    const mcpOptions = {
      server: "knowledgeflow",
      tool: "run_sql",
      source: "lending.daily",
      mode: "kql",
      columns: ["wallet", "borrowUsd"],
      timeoutMs: 30_000,
    };

    const client = new RdmWsClient({ wsUrl: url });
    await client.openNotebook("d");
    const cell = await client.addCell("mcp", "", null, mcpOptions);
    client.close();

    const addCell = recv.find((m) => m.type === "AddCell") as {
      options?: Record<string, unknown>;
    };
    expect(addCell.options).toEqual(mcpOptions);
    // Cell echoed back carries the options through so downstream code paths
    // that inspect CellInfo.options see the same thing rdm-engine would.
    expect(cell.options).toEqual(mcpOptions);
  });

  it("forwards an `ai` cell's `model` option", async () => {
    const recv: Record<string, unknown>[] = [];
    const { url, close } = await startMockServer((ws, msg) => {
      recv.push(msg);
      if (msg.type === "OpenNotebook") {
        sendServer(ws, { type: "NotebookLoaded", cells: [], title: null });
      } else if (msg.type === "AddCell") {
        sendServer(ws, {
          type: "CellAdded",
          cell: {
            id: "c-ai",
            language: "ai",
            code: "",
            options: {},
            imports: [],
            exports: [],
          },
        });
      }
    });
    teardown = close;

    const client = new RdmWsClient({ wsUrl: url });
    await client.openNotebook("d");
    await client.addCell("ai", "summarize this", null, { model: "claude-opus-4-7" });
    client.close();

    const addCell = recv.find((m) => m.type === "AddCell") as {
      options?: Record<string, unknown>;
    };
    expect(addCell.options).toEqual({ model: "claude-opus-4-7" });
  });

  it("treats an explicit null options as 'no options' (wire frame omits the key)", async () => {
    const recv: Record<string, unknown>[] = [];
    const { url, close } = await startMockServer((ws, msg) => {
      recv.push(msg);
      if (msg.type === "OpenNotebook") {
        sendServer(ws, { type: "NotebookLoaded", cells: [], title: null });
      } else if (msg.type === "AddCell") {
        sendServer(ws, {
          type: "CellAdded",
          cell: {
            id: "c-null",
            language: "python",
            code: "",
            options: {},
            imports: [],
            exports: [],
          },
        });
      }
    });
    teardown = close;

    const client = new RdmWsClient({ wsUrl: url });
    await client.openNotebook("d");
    await client.addCell("python", "x", null, null);
    client.close();

    const addCell = recv.find((m) => m.type === "AddCell") as object;
    expect(Object.keys(addCell)).not.toContain("options");
  });
});

describe("RdmWsClient.addCell", () => {
  it("sends AddCell and resolves with the server-minted CellInfo", async () => {
    const { url, close } = await startMockServer((ws, msg) => {
      if (msg.type === "OpenNotebook") {
        sendServer(ws, { type: "NotebookLoaded", cells: [], title: null });
      } else if (msg.type === "AddCell") {
        sendServer(ws, {
          type: "CellAdded",
          cell: {
            id: "cell-123",
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

    const client = new RdmWsClient({ wsUrl: url });
    await client.openNotebook("doc-1");
    const cell = await client.addCell("python", "print('hi')");
    expect(cell.id).toBe("cell-123");
    expect(cell.language).toBe("python");
    client.close();
  });
});

describe("RdmWsClient.runCell + awaitResult", () => {
  it.each([["python"], ["r"], ["api"], ["mcp"], ["ai"]])(
    "round-trips a %s cell with streaming stdout + CellResult",
    async (language) => {
      const { url, close } = await startMockServer((ws, msg) => {
        if (msg.type === "OpenNotebook") {
          sendServer(ws, { type: "NotebookLoaded", cells: [], title: null });
          return;
        }
        if (msg.type === "AddCell") {
          sendServer(ws, {
            type: "CellAdded",
            cell: {
              id: "c-1",
              language,
              code: msg.code,
              options: {},
              imports: [],
              exports: [],
            },
          });
          return;
        }
        if (msg.type === "RunCell" && msg.cell_id === "c-1") {
          sendServer(ws, { type: "CellRunning", cell_id: "c-1" });
          sendServer(ws, { type: "CellStdout", cell_id: "c-1", data: "part1" });
          sendServer(ws, { type: "CellStdout", cell_id: "c-1", data: "part2" });
          sendServer(ws, {
            type: "CellResult",
            cell_id: "c-1",
            display: [{ mime_type: "text/plain", data: "42" }],
            stdout: "part1part2",
            stderr: "",
            defines: ["x"],
            duration_ms: 17,
          });
        }
      });
      teardown = close;

      const client = new RdmWsClient({ wsUrl: url });
      await client.openNotebook("doc-1");
      const cell = await client.addCell(language, "code-body");
      client.runCell(cell.id);
      const outcome = await client.awaitResult(cell.id, 5_000);
      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        expect(outcome.stdout).toBe("part1part2");
        expect(outcome.durationMs).toBe(17);
        expect(outcome.defines).toEqual(["x"]);
        expect(outcome.display[0].mime_type).toBe("text/plain");
      }
      client.close();
    },
  );

  it("resolves with ok:false on CellError and preserves streamed stderr", async () => {
    const { url, close } = await startMockServer((ws, msg) => {
      if (msg.type === "OpenNotebook") {
        sendServer(ws, { type: "NotebookLoaded", cells: [], title: null });
        return;
      }
      if (msg.type === "AddCell") {
        sendServer(ws, {
          type: "CellAdded",
          cell: { id: "c-err", language: "python", code: "", options: {}, imports: [], exports: [] },
        });
        return;
      }
      if (msg.type === "RunCell") {
        sendServer(ws, { type: "CellStderr", cell_id: "c-err", data: "traceback line 1\n" });
        sendServer(ws, {
          type: "CellError",
          cell_id: "c-err",
          message: "NameError",
          traceback: "traceback line 1\n",
          line: 1,
          kind: "execution",
          upstream_cell_id: null,
          upstream_cell_name: null,
          upstream_language: null,
        });
      }
    });
    teardown = close;

    const client = new RdmWsClient({ wsUrl: url });
    await client.openNotebook("doc-1");
    const cell = await client.addCell("python", "boom");
    client.runCell(cell.id);
    const outcome = await client.awaitResult(cell.id, 5_000);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.message).toBe("NameError");
      expect(outcome.kind).toBe("execution");
      expect(outcome.stderr).toContain("traceback line 1");
    }
    client.close();
  });

  it("ignores frames addressed to a different cell_id", async () => {
    const { url, close } = await startMockServer((ws, msg) => {
      if (msg.type === "OpenNotebook") {
        sendServer(ws, { type: "NotebookLoaded", cells: [], title: null });
        return;
      }
      if (msg.type === "AddCell") {
        sendServer(ws, {
          type: "CellAdded",
          cell: { id: "target", language: "python", code: "", options: {}, imports: [], exports: [] },
        });
        return;
      }
      if (msg.type === "RunCell") {
        // Inject noise for a different cell — must be ignored.
        sendServer(ws, { type: "CellStdout", cell_id: "other", data: "NOISE" });
        sendServer(ws, { type: "CellStdout", cell_id: "target", data: "real" });
        sendServer(ws, {
          type: "CellResult",
          cell_id: "target",
          display: [],
          stdout: "real",
          stderr: "",
          defines: [],
          duration_ms: 1,
        });
      }
    });
    teardown = close;

    const client = new RdmWsClient({ wsUrl: url });
    await client.openNotebook("d");
    await client.addCell("python", "x");
    client.runCell("target");
    const outcome = await client.awaitResult("target", 5_000);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.stdout).toBe("real");
      expect(outcome.stdout).not.toContain("NOISE");
    }
    client.close();
  });

  it("rejects awaitResult when the socket closes mid-run", async () => {
    const { url, close } = await startMockServer((ws, msg) => {
      if (msg.type === "OpenNotebook") {
        sendServer(ws, { type: "NotebookLoaded", cells: [], title: null });
        return;
      }
      if (msg.type === "AddCell") {
        sendServer(ws, {
          type: "CellAdded",
          cell: { id: "c1", language: "python", code: "", options: {}, imports: [], exports: [] },
        });
        return;
      }
      if (msg.type === "RunCell") {
        // Close the socket without ever returning a terminal frame.
        ws.close();
      }
    });
    teardown = close;

    const client = new RdmWsClient({ wsUrl: url });
    await client.openNotebook("d");
    await client.addCell("python", "x");
    client.runCell("c1");
    await expect(client.awaitResult("c1", 5_000)).rejects.toThrow(/closed before cell/);
  });
});

describe("RdmWsClient guards", () => {
  it("addCell throws before openNotebook", async () => {
    const client = new RdmWsClient({ wsUrl: "ws://127.0.0.1:1/never" });
    await expect(client.addCell("python", "x")).rejects.toThrow(/not connected/);
  });

  it("openNotebook rejects on connect timeout", async () => {
    // A reserved port that is closed — the connect will fail immediately.
    const client = new RdmWsClient({
      wsUrl: "ws://127.0.0.1:1/dead",
      connectTimeoutMs: 200,
    });
    await expect(client.openNotebook("d")).rejects.toThrow();
  });
});
