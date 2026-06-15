import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, "..", "src", "index.ts");

// Env that guarantees NO session is picked up (so calls hit the not_connected
// guard, and tools/list never touches the network).
const NO_SESSION = {
  NOTEBOOKLM_COOKIES: "",
  NOTEBOOKLM_STATE_B64: "",
  NOTEBOOKLM_STATE_PATH: "/nonexistent/notebooklm/state.json",
};

function driveStdio(messages: string[], env: Record<string, string>): string[] {
  const res = spawnSync(process.execPath, ["--import", "tsx", entry], {
    input: messages.join("\n") + "\n",
    encoding: "utf8",
    env: { ...process.env, ...NO_SESSION, ...env },
    timeout: 25_000,
  });
  return (res.stdout || "").split("\n").filter((l) => l.trim());
}

const INIT =
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0"}}}';

function listTools(): string[] {
  const list = '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}';
  const names: string[] = [];
  for (const line of driveStdio([INIT, list], {})) {
    let obj: { id?: number; result?: { tools?: Array<{ name: string }> } };
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.id === 2 && obj.result?.tools) for (const t of obj.result.tools) names.push(t.name);
  }
  return names;
}

function callTool(name: string, args: Record<string, unknown>): string {
  const call = JSON.stringify({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name, arguments: args },
  });
  for (const line of driveStdio([INIT, call], {})) {
    let obj: { id?: number; result?: { content?: Array<{ text: string }> } };
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.id === 3 && obj.result?.content?.[0]) return obj.result.content[0].text;
  }
  return "";
}

describe("tools/list — only captured actions are exposed", () => {
  it("exposes exactly the captured tool set, in definition order", () => {
    const names = listTools();
    expect(names).toEqual(["add_source", "generate_audio", "get_audio_status", "download_audio"]);
  });
  it("omits uncaptured actions", () => {
    const names = listTools();
    for (const a of ["create_notebook", "list_notebooks", "ask_question"]) {
      expect(names).not.toContain(a);
    }
  });
});

describe("tools/call gating", () => {
  it("an uncaptured tool returns a clear not-available error", () => {
    const out = callTool("create_notebook", { title: "x" });
    expect(out).toMatch(/not available yet|rpcid not captured/i);
  });

  it("download_audio with no session returns the actionable not_connected error", () => {
    const out = callTool("download_audio", { notebook_id: "nb-1" });
    expect(out).toMatch(/Not connected|run .*connect/i);
    expect(out).toMatch(/NotConnectedError/);
  });
});
