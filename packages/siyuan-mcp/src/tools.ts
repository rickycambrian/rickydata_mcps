import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SiyuanClient } from "./siyuan-client.js";

/**
 * Register all SiYuan MCP tools on the given server. Individual tool
 * implementations live in M1-MCP-2 (HTTP tools) and M1-MCP-3 (RDM WS tools);
 * this scaffold only wires the SiyuanClient through so the entry point
 * stays stable across the two follow-up tasks.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function registerTools(_server: McpServer, _client: SiyuanClient): void {
  // Intentionally empty. Tools land in subsequent M1-MCP-N tasks.
}
