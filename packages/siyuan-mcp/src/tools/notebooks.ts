import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SiyuanClient } from "../siyuan-client.js";
import { textResult } from "./response.js";

interface Notebook {
  id: string;
  name: string;
  icon?: string;
  sort?: number;
  closed?: boolean;
  [k: string]: unknown;
}

interface LsNotebooksResult {
  notebooks: Notebook[];
}

export function registerNotebookTools(server: McpServer, client: SiyuanClient): void {
  server.tool(
    "siyuan_list_notebooks",
    "List all SiYuan notebooks (boxes) visible to the authenticated wallet. Useful as the first call when exploring a workspace.",
    {
      flashcard: z
        .boolean()
        .optional()
        .describe("If true, returns only flashcard notebooks. Default false."),
    },
    async ({ flashcard }) => {
      const body: Record<string, unknown> = {};
      if (typeof flashcard === "boolean") body.flashcard = flashcard;
      const data = await client.post<LsNotebooksResult>("/api/notebook/lsNotebooks", body);
      return textResult({
        notebooks: (data?.notebooks ?? []).map((n) => ({
          id: n.id,
          name: n.name,
          icon: n.icon,
          closed: n.closed,
          sort: n.sort,
        })),
        count: data?.notebooks?.length ?? 0,
      });
    },
  );
}
