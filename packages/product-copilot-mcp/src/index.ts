#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { Request, Response } from 'express';
import { RESPONSE_MAX_LENGTH } from './config.js';
import { TOOL_DEFS, handleToolCall } from './tools.js';

const SERVER_NAME = 'product-copilot-mcp';
const SERVER_VERSION = '0.1.9';

function truncateResponse(result: unknown): string {
  const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  if (text.length <= RESPONSE_MAX_LENGTH) return text;
  return `${text.slice(0, RESPONSE_MAX_LENGTH)}\n\n--- Response truncated (${text.length} chars, limit ${RESPONSE_MAX_LENGTH}) ---`;
}

function createServer(): Server {
  return new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: { listChanged: false } } },
  );
}

function setupMCPHandlers(server: Server): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    const result = await handleToolCall(name, args as Record<string, unknown>);
    return { content: [{ type: 'text' as const, text: truncateResponse(result) }] };
  });
}

const isHttp = process.env.TRANSPORT === 'http' || Boolean(process.env.PORT);

if (!isHttp) {
  console.log = console.error;
  const server = createServer();
  setupMCPHandlers(server);
  await server.connect(new StdioServerTransport());
  console.error(`${SERVER_NAME} running on stdio (${TOOL_DEFS.length} tools)`);
} else {
  const { randomUUID } = await import('node:crypto');
  const express = (await import('express')).default;
  const cors = (await import('cors')).default;
  const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');

  interface MCPSession {
    server: Server;
    transport: InstanceType<typeof StreamableHTTPServerTransport>;
    createdAt: number;
  }

  const sessions = new Map<string, MCPSession>();
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '2mb' }));

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', server: SERVER_NAME, version: SERVER_VERSION, tools: TOOL_DEFS.length, sessions: sessions.size });
  });

  app.post('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    let session = sessionId ? sessions.get(sessionId) : undefined;

    if (!session) {
      const newId = randomUUID();
      const server = createServer();
      setupMCPHandlers(server);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => newId });
      await server.connect(transport);
      session = { server, transport, createdAt: Date.now() };
      sessions.set(newId, session);
    }

    await session.transport.handleRequest(req, res, req.body);
  });

  app.delete('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    const session = sessionId ? sessions.get(sessionId) : undefined;
    if (!session) return res.status(404).json({ error: 'Unknown session' });
    await session.transport.handleRequest(req, res);
    session.transport.close();
    session.server.close();
    sessions.delete(sessionId!);
  });

  const port = parseInt(process.env.PORT || '8080', 10);
  app.listen(port, () => {
    console.log(`${SERVER_NAME} running on port ${port}`);
    console.log(`Tools: ${TOOL_DEFS.length}`);
  });
}
