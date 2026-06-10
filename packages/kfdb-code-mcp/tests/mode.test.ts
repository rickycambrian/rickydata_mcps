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

const DUMMY_KEY = "ci-dummy"; // unused by tools/list + pre-network guards
const BENCH = "11111111-1111-1111-1111-111111111111";
// Bench mode WITH the explicit bench-tools key → 5 scoped tools (ego active).
const BENCH_ENV = {
  KFDB_BENCH_REPO_SCOPE: BENCH,
  KFDB_BENCH_TOOLS_API_KEY: DUMMY_KEY,
  KFDB_API_KEY: "",
};
// Bench mode WITHOUT any key → 3 public scoped tools (the pilot config).
const BENCH_ENV_NOKEY = {
  KFDB_BENCH_REPO_SCOPE: BENCH,
  KFDB_API_KEY: "",
  KFDB_BENCH_TOOLS_API_KEY: "",
};

describe("tools/list by mode + API-key gating", () => {
  it("full mode + key exposes all 7 tools incl. discovery tools", () => {
    const names = listTools({ KFDB_BENCH_REPO_SCOPE: "", KFDB_API_KEY: DUMMY_KEY });
    expect(names.length).toBe(7);
    for (const s of SCOPED) expect(names).toContain(s);
    expect(names).toContain("list_repos");
    expect(names).toContain("repo_overview");
    expect(new Set(names).size).toBe(names.length);
  });

  it("full mode WITHOUT key omits the 2 call-graph tools (5 tools)", () => {
    const names = listTools({ KFDB_BENCH_REPO_SCOPE: "", KFDB_API_KEY: "" });
    expect(names.length).toBe(5);
    expect(names).not.toContain("get_callers");
    expect(names).not.toContain("get_callees");
    expect(names).toContain("list_repos");
  });

  it("bench mode + KFDB_BENCH_TOOLS_API_KEY exposes the 5 scoped tools", () => {
    const names = listTools(BENCH_ENV);
    expect(names.sort()).toEqual([...SCOPED].sort());
    expect(names).not.toContain("list_repos");
    expect(names).not.toContain("repo_overview");
  });

  it("bench mode WITHOUT any key exposes ONLY the 3 public tools (pilot config)", () => {
    const names = listTools(BENCH_ENV_NOKEY);
    expect(names.sort()).toEqual(
      ["search_code", "find_symbol", "get_context_bundle"].sort(),
    );
    expect(names).not.toContain("get_callers");
    expect(names).not.toContain("get_callees");
  });

  // Gate B attack #7 — env-leak: a sloppy runner with ambient KFDB_API_KEY set
  // but NO explicit bench-tools key must NOT silently promote to 5 tools.
  it("bench mode IGNORES ambient KFDB_API_KEY → still exactly 3 tools", () => {
    const names = listTools({
      KFDB_BENCH_REPO_SCOPE: BENCH,
      KFDB_API_KEY: "leaked-runner-key",
      KFDB_BENCH_TOOLS_API_KEY: "",
    });
    expect(names.sort()).toEqual(
      ["search_code", "find_symbol", "get_context_bundle"].sort(),
    );
    expect(names).not.toContain("get_callers");
    expect(names).not.toContain("get_callees");
  });

  it("bench mode: ambient KFDB_API_KEY alone cannot run get_callers", () => {
    const out = callTool(
      { KFDB_BENCH_REPO_SCOPE: BENCH, KFDB_API_KEY: "leaked-runner-key" },
      "get_callers",
      { node_id: "00000000-dead-beef-0000-000000000000" },
    );
    expect(out).toMatch(/requires KFDB_BENCH_TOOLS_API_KEY/i);
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

  it("rejects a call-graph tool in bench mode when no bench-tools key is set", () => {
    const out = callTool(BENCH_ENV_NOKEY, "get_callers", {
      node_id: "00000000-dead-beef-0000-000000000000",
    });
    expect(out).toMatch(/requires KFDB_BENCH_TOOLS_API_KEY/i);
  });
});
