import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SiyuanClient } from "../siyuan-client.js";
import { textResult } from "./response.js";

interface DocFile {
  id: string;
  name: string;
  hPath?: string;
  path?: string;
  subFileCount?: number;
  [k: string]: unknown;
}

interface ListDocsByPathResult {
  box: string;
  path: string;
  files: DocFile[];
}

interface GetDocResult {
  box?: string;
  path?: string;
  content?: string;
  blockCount?: number;
  id?: string;
  rootID?: string;
  [k: string]: unknown;
}

export function registerDocumentTools(server: McpServer, client: SiyuanClient): void {
  server.tool(
    "siyuan_list_docs",
    "List documents in a notebook under a given path. Returns doc IDs, names, and hierarchical paths.",
    {
      notebook: z.string().describe("Notebook (box) ID returned by siyuan_list_notebooks."),
      path: z
        .string()
        .default("/")
        .describe("Parent path inside the notebook. Use '/' for the root."),
      sort: z
        .number()
        .int()
        .optional()
        .describe("Optional SiYuan sort mode. Omit for the notebook's default."),
      maxListCount: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Maximum number of docs to return. Defaults to SiYuan's server setting."),
      showHidden: z.boolean().optional().describe("Include hidden docs."),
    },
    async ({ notebook, path, sort, maxListCount, showHidden }) => {
      const body: Record<string, unknown> = { notebook, path };
      if (typeof sort === "number") body.sort = sort;
      if (typeof maxListCount === "number") body.maxListCount = maxListCount;
      if (typeof showHidden === "boolean") body.showHidden = showHidden;
      body.ignoreMaxListHint = true;
      const data = await client.post<ListDocsByPathResult>(
        "/api/filetree/listDocsByPath",
        body,
      );
      return textResult({
        box: data.box,
        path: data.path,
        files: (data.files ?? []).map((f) => ({
          id: f.id,
          name: f.name,
          hPath: f.hPath,
          path: f.path,
          subFileCount: f.subFileCount,
        })),
        count: data.files?.length ?? 0,
      });
    },
  );

  server.tool(
    "siyuan_get_doc",
    "Fetch a SiYuan document's contents by block ID (doc ID). Returns rendered HTML/markdown content.",
    {
      id: z.string().describe("Document block ID (a.k.a. root ID)."),
      mode: z
        .number()
        .int()
        .min(0)
        .max(4)
        .optional()
        .describe(
          "0 only current ID, 1 up, 2 down, 3 both, 4 tail. Default 0.",
        ),
      size: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Maximum blocks to load. Defaults to SiYuan's default (102400)."),
    },
    async ({ id, mode, size }) => {
      const body: Record<string, unknown> = { id };
      if (typeof mode === "number") body.mode = mode;
      if (typeof size === "number") body.size = size;
      const data = await client.post<GetDocResult>("/api/filetree/getDoc", body);
      return textResult({
        id: data.id ?? id,
        rootID: data.rootID,
        box: data.box,
        path: data.path,
        blockCount: data.blockCount,
        content: data.content,
      });
    },
  );

  server.tool(
    "siyuan_create_doc",
    "Create a new SiYuan document from Markdown. The hierarchical path 'hPath' is the human-readable title path (e.g. '/Research/RDM MVP').",
    {
      notebook: z.string().describe("Target notebook (box) ID."),
      hPath: z
        .string()
        .describe(
          "Human-readable hierarchical path. Must begin with '/'. The last segment is the doc title.",
        ),
      markdown: z.string().describe("Markdown body of the new document."),
      parentID: z
        .string()
        .optional()
        .describe("Optional parent doc ID for a sub-document."),
      id: z.string().optional().describe("Optional override for the new doc's block ID."),
    },
    async ({ notebook, hPath, markdown, parentID, id }) => {
      const body: Record<string, unknown> = { notebook, path: hPath, markdown };
      if (parentID) body.parentID = parentID;
      if (id) body.id = id;
      const data = await client.post<string>("/api/filetree/createDocWithMd", body);
      return textResult({ docID: data, notebook, hPath });
    },
  );

  server.tool(
    "siyuan_get_block_info",
    "Get SiYuan block metadata by block ID — root ID, notebook, path, type. Used to locate a block inside the doc tree.",
    {
      id: z.string().describe("Block ID."),
    },
    async ({ id }) => {
      const data = await client.post<Record<string, unknown>>(
        "/api/block/getBlockInfo",
        { id },
      );
      return textResult(data);
    },
  );

  server.tool(
    "siyuan_update_block",
    "Replace the contents of a SiYuan block. Use dataType='markdown' for markdown input; SiYuan will parse it into its block tree.",
    {
      id: z.string().describe("Target block ID."),
      data: z.string().describe("New block content."),
      dataType: z
        .enum(["markdown", "dom"])
        .optional()
        .describe("Content format. Defaults to 'markdown'."),
    },
    async ({ id, data, dataType }) => {
      const res = await client.post<unknown>("/api/block/updateBlock", {
        id,
        data,
        dataType: dataType ?? "markdown",
      });
      return textResult({ ok: true, id, result: res });
    },
  );
}
