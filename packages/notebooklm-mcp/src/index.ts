#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { buildToolList, handleToolCall, getHealthInfo } from "./tools.js";
import { RESPONSE_MAX_LENGTH, CONTRACT_VERSION } from "./config.js";

const SERVER_NAME = "notebooklm-mcp";
const SERVER_VERSION = "0.1.0";

function truncateResponse(result: unknown): string {
  const text =
    typeof result === "string" ? result : JSON.stringify(result, null, 2);
  if (text.length <= RESPONSE_MAX_LENGTH) return text;
  return (
    text.slice(0, RESPONSE_MAX_LENGTH) +
    `\n\n--- Response truncated (${text.length} chars, limit ${RESPONSE_MAX_LENGTH}) ---`
  );
}

function setupMCPHandlers(server: Server): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: buildToolList(),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    let result: unknown;
    try {
      result = await handleToolCall(name, args as Record<string, unknown>);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      result = { success: false, error: message };
    }
    return {
      content: [{ type: "text" as const, text: truncateResponse(result) }],
    };
  });
}

function createServer(): Server {
  return new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: { listChanged: false } } },
  );
}

const isHttp =
  process.argv.includes("--http") || process.env.TRANSPORT === "http";

if (!isHttp) {
  // stdio mode (gateway containers, npx). Redirect console.log to stderr so it
  // never pollutes the MCP JSON stream.
  console.log = console.error;
  const server = createServer();
  setupMCPHandlers(server);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `${SERVER_NAME} running on stdio (${buildToolList().length} tools, contract ${CONTRACT_VERSION})`,
  );
} else {
  const { randomUUID } = await import("node:crypto");
  const { default: express } = await import("express");
  const { default: cors } = await import("cors");
  const { StreamableHTTPServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/streamableHttp.js"
  );

  interface MCPSession {
    server: Server;
    transport: InstanceType<typeof StreamableHTTPServerTransport>;
    createdAt: number;
  }

  const sessions = new Map<string, MCPSession>();

  setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (now - session.createdAt > 2 * 60 * 60 * 1000) {
        session.transport.close();
        session.server.close();
        sessions.delete(id);
      }
    }
  }, 5 * 60 * 1000);

  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get("/health", async (req, res) => {
    // ?probe=1 makes one authenticated request to confirm the session is live
    // server-side (cookies can look valid locally while Google has revoked them).
    const probe = req.query.probe === "1" || req.query.probe === "true";
    let health;
    try {
      health = await getHealthInfo(probe);
    } catch (e) {
      health = { auth: "error", error: e instanceof Error ? e.message : String(e) };
    }
    res.json({
      status: "ok",
      server: SERVER_NAME,
      version: SERVER_VERSION,
      tools_count: buildToolList().length,
      sessions: sessions.size,
      ...health,
    });
  });

  app.post("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (sessionId && sessions.has(sessionId)) {
      await sessions.get(sessionId)!.transport.handleRequest(req, res, req.body);
    } else {
      const newId = randomUUID();
      const server = createServer();
      setupMCPHandlers(server);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => newId,
      });
      await server.connect(transport);
      sessions.set(newId, { server, transport, createdAt: Date.now() });
      await transport.handleRequest(req, res, req.body);
    }
  });

  app.get("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !sessions.has(sessionId)) {
      res.status(400).json({
        error: "Invalid or missing session. Send initialize first via POST.",
      });
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
    console.log(`${SERVER_NAME} running on port ${port}`);
    console.log(`Tools: ${buildToolList().length}, contract ${CONTRACT_VERSION}`);
  });
}
