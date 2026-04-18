import { describe, it, expect, beforeEach, afterEach } from "vitest";
import nock from "nock";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SiyuanClient } from "../src/siyuan-client.js";
import { registerHttpTools, HTTP_TOOL_NAMES } from "../src/tools/index.js";

const BASE = "https://siyuan.test";

beforeEach(() => {
  nock.disableNetConnect();
});

afterEach(() => {
  nock.cleanAll();
  nock.enableNetConnect();
});

/**
 * Build a fresh server + invokeTool() harness for a single test. The McpServer
 * exposes the registered tools via `server.server.request(...)` with the MCP
 * tools/call schema, but calling the handler directly keeps the tests tight
 * on request-shape + response-parse, which is what M1-MCP-2 actually promises.
 *
 * To avoid depending on MCP internal request routing, each tool file returns
 * via `server.tool(name, desc, shape, handler)` — we wrap the same handler by
 * capturing it into a registry and invoking it by name.
 */
interface ToolEntry {
  name: string;
  handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;
}

function harness(): { tools: Map<string, ToolEntry>; client: SiyuanClient } {
  const tools = new Map<string, ToolEntry>();
  // Proxy McpServer.tool() so we capture handlers for direct invocation.
  const fakeServer = {
    tool(
      name: string,
      _desc: string,
      _shape: unknown,
      handler: ToolEntry["handler"],
    ) {
      tools.set(name, { name, handler });
    },
  } as unknown as McpServer;

  const client = new SiyuanClient({ baseUrl: BASE, apiKey: "test-key" });
  registerHttpTools(fakeServer, client);
  return { tools, client };
}

async function call(tools: Map<string, ToolEntry>, name: string, args: Record<string, unknown> = {}) {
  const entry = tools.get(name);
  if (!entry) throw new Error(`tool not registered: ${name}`);
  const out = await entry.handler(args);
  const payload = JSON.parse(out.content[0].text);
  return payload;
}

describe("HTTP tool registration", () => {
  it("registers all 9 advertised tool names", () => {
    const { tools } = harness();
    for (const name of HTTP_TOOL_NAMES) {
      expect(tools.has(name), `missing tool ${name}`).toBe(true);
    }
    expect(tools.size).toBe(HTTP_TOOL_NAMES.length);
  });
});

describe("siyuan_list_notebooks", () => {
  it("POSTs to /api/notebook/lsNotebooks with the kfdb_token query", async () => {
    const scope = nock(BASE)
      .post("/api/notebook/lsNotebooks", {})
      .query({ kfdb_token: "test-key" })
      .reply(200, {
        code: 0,
        msg: "",
        data: {
          notebooks: [
            { id: "20240101000000-abcdefg", name: "Personal", icon: "1f4d3", closed: false },
            { id: "20240101000001-hijklmn", name: "Work", closed: true },
          ],
        },
      });

    const { tools } = harness();
    const out = await call(tools, "siyuan_list_notebooks");
    expect(out.count).toBe(2);
    expect(out.notebooks[0]).toEqual({
      id: "20240101000000-abcdefg",
      name: "Personal",
      icon: "1f4d3",
      closed: false,
      sort: undefined,
    });
    scope.done();
  });

  it("forwards the flashcard boolean when provided", async () => {
    const scope = nock(BASE)
      .post("/api/notebook/lsNotebooks", { flashcard: true })
      .query(true)
      .reply(200, { code: 0, msg: "", data: { notebooks: [] } });

    const { tools } = harness();
    const out = await call(tools, "siyuan_list_notebooks", { flashcard: true });
    expect(out.count).toBe(0);
    scope.done();
  });
});

describe("siyuan_list_docs", () => {
  it("sends notebook + path + ignoreMaxListHint=true", async () => {
    const scope = nock(BASE)
      .post("/api/filetree/listDocsByPath", (body) => {
        return (
          body.notebook === "box-1" &&
          body.path === "/" &&
          body.ignoreMaxListHint === true
        );
      })
      .query(true)
      .reply(200, {
        code: 0,
        msg: "",
        data: {
          box: "box-1",
          path: "/",
          files: [
            { id: "doc-1", name: "README.sy", hPath: "/README", path: "/doc-1.sy", subFileCount: 0 },
          ],
        },
      });

    const { tools } = harness();
    const out = await call(tools, "siyuan_list_docs", { notebook: "box-1", path: "/" });
    expect(out.box).toBe("box-1");
    expect(out.count).toBe(1);
    expect(out.files[0].id).toBe("doc-1");
    scope.done();
  });

  it("forwards sort/maxListCount/showHidden when set", async () => {
    const scope = nock(BASE)
      .post("/api/filetree/listDocsByPath", (body) => {
        return (
          body.sort === 3 && body.maxListCount === 10 && body.showHidden === true
        );
      })
      .query(true)
      .reply(200, { code: 0, msg: "", data: { box: "b", path: "/", files: [] } });

    const { tools } = harness();
    await call(tools, "siyuan_list_docs", {
      notebook: "b",
      path: "/",
      sort: 3,
      maxListCount: 10,
      showHidden: true,
    });
    scope.done();
  });
});

describe("siyuan_get_doc", () => {
  it("POSTs to /api/filetree/getDoc with the id", async () => {
    const scope = nock(BASE)
      .post("/api/filetree/getDoc", { id: "doc-123" })
      .query(true)
      .reply(200, {
        code: 0,
        msg: "",
        data: {
          id: "doc-123",
          rootID: "doc-123",
          box: "box-1",
          path: "/doc-123.sy",
          content: "<p>hello</p>",
          blockCount: 1,
        },
      });

    const { tools } = harness();
    const out = await call(tools, "siyuan_get_doc", { id: "doc-123" });
    expect(out.rootID).toBe("doc-123");
    expect(out.content).toContain("hello");
    scope.done();
  });

  it("forwards mode + size", async () => {
    const scope = nock(BASE)
      .post("/api/filetree/getDoc", (body) =>
        body.id === "doc-x" && body.mode === 2 && body.size === 50,
      )
      .query(true)
      .reply(200, { code: 0, msg: "", data: { id: "doc-x" } });

    const { tools } = harness();
    await call(tools, "siyuan_get_doc", { id: "doc-x", mode: 2, size: 50 });
    scope.done();
  });
});

describe("siyuan_create_doc", () => {
  it("POSTs to /api/filetree/createDocWithMd and returns the new doc ID", async () => {
    const scope = nock(BASE)
      .post("/api/filetree/createDocWithMd", (body) =>
        body.notebook === "box-9" &&
        body.path === "/My Doc" &&
        body.markdown === "# hi",
      )
      .query(true)
      .reply(200, { code: 0, msg: "", data: "20260418140000-aaabbbc" });

    const { tools } = harness();
    const out = await call(tools, "siyuan_create_doc", {
      notebook: "box-9",
      hPath: "/My Doc",
      markdown: "# hi",
    });
    expect(out.docID).toBe("20260418140000-aaabbbc");
    expect(out.hPath).toBe("/My Doc");
    scope.done();
  });

  it("forwards parentID + id when provided", async () => {
    const scope = nock(BASE)
      .post("/api/filetree/createDocWithMd", (body) =>
        body.parentID === "pid" && body.id === "did",
      )
      .query(true)
      .reply(200, { code: 0, msg: "", data: "did" });

    const { tools } = harness();
    await call(tools, "siyuan_create_doc", {
      notebook: "b",
      hPath: "/x",
      markdown: "y",
      parentID: "pid",
      id: "did",
    });
    scope.done();
  });
});

describe("siyuan_get_block_info", () => {
  it("POSTs to /api/block/getBlockInfo and returns the raw data", async () => {
    const scope = nock(BASE)
      .post("/api/block/getBlockInfo", { id: "blk-1" })
      .query(true)
      .reply(200, {
        code: 0,
        msg: "",
        data: { id: "blk-1", rootID: "doc-1", box: "box-1", path: "/doc-1.sy" },
      });

    const { tools } = harness();
    const out = await call(tools, "siyuan_get_block_info", { id: "blk-1" });
    expect(out.id).toBe("blk-1");
    expect(out.rootID).toBe("doc-1");
    scope.done();
  });
});

describe("siyuan_update_block", () => {
  it("POSTs with id/data/dataType defaulting to markdown", async () => {
    const scope = nock(BASE)
      .post("/api/block/updateBlock", {
        id: "blk-7",
        data: "updated content",
        dataType: "markdown",
      })
      .query(true)
      .reply(200, { code: 0, msg: "", data: [] });

    const { tools } = harness();
    const out = await call(tools, "siyuan_update_block", {
      id: "blk-7",
      data: "updated content",
    });
    expect(out.ok).toBe(true);
    expect(out.id).toBe("blk-7");
    scope.done();
  });

  it("allows dataType=dom", async () => {
    const scope = nock(BASE)
      .post("/api/block/updateBlock", (body) => body.dataType === "dom")
      .query(true)
      .reply(200, { code: 0, msg: "", data: [] });

    const { tools } = harness();
    await call(tools, "siyuan_update_block", { id: "x", data: "<p/>", dataType: "dom" });
    scope.done();
  });
});

describe("siyuan_query_sql", () => {
  it("POSTs to /api/query/sql with the statement and parses rows", async () => {
    const scope = nock(BASE)
      .post("/api/query/sql", { stmt: "SELECT id FROM blocks LIMIT 2" })
      .query(true)
      .reply(200, {
        code: 0,
        msg: "",
        data: [{ id: "a" }, { id: "b" }],
      });

    const { tools } = harness();
    const out = await call(tools, "siyuan_query_sql", {
      stmt: "SELECT id FROM blocks LIMIT 2",
    });
    expect(out.rowCount).toBe(2);
    expect(out.rows).toEqual([{ id: "a" }, { id: "b" }]);
    scope.done();
  });

  it("handles an empty result set", async () => {
    nock(BASE).post("/api/query/sql").query(true).reply(200, {
      code: 0,
      msg: "",
      data: [],
    });

    const { tools } = harness();
    const out = await call(tools, "siyuan_query_sql", { stmt: "SELECT 1 WHERE 0" });
    expect(out.rowCount).toBe(0);
    expect(out.rows).toEqual([]);
  });
});

describe("siyuan_trigger_kfdb_sync", () => {
  it("POSTs to /api/kfdb/sync and returns the count", async () => {
    const scope = nock(BASE)
      .post("/api/kfdb/sync", {})
      .query(true)
      .reply(200, { code: 0, msg: "", data: { count: 7 } });

    const { tools } = harness();
    const out = await call(tools, "siyuan_trigger_kfdb_sync");
    expect(out.syncedCount).toBe(7);
    scope.done();
  });
});

describe("siyuan_get_backlinks", () => {
  it("POSTs {title} when title is provided", async () => {
    const scope = nock(BASE)
      .post("/api/kfdb/backlinks", { title: "Claude Code" })
      .query(true)
      .reply(200, {
        code: 0,
        msg: "",
        data: {
          backlinks: [{ note_id: "n1", title: "A", entity_title: "Claude Code" }],
        },
      });

    const { tools } = harness();
    const out = await call(tools, "siyuan_get_backlinks", { title: "Claude Code" });
    expect(out.count).toBe(1);
    expect(out.backlinks[0].entity_title).toBe("Claude Code");
    scope.done();
  });

  it("POSTs {id} when id is provided", async () => {
    const scope = nock(BASE)
      .post("/api/kfdb/backlinks", { id: "blk-1" })
      .query(true)
      .reply(200, {
        code: 0,
        msg: "",
        data: { backlinks: [] },
      });

    const { tools } = harness();
    const out = await call(tools, "siyuan_get_backlinks", { id: "blk-1" });
    expect(out.count).toBe(0);
    scope.done();
  });

  it("throws when neither id nor title is provided", async () => {
    const { tools } = harness();
    await expect(call(tools, "siyuan_get_backlinks")).rejects.toThrow(/requires either/);
  });

  it("throws when both id and title are provided", async () => {
    const { tools } = harness();
    await expect(
      call(tools, "siyuan_get_backlinks", { id: "x", title: "y" }),
    ).rejects.toThrow(/not both/);
  });
});
