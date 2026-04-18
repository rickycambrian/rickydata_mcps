import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SiyuanClient } from "./siyuan-client.js";
import { registerAllTools, type ToolRegistrationOptions } from "./tools/index.js";

/**
 * Register all SiYuan MCP tools (9 HTTP + 3 RDM WS cell tools) on the given
 * server. Individual tool bodies live under `src/tools/*.ts`.
 */
export function registerTools(
  server: McpServer,
  client: SiyuanClient,
  opts: ToolRegistrationOptions = {},
): void {
  registerAllTools(server, client, opts);
}
