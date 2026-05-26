#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { TOOLS, handleToolCall } from "./tools.js";

const RESPONSE_MAX_LENGTH = Number.parseInt(process.env.RESPONSE_MAX_LENGTH || "120000", 10);

function capResponse(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (text.length <= RESPONSE_MAX_LENGTH) return text;
  return `${text.slice(0, RESPONSE_MAX_LENGTH)}\n\n--- Response truncated (${text.length} chars, limit ${RESPONSE_MAX_LENGTH}) ---`;
}

const server = new Server(
  { name: "tradfi-market-data-mcp", version: "0.1.0" },
  { capabilities: { tools: { listChanged: false } } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const result = await handleToolCall(request.params.name, request.params.arguments as Record<string, unknown> || {});
  return { content: [{ type: "text", text: capResponse(result) }] };
});

console.log = console.error;
const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`tradfi-market-data-mcp running on stdio (${TOOLS.length} tools)`);
