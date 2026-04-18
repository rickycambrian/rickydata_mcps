#!/usr/bin/env node
import { Command } from "commander";
import {
  CREDENTIAL_TOKEN_PREFIX,
  assertValidToken,
  credentialPath,
  deleteCredential,
  readCredential,
  writeCredential,
} from "./credential-store.js";
import { DEFAULT_SIYUAN_URL } from "./auth.js";
import { SiyuanClient } from "./siyuan-client.js";

const DEFAULT_LOGIN_URL = `${DEFAULT_SIYUAN_URL}/auth/cli`;

/**
 * Prompt the user for a secret token on stdin. In a TTY we echo `*` per
 * character so the user sees typing feedback without leaking the token; in
 * non-TTY mode we fall back to a plain `readline` read so `printf "..." |
 * siyuan-mcp login` works for scripting.
 */
async function promptSecret(prompt: string): Promise<string> {
  const { default: readline } = await import("node:readline");

  return new Promise((resolve) => {
    process.stderr.write(prompt);

    if (!process.stdin.isTTY) {
      const rl = readline.createInterface({ input: process.stdin });
      rl.question("", (answer) => {
        rl.close();
        resolve(answer.trim());
      });
      return;
    }

    const chars: string[] = [];
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");

    const onData = (chunk: string) => {
      for (const ch of chunk) {
        const code = ch.charCodeAt(0);
        if (ch === "\r" || ch === "\n") {
          process.stdin.setRawMode?.(false);
          process.stdin.pause();
          process.stdin.removeListener("data", onData);
          process.stderr.write("\n");
          resolve(chars.join("").trim());
          return;
        }
        if (code === 3) {
          // Ctrl+C
          process.stdin.setRawMode?.(false);
          process.stdin.pause();
          process.stdin.removeListener("data", onData);
          process.exit(130);
        }
        if (code === 127 || code === 8) {
          if (chars.length > 0) {
            chars.pop();
            process.stderr.write("\b \b");
          }
        } else if (code >= 32) {
          chars.push(ch);
          process.stderr.write("*");
        }
      }
    };
    process.stdin.on("data", onData);
  });
}

export interface CliDeps {
  /** Injectable stdout/stderr for tests. Defaults to process.stdout/stderr. */
  out?: NodeJS.WritableStream;
  err?: NodeJS.WritableStream;
  /** Read a secret string from the user. Defaults to `promptSecret`. */
  readToken?: (prompt: string) => Promise<string>;
  /** Open a URL in the user's browser. Defaults to `open`. */
  openBrowser?: (url: string) => Promise<void>;
  /** Override the credential dir (tests). */
  credentialDir?: string;
  /** Override the login URL (tests / private deployments). */
  loginUrl?: string;
  /** Build a SiyuanClient for `whoami` (tests). */
  makeClient?: () => SiyuanClient;
}

function writeln(stream: NodeJS.WritableStream, line = ""): void {
  stream.write(line + "\n");
}

export function buildCli(deps: CliDeps = {}): Command {
  const out = deps.out ?? process.stdout;
  const err = deps.err ?? process.stderr;
  const readToken = deps.readToken ?? promptSecret;
  const openBrowser =
    deps.openBrowser ??
    (async (url: string) => {
      const { default: open } = await import("open");
      await open(url);
    });
  const credentialOptions = deps.credentialDir ? { dir: deps.credentialDir } : undefined;
  const loginUrl = deps.loginUrl ?? DEFAULT_LOGIN_URL;

  const program = new Command("siyuan-mcp");
  program.description("CLI for managing SiYuan MCP credentials.");

  program
    .command("login")
    .description(
      `Pair with SiYuan via paste-back flow. Opens ${loginUrl} in your browser; paste the token it displays.`,
    )
    .option("--token <token>", "Skip the browser and pass the siymcp_v1_ token directly.")
    .option("--no-open", "Do not attempt to open a browser; print the URL and wait for paste.")
    .action(async (opts: { token?: string; open?: boolean }) => {
      let raw = opts.token;
      if (!raw) {
        writeln(err, `Opening ${loginUrl} in your browser...`);
        if (opts.open !== false) {
          try {
            await openBrowser(loginUrl);
          } catch {
            writeln(err, "Could not open the browser automatically.");
          }
        }
        writeln(err, `If the browser does not open, visit: ${loginUrl}`);
        raw = await readToken("Paste the token (starts with 'siymcp_v1_'): ");
      }

      if (!raw) {
        writeln(err, "No token provided. Aborting.");
        process.exitCode = 1;
        return;
      }

      try {
        assertValidToken(raw);
      } catch (e) {
        writeln(err, `Invalid token: ${(e as Error).message}`);
        process.exitCode = 1;
        return;
      }

      const saved = writeCredential({ token: raw }, credentialOptions);
      writeln(out, "Credential saved.");
      writeln(out, `  path:    ${credentialPath(credentialOptions)}`);
      writeln(out, `  savedAt: ${saved.savedAt}`);
    });

  program
    .command("logout")
    .description("Delete the stored credential file.")
    .action(() => {
      deleteCredential(credentialOptions);
      writeln(out, "Credential removed.");
      writeln(out, `  path: ${credentialPath(credentialOptions)}`);
    });

  program
    .command("whoami")
    .description("Print the wallet address associated with the current credential.")
    .action(async () => {
      const record = readCredential(credentialOptions);
      if (!record) {
        writeln(out, "Not logged in. Run `siyuan-mcp login` first.");
        process.exitCode = 1;
        return;
      }

      writeln(out, `Credential present at ${credentialPath(credentialOptions)}`);
      writeln(out, `  savedAt: ${record.savedAt}`);
      if (record.label) writeln(out, `  label:   ${record.label}`);
      writeln(out, `  tokenPrefix: ${CREDENTIAL_TOKEN_PREFIX}…`);

      const client = (deps.makeClient?.() ?? new SiyuanClient({ credentialOptions }));
      try {
        const status = await client.get<{ address?: string; [k: string]: unknown }>(
          "/api/auth/wallet/status",
        );
        if (status?.address) {
          writeln(out, `  wallet:  ${status.address}`);
        } else {
          writeln(out, "  wallet:  <not returned by /api/auth/wallet/status>");
        }
      } catch (e) {
        writeln(err, `Could not reach /api/auth/wallet/status: ${(e as Error).message}`);
        process.exitCode = 2;
      }
    });

  return program;
}

/**
 * Run the CLI against `process.argv`. Exported so `bin/siyuan-mcp` can be a
 * one-liner shim.
 */
export async function runCli(argv = process.argv): Promise<void> {
  const program = buildCli();
  await program.parseAsync(argv);
}

const invokedAsMain =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] &&
  (process.argv[1].endsWith("cli.js") ||
    process.argv[1].endsWith("siyuan-mcp") ||
    process.argv[1].endsWith("cli.ts"));

if (invokedAsMain) {
  runCli().catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    process.exit(1);
  });
}
