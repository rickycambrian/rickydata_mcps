import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * M3-DV-1 Bug B regression guard.
 *
 * The `bin.siyuan-mcp` entry MUST start the stdio MCP server when invoked
 * with no arguments. In 0.2.0 it pointed directly at the commander CLI,
 * which exited 1 on no-subcommand — the rickydata SDK's stdio-spawn path
 * reported that as `Process exited during startup (code: 1)`.
 *
 * These tests spawn the compiled `dist/bin.js` with no stdin TTY (same
 * shape as the SDK) and check that:
 *   - no-args launches the MCP server (stays alive, emits the expected
 *     stderr banner)
 *   - `login` / `logout` / `whoami` dispatch to the CLI (short-lived
 *     process, exits cleanly with help or status output)
 */

const BIN = join(__dirname, "..", "dist", "bin.js");

/** Spawn `node dist/bin.js <args...>` with a piped stdio (no TTY). */
function spawnBin(args: string[], opts: { killAfterMs?: number } = {}): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PATH: process.env.PATH ?? "" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.stderr.on("data", (c) => (stderr += c.toString()));
    child.stdin.end();

    let timer: NodeJS.Timeout | null = null;
    if (opts.killAfterMs) {
      timer = setTimeout(() => {
        child.kill("SIGTERM");
      }, opts.killAfterMs);
    }

    child.on("close", (exitCode, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr, exitCode, signal });
    });
  });
}

describe("bin.js dispatch (M3-DV-1 Bug B regression guard)", () => {
  it("dist/bin.js exists (build ran)", () => {
    expect(existsSync(BIN), `expected ${BIN} to exist; run npm run build`).toBe(true);
  });

  it("with no args, launches the MCP stdio server and stays alive", async () => {
    // We terminate after 1500ms — a healthy stdio server has no reason to
    // exit on its own; a crashing one would exit immediately with code 1.
    const result = await spawnBin([], { killAfterMs: 1500 });
    expect(result.stderr).toMatch(/siyuan-mcp running on stdio/);
    // Success shape: killed by our SIGTERM (exitCode null, signal SIGTERM),
    // or — on some platforms — exitCode 143 (128+15). Anything else
    // (notably exitCode 1) means the server self-exited.
    const killedByUs =
      result.signal === "SIGTERM" ||
      result.exitCode === 143 ||
      result.exitCode === 0 ||
      result.exitCode === null;
    expect(
      killedByUs,
      `server self-exited with code=${result.exitCode}; stderr=${result.stderr}`,
    ).toBe(true);
  });

  it("`login --help` runs the commander CLI and exits 0", async () => {
    const result = await spawnBin(["login", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/Usage: siyuan-mcp login/);
  });

  it("`logout` runs the commander CLI and exits cleanly", async () => {
    // logout is idempotent — no credential present → still exits 0.
    const result = await spawnBin(["logout"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/Credential removed/);
  });

  it("`whoami` runs the commander CLI (no credential → exit 1 with message)", async () => {
    // Ensure we're in a temp HOME so whoami doesn't see the developer's
    // real ~/.siyuan-mcp.
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const fakeHome = mkdtempSync(join(tmpdir(), "siyuan-mcp-whoami-"));
    const child = spawn(process.execPath, [BIN, "whoami"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome },
    });
    let stdout = "";
    let exitCode: number | null = null;
    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.stdin.end();
    await new Promise<void>((r) => child.on("close", (c) => { exitCode = c; r(); }));
    expect(stdout).toMatch(/Not logged in/);
    expect(exitCode).toBe(1);
  });

  it("`--help` prints CLI help (via commander) and exits 0", async () => {
    const result = await spawnBin(["--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/CLI for managing SiYuan MCP credentials/);
  });
});
