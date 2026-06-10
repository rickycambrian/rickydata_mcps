import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, "..", "src", "index.ts");

// Drive the server over stdio with an initialize + tools/list and return the
// list of tool names. Env controls bench vs full mode. We point KFDB_API_URL at
// an unreachable host so no network call is attempted by tools/list (it isn't).
function listTools(env: Record<string, string>): string[] {
  const init =
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0"}}}';
  const list = '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}';
  const res = spawnSync(
    process.execPath,
    ["--import", "tsx", entry],
    {
      input: `${init}\n${list}\n`,
      encoding: "utf8",
      env: { ...process.env, KFDB_API_URL: "http://127.0.0.1:1", ...env },
      timeout: 25_000,
    },
  );
  const names: string[] = [];
  for (const line of (res.stdout || "").split("\n")) {
    if (!line.trim()) continue;
    let obj: { id?: number; result?: { tools?: Array<{ name: string }> } };
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.id === 2 && obj.result?.tools) {
      for (const t of obj.result.tools) names.push(t.name);
    }
  }
  return names;
}

// Drive a single tool call over stdio and return the parsed result text.
// KFDB_API_URL points at an unreachable host; tests here exercise only the
// pre-network guard paths (allowlist / type checks) which return before fetch.
function callTool(
  env: Record<string, string>,
  toolName: string,
  args: Record<string, unknown>,
): string {
  const init =
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0"}}}';
  const call = JSON.stringify({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: toolName, arguments: args },
  });
  const res = spawnSync(process.execPath, ["--import", "tsx", entry], {
    input: `${init}\n${call}\n`,
    encoding: "utf8",
    env: { ...process.env, KFDB_API_URL: "http://127.0.0.1:1", ...env },
    timeout: 25_000,
  });
  for (const line of (res.stdout || "").split("\n")) {
    if (!line.trim()) continue;
    let obj: { id?: number; result?: { content?: Array<{ text: string }> } };
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.id === 3 && obj.result?.content?.[0]) {
      return obj.result.content[0].text;
    }
  }
  return "";
}

const SCOPED = [
  "search_code",
  "find_symbol",
  "get_callers",
  "get_callees",
  "get_context_bundle",
];

const BENCH_ENV = {
  KFDB_BENCH_REPO_SCOPE: "11111111-1111-1111-1111-111111111111",
};

describe("tools/list by mode", () => {
  it("full mode exposes all 7 tools incl. discovery tools", () => {
    const names = listTools({ KFDB_BENCH_REPO_SCOPE: "" });
    expect(names.length).toBe(7);
    for (const s of SCOPED) expect(names).toContain(s);
    expect(names).toContain("list_repos");
    expect(names).toContain("repo_overview");
    expect(new Set(names).size).toBe(names.length);
  });

  it("bench mode exposes ONLY the 5 scoped tools (no list_repos / repo_overview)", () => {
    const names = listTools({
      KFDB_BENCH_REPO_SCOPE: "11111111-1111-1111-1111-111111111111",
    });
    expect(names.sort()).toEqual([...SCOPED].sort());
    expect(names).not.toContain("list_repos");
    expect(names).not.toContain("repo_overview");
  });
});

describe("bench-mode guards (pre-network, red-team vectors)", () => {
  it("rejects a discovery tool dispatched directly in bench mode", () => {
    const out = callTool(BENCH_ENV, "list_repos", { limit: 5 });
    expect(out).toMatch(/not available in bench mode/i);
  });

  it("rejects an ego seed not previously returned by a scoped call", () => {
    const out = callTool(BENCH_ENV, "get_callers", {
      node_id: "00000000-dead-beef-0000-000000000000",
    });
    expect(out).toMatch(/node_id not permitted/i);
  });

  it("rejects a non-string ego seed (array injection) before any upstream call", () => {
    const out = callTool(BENCH_ENV, "get_callers", {
      node_id: ["a", "b"],
    });
    expect(out).toMatch(/must be a string/i);
  });

  it("rejects an object ego seed before any upstream call", () => {
    const out = callTool(BENCH_ENV, "get_callees", {
      node_id: { malicious: true },
    });
    expect(out).toMatch(/must be a string/i);
  });
});
