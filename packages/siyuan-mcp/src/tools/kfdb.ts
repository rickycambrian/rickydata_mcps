import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SiyuanClient } from "../siyuan-client.js";
import { textResult } from "./response.js";

interface SyncResult {
  count: number;
}

interface BacklinksResult {
  backlinks: Array<{
    note_id?: string;
    title?: string;
    entity_title?: string;
    [k: string]: unknown;
  }>;
}

export function registerKfdbTools(server: McpServer, client: SiyuanClient): void {
  server.tool(
    "siyuan_trigger_kfdb_sync",
    "Trigger SiYuan → KFDB note sync. Call this after `siyuan_create_doc` or `siyuan_update_block` to propagate the change to KFDB.",
    {},
    async () => {
      const data = await client.post<SyncResult>("/api/kfdb/sync", {});
      return textResult({ syncedCount: data.count ?? 0 });
    },
  );

  server.tool(
    "siyuan_get_backlinks",
    "Return KFDB backlinks for a document: notes that contain [[entity]] wikilinks pointing at the given block ID or entity title. Supply exactly one of `id` or `title`.",
    {
      id: z.string().optional().describe("Block ID (document ID) to find backlinks for."),
      title: z
        .string()
        .optional()
        .describe(
          "Entity title (wikilink target) to find backlinks for. Use this for entity stub pages with no block ID.",
        ),
    },
    async ({ id, title }) => {
      if (!id && !title) {
        throw new Error("siyuan_get_backlinks requires either `id` or `title`");
      }
      if (id && title) {
        throw new Error("siyuan_get_backlinks accepts `id` OR `title`, not both");
      }
      const body = title ? { title } : { id };
      const data = await client.post<BacklinksResult>("/api/kfdb/backlinks", body);
      return textResult({
        backlinks: data.backlinks ?? [],
        count: data.backlinks?.length ?? 0,
      });
    },
  );
}
