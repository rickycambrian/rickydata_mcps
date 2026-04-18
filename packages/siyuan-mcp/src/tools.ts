import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SiyuanClient } from "./siyuan-client.js";
import { registerHttpTools } from "./tools/index.js";

/**
 * Register all SiYuan MCP tools on the given server. HTTP tools land in
 * M1-MCP-2 via `tools/index.ts`; the RDM WebSocket cell tools land in
 * M1-MCP-3 and will be wired in from here.
 */
export function registerTools(server: McpServer, client: SiyuanClient): void {
  registerHttpTools(server, client);
}
