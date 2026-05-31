import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

export interface RickygitResult {
  success: boolean;
  exit_code: number | null;
  /** Parsed `--json` stdout when rickygit emitted JSON, else null. */
  json: unknown;
  stdout: string;
  stderr: string;
}

/**
 * Resolve the `rickygit` binary:
 *   1. RICKYGIT_BIN env var (explicit override)
 *   2. a sibling rickydata_git checkout's release/debug build
 *   3. bare `rickygit` on PATH
 */
export function resolveRickygitBin(): string {
  const fromEnv = process.env.RICKYGIT_BIN;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;

  const siblingGuesses = [
    path.resolve(process.cwd(), '../../../rickydata_git/target/release/rickygit'),
    path.resolve(process.cwd(), '../../../rickydata_git/target/debug/rickygit'),
    path.resolve(process.env.HOME ?? '', 'Documents/github/rickydata_git/target/release/rickygit'),
    path.resolve(process.env.HOME ?? '', 'Documents/github/rickydata_git/target/debug/rickygit'),
  ];
  for (const guess of siblingGuesses) {
    if (existsSync(guess)) return guess;
  }
  return 'rickygit';
}

/** Default repository the tools operate on: RICKYGIT_REPO or the process cwd. */
export function defaultRepo(): string {
  return process.env.RICKYGIT_REPO || process.cwd();
}

/** Default relay URL for sync/relay tools. */
export function defaultRelayUrl(): string | undefined {
  return process.env.RICKYDATA_GIT_RELAY_URL || undefined;
}

/**
 * Invoke rickygit with the given argv. Always reads stdout and attempts to
 * parse it as JSON (every rickygit command supports `--json`). Never rejects on
 * a non-zero exit; the caller inspects `success`.
 */
export function runRickygit(
  args: string[],
  options: { timeoutMs?: number; bin?: string } = {},
): Promise<RickygitResult> {
  const bin = options.bin ?? resolveRickygitBin();
  const timeoutMs = options.timeoutMs ?? 120_000;

  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      if (!settled) {
        settled = true;
        resolve({
          success: false,
          exit_code: null,
          json: null,
          stdout,
          stderr: `${stderr}\nrickygit timed out after ${timeoutMs}ms`,
        });
      }
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve({
        success: false,
        exit_code: null,
        json: null,
        stdout,
        stderr: `${stderr}\nfailed to spawn rickygit (${bin}): ${String(error)}`,
      });
    });
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      let json: unknown = null;
      const trimmed = stdout.trim();
      if (trimmed.length > 0) {
        try {
          json = JSON.parse(trimmed);
        } catch {
          json = null;
        }
      }
      resolve({
        success: exitCode === 0,
        exit_code: exitCode,
        json,
        stdout,
        stderr,
      });
    });
  });
}
