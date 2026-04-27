#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { TOOLS, handleToolCall } from "./tools.js";

const RESPONSE_MAX_LENGTH = parseInt(process.env.RESPONSE_MAX_LENGTH || "200000", 10);
const SERVER_NAME = "hyperfy-experience-mcp";
const SERVER_VERSION = "0.1.0";

function truncateResponse(result: unknown): string {
  const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
  if (text.length <= RESPONSE_MAX_LENGTH) return text;
  return `${text.slice(0, RESPONSE_MAX_LENGTH)}\n\n--- Response truncated (${text.length} chars, limit ${RESPONSE_MAX_LENGTH}) ---`;
}

function setupMcpHandlers(server: Server): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
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

const isHttp = process.argv.includes("--http") || process.env.TRANSPORT === "http";

if (!isHttp) {
  console.log = console.error;
  const server = createServer();
  setupMcpHandlers(server);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`${SERVER_NAME} running on stdio (${TOOLS.length} tools)`);
} else {
  const { randomUUID } = await import("node:crypto");
  const { default: express } = await import("express");
  const { default: cors } = await import("cors");
  const { StreamableHTTPServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/streamableHttp.js"
  );

  interface McpSession {
    server: Server;
    transport: InstanceType<typeof StreamableHTTPServerTransport>;
    createdAt: number;
  }

  const sessions = new Map<string, McpSession>();

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
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      server: SERVER_NAME,
      version: SERVER_VERSION,
      tools: TOOLS.length,
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
    const server = createServer();
    setupMcpHandlers(server);
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
    if (!sessionId || !sessions.has(sessionId)) {
      res.status(400).json({ error: "Invalid or missing session." });
      return;
    }
    const session = sessions.get(sessionId)!;
    await session.transport.handleRequest(req, res);
    session.transport.close();
    session.server.close();
    sessions.delete(sessionId);
  });

  const port = parseInt(process.env.PORT || "8080", 10);
  app.listen(port, () => {
    console.log(`${SERVER_NAME} running on port ${port}`);
    console.log(`Tools: ${TOOLS.length}`);
    console.log("Endpoints: /health /mcp");
  });
}
