import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import nock from "nock";
import { buildCli } from "../src/cli.js";
import { CREDENTIAL_TOKEN_PREFIX, credentialMode, writeCredential } from "../src/credential-store.js";
import { SiyuanClient } from "../src/siyuan-client.js";

const TOKEN = `${CREDENTIAL_TOKEN_PREFIX}live-key-xyz`;
const ALT_TOKEN = `${CREDENTIAL_TOKEN_PREFIX}alt-key-aaaa`;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "siyuan-mcp-cli-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  nock.cleanAll();
  nock.enableNetConnect();
});

function collect(): { stream: NodeJS.WritableStream; read: () => string } {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on("data", (c: Buffer) => chunks.push(c));
  return {
    stream,
    read: () => Buffer.concat(chunks).toString("utf8"),
  };
}

describe("cli login", () => {
  it("writes the credential file when --token is supplied", async () => {
    const out = collect();
    const errStream = collect();
    const cli = buildCli({
      out: out.stream,
      err: errStream.stream,
      credentialDir: dir,
      readToken: async () => "",
      openBrowser: async () => {},
    });
    await cli.parseAsync(["node", "siyuan-mcp", "login", "--token", TOKEN]);
    const path = join(dir, "credentials.json");
    expect(existsSync(path)).toBe(true);
    const body = JSON.parse(readFileSync(path, "utf8"));
    expect(body.token).toBe(TOKEN);
    expect(credentialMode({ dir })).toBe(0o600);
    expect(out.read()).toMatch(/Credential saved/);
  });

  it("rejects tokens missing the siymcp_v1_ prefix", async () => {
    const out = collect();
    const errStream = collect();
    const cli = buildCli({
      out: out.stream,
      err: errStream.stream,
      credentialDir: dir,
      readToken: async () => "",
      openBrowser: async () => {},
    });
    const prevCode = process.exitCode;
    process.exitCode = 0;
    await cli.parseAsync(["node", "siyuan-mcp", "login", "--token", "bogus"]);
    expect(process.exitCode).toBe(1);
    process.exitCode = prevCode;
    expect(errStream.read()).toMatch(/must start with 'siymcp_v1_'/);
    expect(existsSync(join(dir, "credentials.json"))).toBe(false);
  });

  it("prompts the user when --token is omitted", async () => {
    const out = collect();
    const errStream = collect();
    const cli = buildCli({
      out: out.stream,
      err: errStream.stream,
      credentialDir: dir,
      readToken: async () => TOKEN,
      openBrowser: async () => {},
      loginUrl: "http://pairing.test/auth/cli",
    });
    await cli.parseAsync(["node", "siyuan-mcp", "login", "--no-open"]);
    const body = JSON.parse(readFileSync(join(dir, "credentials.json"), "utf8"));
    expect(body.token).toBe(TOKEN);
    expect(errStream.read()).toMatch(/pairing\.test\/auth\/cli/);
  });
});

describe("cli logout", () => {
  it("removes the credential file", async () => {
    writeCredential({ token: TOKEN }, { dir });
    const out = collect();
    const cli = buildCli({
      out: out.stream,
      err: collect().stream,
      credentialDir: dir,
      readToken: async () => "",
      openBrowser: async () => {},
    });
    await cli.parseAsync(["node", "siyuan-mcp", "logout"]);
    expect(existsSync(join(dir, "credentials.json"))).toBe(false);
    expect(out.read()).toMatch(/Credential removed/);
  });

  it("is a no-op when the credential is already absent", async () => {
    const out = collect();
    const cli = buildCli({
      out: out.stream,
      err: collect().stream,
      credentialDir: dir,
      readToken: async () => "",
      openBrowser: async () => {},
    });
    await cli.parseAsync(["node", "siyuan-mcp", "logout"]);
    expect(out.read()).toMatch(/Credential removed/);
  });
});

describe("cli whoami", () => {
  it("prints wallet address when /api/auth/wallet/status returns one", async () => {
    writeCredential({ token: TOKEN }, { dir });
    const scope = nock("https://siyuan.test")
      .get("/api/auth/wallet/status")
      .query(true)
      .reply(200, { code: 0, msg: "", data: { address: "0xabc" } });

    const out = collect();
    const errStream = collect();
    const client = new SiyuanClient({ baseUrl: "https://siyuan.test", apiKey: "fake" });
    const cli = buildCli({
      out: out.stream,
      err: errStream.stream,
      credentialDir: dir,
      readToken: async () => "",
      openBrowser: async () => {},
      makeClient: () => client,
    });
    await cli.parseAsync(["node", "siyuan-mcp", "whoami"]);
    const s = out.read();
    expect(s).toMatch(/wallet:.*0xabc/);
    expect(s).toMatch(/tokenPrefix: siymcp_v1_…/);
    scope.done();
  });

  it("exits with status 1 when no credential is stored", async () => {
    const out = collect();
    const errStream = collect();
    const prevCode = process.exitCode;
    process.exitCode = 0;
    const cli = buildCli({
      out: out.stream,
      err: errStream.stream,
      credentialDir: dir,
      readToken: async () => "",
      openBrowser: async () => {},
    });
    await cli.parseAsync(["node", "siyuan-mcp", "whoami"]);
    expect(process.exitCode).toBe(1);
    process.exitCode = prevCode;
    expect(out.read()).toMatch(/Not logged in/);
  });
});

describe("credential atomicity", () => {
  it("concurrent writes never leave a partial file on disk", async () => {
    // Drive many concurrent writes; after each round the file must contain a
    // COMPLETE JSON body with one of the tokens we wrote. This exercises the
    // PID-tempfile + rename path: if we ever wrote the final file in place
    // (without rename), an interrupted write could leak half a JSON object.
    const tokens = [TOKEN, ALT_TOKEN];
    const errors: unknown[] = [];

    await Promise.all(
      Array.from({ length: 32 }, (_, i) =>
        Promise.resolve().then(() => {
          try {
            writeCredential({ token: tokens[i % tokens.length] }, { dir });
          } catch (e) {
            errors.push(e);
          }
        }),
      ),
    );

    expect(errors).toEqual([]);
    const raw = readFileSync(join(dir, "credentials.json"), "utf8");
    const parsed = JSON.parse(raw) as { token: string };
    expect(tokens).toContain(parsed.token);
    expect(credentialMode({ dir })).toBe(0o600);
  });

  it("never leaves a tempfile sibling after a successful write", async () => {
    writeCredential({ token: TOKEN }, { dir });
    const { readdirSync } = await import("node:fs");
    const leftover = readdirSync(dir).filter((f) => f.endsWith(".tmp"));
    expect(leftover).toEqual([]);
  });

  it("a crash mid-write (simulated) does not corrupt the live file", () => {
    writeCredential({ token: TOKEN }, { dir });

    // Simulate an abandoned tempfile from a prior crashed write.
    const sibling = join(dir, "credentials.json.99999.tmp");
    writeFileSync(sibling, "{not json"); // partial

    // A subsequent successful write must replace the live file without
    // reading that tempfile.
    writeCredential({ token: ALT_TOKEN }, { dir });
    const body = JSON.parse(readFileSync(join(dir, "credentials.json"), "utf8"));
    expect(body.token).toBe(ALT_TOKEN);
  });
});
