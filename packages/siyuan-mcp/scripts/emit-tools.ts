/**
 * Emit the list of MCP tools exposed by `@rickydata/siyuan-mcp` as JSON.
 *
 * Used by the publish workflow (M2-BB-1) to populate the MCPServer registry
 * entity. Writes to `/tmp/tools_available.json` by default; override via
 * `OUT=<path> tsx scripts/emit-tools.ts`.
 *
 * Usage (from the package root):
 *   npm run build
 *   npx tsx scripts/emit-tools.ts
 *   cat /tmp/tools_available.json
 */
import { writeFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SiyuanClient } from "../src/siyuan-client.js";
import { registerAllTools } from "../src/tools/index.js";

async function main(): Promise<void> {
  const outPath = process.env.OUT || "/tmp/tools_available.json";

  const server = new McpServer({ name: "siyuan-mcp", version: "0.1.0" });
  // Use a dummy apiKey so tool registration doesn't try to resolve credentials.
  const siyuan = new SiyuanClient({
    baseUrl: process.env.SIYUAN_URL || "https://siyuan.rickydata.org",
    apiKey: "emit-tools-dummy",
  });
  registerAllTools(server, siyuan);

  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client(
    { name: "emit-tools", version: "0.1.0" },
    { capabilities: {} },
  );
  await client.connect(clientTransport);

  const { tools } = await client.listTools();

  const summary = tools.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    inputSchema: t.inputSchema ?? null,
  }));

  writeFileSync(outPath, JSON.stringify(summary, null, 2));
  process.stdout.write(`Wrote ${summary.length} tools to ${outPath}\n`);

  await client.close();
  await server.close();
}

main().catch((err) => {
  process.stderr.write(`emit-tools failed: ${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});
