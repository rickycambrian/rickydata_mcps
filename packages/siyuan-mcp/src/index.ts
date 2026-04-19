#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SiyuanClient } from "./siyuan-client.js";
import { registerTools } from "./tools.js";

const SERVER_NAME = "siyuan-mcp";
const SERVER_VERSION = "0.2.2";

function createServer(client: SiyuanClient): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerTools(server, client);
  return server;
}

async function main(): Promise<void> {
  const useHttp = process.env.TRANSPORT === "http" || !!process.env.PORT;
  // Thread process.env so SIYUAN_URL / SIYUAN_KFDB_TOKEN / SIYUAN_KFDB_JWT
  // set on the process are honored. The SiyuanClient constructor has an
  // internal process.env fallback for baseUrl too, but passing env here
  // keeps resolveToken()'s env-var priority working end-to-end.
  const client = new SiyuanClient({ env: process.env });

  if (useHttp) {
    const { randomUUID } = await import("node:crypto");
    const { default: express } = await import("express");
    const { StreamableHTTPServerTransport } = await import(
      "@modelcontextprotocol/sdk/server/streamableHttp.js"
    );

    interface Session {
      server: McpServer;
      transport: InstanceType<typeof StreamableHTTPServerTransport>;
      createdAt: number;
    }
    const sessions = new Map<string, Session>();

    setInterval(() => {
      const now = Date.now();
      for (const [id, session] of sessions) {
        if (now - session.createdAt > 2 * 60 * 60 * 1000) {
          session.transport.close();
          session.server.close();
          sessions.delete(id);
        }
      }
    }, 5 * 60 * 1000).unref();

    const app = express();
    app.use(express.json({ limit: "10mb" }));

    app.get("/health", (_req, res) => {
      res.json({
        status: "ok",
        server: SERVER_NAME,
        version: SERVER_VERSION,
        siyuanUrl: client.getBaseUrl(),
        sessions: sessions.size,
      });
    });

    app.post("/mcp", async (req, res) => {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      if (sessionId && sessions.has(sessionId)) {
        await sessions.get(sessionId)!.transport.handleRequest(req, res, req.body);
        return;
      }
      const newId = randomUUID();
      const server = createServer(client);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => newId,
      });
      await server.connect(transport);
      sessions.set(newId, { server, transport, createdAt: Date.now() });
      await transport.handleRequest(req, res, req.body);
    });

    app.get("/mcp", async (req, res) => {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      if (!sessionId || !sessions.has(sessionId)) {
        res.status(400).json({ error: "Invalid or missing session. Send initialize first via POST." });
        return;
      }
      await sessions.get(sessionId)!.transport.handleRequest(req, res);
    });

    app.delete("/mcp", async (req, res) => {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      if (sessionId && sessions.has(sessionId)) {
        const session = sessions.get(sessionId)!;
        await session.transport.handleRequest(req, res);
        session.transport.close();
        session.server.close();
        sessions.delete(sessionId);
      } else {
        res.status(400).json({ error: "Invalid or missing session." });
      }
    });

    const port = parseInt(process.env.PORT || "8080", 10);
    app.listen(port, () => {
      // Keep all diagnostics on stderr so stdio-mode callers are never
      // confused by stray stdout noise.
      console.error(`${SERVER_NAME} http transport listening on :${port}`);
    });
  } else {
    // Stdio mode: stdout is reserved for MCP JSON-RPC frames.
    console.log = console.error;
    const server = createServer(client);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`${SERVER_NAME} running on stdio (siyuan=${client.getBaseUrl()})`);
  }
}

main().catch((err) => {
  console.error(`${SERVER_NAME} fatal:`, err);
  process.exit(1);
});
