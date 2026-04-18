#!/usr/bin/env node
/**
 * Dispatch entry point for the `siyuan-mcp` bin.
 *
 * The SDK's stdio-spawn path invokes `npx -y @rickydata/siyuan-mcp@<version>`
 * with no arguments and expects the MCP server to start speaking on stdio.
 * The CLI (`login` / `logout` / `whoami`) is a separate UX for end users
 * pairing a local credential. We resolve the mode at startup:
 *
 *   - If argv[2] matches a known CLI subcommand, run the commander program
 *     from `./cli.js`.
 *   - Otherwise, start the MCP server by importing `./index.js` — whose
 *     top-level `main()` call starts stdio (or HTTP when TRANSPORT=http).
 *
 * This matches the convention of sibling MCPs in this monorepo
 * (rickydata-mcp, agent0-mcp, research-papers-mcp) where `npx <pkg>` always
 * launches the server, while still letting humans type `npx <pkg> login`.
 *
 * Regression fix: in 0.2.0 `bin.siyuan-mcp` pointed directly at `cli.js`, so
 * `npx` ran commander with no subcommand, which printed help and exited 1.
 * The rickydata SDK reported that as `Process exited during startup (code: 1)`
 * (M3-DV-1, Bug B). Since 0.2.1, `bin.siyuan-mcp` points here instead.
 */
const CLI_SUBCOMMANDS = new Set([
  "login",
  "logout",
  "whoami",
  "help",
  "--help",
  "-h",
]);

const firstArg = process.argv[2];

async function main(): Promise<void> {
  if (firstArg && CLI_SUBCOMMANDS.has(firstArg)) {
    // Explicitly invoke the CLI. We don't rely on cli.js's own
    // `invokedAsMain` side-effect because `process.argv[1]` here is `bin.js`,
    // not `cli.js`, so the guard would skip the auto-run branch.
    const { runCli } = await import("./cli.js");
    await runCli();
    return;
  }

  // Default: start the MCP server. `./index.js` calls `main()` at
  // module-eval time, so importing it is sufficient to start stdio (or
  // HTTP if TRANSPORT=http / PORT is set).
  await import("./index.js");
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
