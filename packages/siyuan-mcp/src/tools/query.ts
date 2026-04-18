import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SiyuanClient } from "../siyuan-client.js";
import { textResult } from "./response.js";

export function registerQueryTools(server: McpServer, client: SiyuanClient): void {
  server.tool(
    "siyuan_query_sql",
    "Run a SQL statement against the SiYuan block index (local SQLite). Useful for finding blocks by content, type, refs, etc. Returns rows as objects.",
    {
      stmt: z
        .string()
        .describe(
          "SQL statement. Example: \"SELECT id, content FROM blocks WHERE markdown LIKE '%TODO%' LIMIT 50\".",
        ),
    },
    async ({ stmt }) => {
      const rows = await client.post<unknown[]>("/api/query/sql", { stmt });
      return textResult({
        rowCount: Array.isArray(rows) ? rows.length : 0,
        rows: Array.isArray(rows) ? rows : [],
      });
    },
  );
}
