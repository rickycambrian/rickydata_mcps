#!/usr/bin/env node
// Integration harness for M1-DV-1. Spawns the compiled siyuan-mcp stdio server
// with the SIYUAN_KFDB_JWT bootstrap path, then drives `tools/list` + one
// `tools/call` per each of the 12 tools against the live Cloud Run deployment.
//
// Usage:
//   SIYUAN_URL=<url> SIYUAN_KFDB_JWT=<jwt> node drive-stdio.mjs
//
// Output: newline-delimited JSON transcripts to stdout (one object per step).

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = resolve(__dirname, "../../dist/index.js");

const SIYUAN_URL = process.env.SIYUAN_URL || "https://rickydata-siyuan-2dbp4scmrq-uc.a.run.app";
const JWT = process.env.SIYUAN_KFDB_JWT;
if (!JWT) {
  console.error("SIYUAN_KFDB_JWT env var is required");
  process.exit(1);
}

const transcript = [];
function record(step, payload) {
  const entry = { ts: new Date().toISOString(), step, ...payload };
  transcript.push(entry);
  process.stdout.write(JSON.stringify(entry) + "\n");
}

// --- Spawn server ---
const child = spawn(process.execPath, [SERVER_ENTRY], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, SIYUAN_URL, SIYUAN_KFDB_JWT: JWT },
});

let stderrBuf = "";
child.stderr.on("data", (chunk) => {
  stderrBuf += chunk.toString();
});

let stdoutBuf = "";
const pending = new Map(); // id -> {resolve, reject}
let nextId = 1;

child.stdout.on("data", (chunk) => {
  stdoutBuf += chunk.toString();
  let idx;
  while ((idx = stdoutBuf.indexOf("\n")) >= 0) {
    const line = stdoutBuf.slice(0, idx).trim();
    stdoutBuf = stdoutBuf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (e) {
      record("parse-error", { raw: line, error: e.message });
      continue;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg);
    }
  }
});

child.on("exit", (code, signal) => {
  record("server-exit", { code, signal, stderrTail: stderrBuf.slice(-600) });
});

function rpc(method, params) {
  const id = nextId++;
  const req = { jsonrpc: "2.0", id, method, params };
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify(req) + "\n");
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`rpc timeout: ${method}`));
      }
    }, 180_000);
  });
}

function shortenToolResult(result) {
  if (!result) return result;
  const out = { ...result };
  if (Array.isArray(out.content)) {
    out.content = out.content.map((c) => {
      if (c?.type === "text" && typeof c.text === "string" && c.text.length > 2000) {
        return { ...c, text: c.text.slice(0, 2000) + "... [truncated]" };
      }
      return c;
    });
  }
  return out;
}

async function callTool(name, args) {
  const before = Date.now();
  let res;
  try {
    res = await rpc("tools/call", { name, arguments: args });
  } catch (e) {
    record("tool-call-error", { name, args, error: e.message, elapsedMs: Date.now() - before });
    return null;
  }
  record("tool-call", {
    name,
    args,
    elapsedMs: Date.now() - before,
    error: res.error ?? null,
    result: shortenToolResult(res.result),
  });
  return res;
}

async function main() {
  // 1) initialize
  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: { roots: {}, sampling: {} },
    clientInfo: { name: "m1-dv-1-harness", version: "0.0.1" },
  });
  record("initialize", { response: init.result });

  // Notify initialized
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  // 2) tools/list
  const list = await rpc("tools/list", {});
  const tools = list.result?.tools || [];
  record("tools-list", { count: tools.length, names: tools.map((t) => t.name) });

  // 3) Drive each of the 12 tools
  // siyuan_list_notebooks
  const nbRes = await callTool("siyuan_list_notebooks", {});
  // Extract notebook ID for list_docs
  let firstNotebookId = null;
  try {
    const text = nbRes?.result?.content?.[0]?.text;
    if (text) {
      const parsed = JSON.parse(text);
      const notebooks = parsed.notebooks || parsed;
      if (Array.isArray(notebooks) && notebooks.length > 0) {
        firstNotebookId = notebooks[0].id;
      }
    }
  } catch {}
  record("extract", { firstNotebookId });

  // siyuan_list_docs — requires notebook ID and path
  if (firstNotebookId) {
    await callTool("siyuan_list_docs", { notebook: firstNotebookId, path: "/" });
  } else {
    record("skip", { tool: "siyuan_list_docs", reason: "no notebook id available" });
  }

  // siyuan_create_doc — in the first notebook
  const isoStamp = new Date().toISOString().replace(/[:.]/g, "-");
  const docTitle = `MCP Smoke Test ${isoStamp}`;
  let newDocId = null;
  if (firstNotebookId) {
    const createRes = await callTool("siyuan_create_doc", {
      notebook: firstNotebookId,
      hPath: `/${docTitle}`,
      markdown: `# ${docTitle}\n\nSmoke-test doc created by M1-DV-1 harness at ${isoStamp}.\n`,
    });
    try {
      const text = createRes?.result?.content?.[0]?.text;
      if (text) {
        const parsed = JSON.parse(text);
        newDocId = parsed.docID || parsed.id || parsed.docId || parsed.doc_id || null;
      }
    } catch {}
    record("extract", { newDocId });
  } else {
    record("skip", { tool: "siyuan_create_doc", reason: "no notebook id available" });
  }

  // siyuan_get_doc
  if (newDocId) {
    await callTool("siyuan_get_doc", { id: newDocId });
  } else {
    record("skip", { tool: "siyuan_get_doc", reason: "no doc id" });
  }

  // siyuan_get_block_info
  if (newDocId) {
    await callTool("siyuan_get_block_info", { id: newDocId });
  } else {
    record("skip", { tool: "siyuan_get_block_info", reason: "no doc id" });
  }

  // siyuan_update_block — update the document root block with new markdown
  if (newDocId) {
    await callTool("siyuan_update_block", {
      id: newDocId,
      data: `Updated by M1-DV-1 harness at ${isoStamp}`,
      dataType: "markdown",
    });
  } else {
    record("skip", { tool: "siyuan_update_block", reason: "no doc id" });
  }

  // siyuan_query_sql
  await callTool("siyuan_query_sql", {
    stmt: "SELECT DISTINCT box FROM blocks LIMIT 5",
  });

  // siyuan_trigger_kfdb_sync
  await callTool("siyuan_trigger_kfdb_sync", {});

  // siyuan_get_backlinks
  if (newDocId) {
    await callTool("siyuan_get_backlinks", { id: newDocId });
  } else {
    record("skip", { tool: "siyuan_get_backlinks", reason: "no doc id" });
  }

  // siyuan_create_cell — python cell `print(2+2)`
  let newCellId = null;
  if (newDocId) {
    const cellRes = await callTool("siyuan_create_cell", {
      doc_id: newDocId,
      language: "python",
      code: "print(2+2)",
      after: null,
    });
    try {
      const text = cellRes?.result?.content?.[0]?.text;
      if (text) {
        const parsed = JSON.parse(text);
        newCellId = parsed.cellId || parsed.cell_id || parsed.id || null;
      }
    } catch {}
    record("extract", { newCellId });
  } else {
    record("skip", { tool: "siyuan_create_cell", reason: "no doc id" });
  }

  // siyuan_run_rdm_cell
  if (newDocId && newCellId) {
    await callTool("siyuan_run_rdm_cell", {
      doc_id: newDocId,
      cell_id: newCellId,
      timeout_ms: 60000,
    });
  } else {
    record("skip", { tool: "siyuan_run_rdm_cell", reason: "no doc/cell id" });
  }

  // siyuan_read_cell_output
  if (newDocId && newCellId) {
    await callTool("siyuan_read_cell_output", {
      doc_id: newDocId,
      cell_id: newCellId,
    });
  } else {
    record("skip", { tool: "siyuan_read_cell_output", reason: "no doc/cell id" });
  }

  // Graceful shutdown
  child.stdin.end();
  setTimeout(() => child.kill(), 2000);
}

main().catch((e) => {
  record("fatal", { error: e.message, stack: e.stack });
  try { child.kill(); } catch {}
  process.exit(2);
});
