import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SiyuanClient } from "../siyuan-client.js";
import { registerNotebookTools } from "./notebooks.js";
import { registerDocumentTools } from "./documents.js";
import { registerQueryTools } from "./query.js";
import { registerKfdbTools } from "./kfdb.js";
import { registerCellTools, CELL_TOOL_NAMES, type CellToolOptions } from "./cells.js";

export interface ToolRegistrationOptions {
  cellOptions?: CellToolOptions;
}

/**
 * Register every HTTP-backed SiYuan MCP tool on the given server. Tool-file
 * ordering is kept stable so `scripts/emit-tools.ts` produces deterministic
 * tool lists across builds.
 */
export function registerHttpTools(server: McpServer, client: SiyuanClient): void {
  registerNotebookTools(server, client);
  registerDocumentTools(server, client);
  registerQueryTools(server, client);
  registerKfdbTools(server, client);
}

export function registerAllTools(
  server: McpServer,
  client: SiyuanClient,
  opts: ToolRegistrationOptions = {},
): void {
  registerHttpTools(server, client);
  registerCellTools(server, client, opts.cellOptions);
}

export const HTTP_TOOL_NAMES = [
  "siyuan_list_notebooks",
  "siyuan_list_docs",
  "siyuan_get_doc",
  "siyuan_create_doc",
  "siyuan_get_block_info",
  "siyuan_update_block",
  "siyuan_query_sql",
  "siyuan_trigger_kfdb_sync",
  "siyuan_get_backlinks",
] as const;

export const ALL_TOOL_NAMES = [...HTTP_TOOL_NAMES, ...CELL_TOOL_NAMES] as const;

export { CELL_TOOL_NAMES };
