#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { TOOLS, handleToolCall } from "./tools/index.js";
import { clearKey } from "./auth/sdk-client.js";

// ============================================================================
// CONFIGURATION
// ============================================================================

const RESPONSE_MAX_LENGTH = parseInt(
  process.env.RESPONSE_MAX_LENGTH || "200000",
  10,
);
const SERVER_NAME = "agent0-mcp";
const SERVER_VERSION = "0.8.0";

// ============================================================================
// RESPONSE CAPPING
// ============================================================================

function truncateResponse(result: unknown): string {
  const text =
    typeof result === "string" ? result : JSON.stringify(result, null, 2);
  if (text.length <= RESPONSE_MAX_LENGTH) return text;
  return (
    text.slice(0, RESPONSE_MAX_LENGTH) +
    `\n\n--- Response truncated (${text.length} chars, limit ${RESPONSE_MAX_LENGTH}) ---`
  );
}

// ============================================================================
// MCP HANDLER SETUP
// ============================================================================

function setupMCPHandlers(server: Server): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    let result: unknown;

    try {
      result = await handleToolCall(name, args);
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : String(error);
      result = { success: false, error: message };
    }

    const content = truncateResponse(result);
    return {
      content: [{ type: "text" as const, text: content }],
    };
  });
}

function createServer(): Server {
  return new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: { listChanged: false } } },
  );
}

// ============================================================================
// START
// ============================================================================

const isHttp = process.argv.includes("--http");

if (!isHttp) {
  // Default: stdio mode (used by gateway containers and npx)
  // Redirect console.log to stderr so it doesn't pollute the MCP JSON stream
  console.log = console.error;
  const server = createServer();
  setupMCPHandlers(server);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`${SERVER_NAME} running on stdio (${TOOLS.length} tools)`);
} else {
  // HTTP mode: lazy-import express, cors, and StreamableHTTPServerTransport
  // to avoid loading them in stdio mode (container environments)
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
        // Clear any stored private keys for this session
        clearKey();
      }
    }
  }, 5 * 60 * 1000);

  const app = express();
  app.use(cors());
  app.use(express.json());

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
      const session = sessions.get(sessionId)!;
      await session.transport.handleRequest(req, res, req.body);
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
    console.log(`Tools: ${TOOLS.length}`);
    console.log(`Endpoints: /health /mcp`);
  });
}
