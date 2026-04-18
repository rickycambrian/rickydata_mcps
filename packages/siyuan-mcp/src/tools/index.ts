import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SiyuanClient } from "../siyuan-client.js";
import { registerNotebookTools } from "./notebooks.js";
import { registerDocumentTools } from "./documents.js";
import { registerQueryTools } from "./query.js";
import { registerKfdbTools } from "./kfdb.js";

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
