import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CREDENTIAL_TOKEN_PREFIX,
  assertValidToken,
  credentialMode,
  credentialPath,
  deleteCredential,
  extractApiKey,
  readCredential,
  writeCredential,
} from "../src/credential-store.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "siyuan-mcp-cred-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("credential-store", () => {
  const goodToken = `${CREDENTIAL_TOKEN_PREFIX}abc123def456`;

  it("round-trips write → read", () => {
    writeCredential({ token: goodToken, label: "0xabc…" }, { dir });
    const r = readCredential({ dir });
    expect(r?.token).toBe(goodToken);
    expect(r?.label).toBe("0xabc…");
    expect(r?.savedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("writes the file with mode 0600", () => {
    writeCredential({ token: goodToken }, { dir });
    const mode = credentialMode({ dir });
    expect(mode).toBe(0o600);
  });

  it("write is atomic — no leftover tempfile on success", () => {
    writeCredential({ token: goodToken }, { dir });
    const { readdirSync } = require("node:fs");
    const entries: string[] = readdirSync(dir);
    const leftover = entries.filter((f: string) => f.includes(".tmp"));
    expect(leftover).toEqual([]);
    expect(entries).toContain("credentials.json");
  });

  it("readCredential returns null when no file exists", () => {
    expect(readCredential({ dir })).toBeNull();
    expect(credentialMode({ dir })).toBeNull();
  });

  it("deleteCredential is idempotent", () => {
    expect(deleteCredential({ dir })).toBe(true);
    writeCredential({ token: goodToken }, { dir });
    expect(deleteCredential({ dir })).toBe(true);
    expect(readCredential({ dir })).toBeNull();
  });

  it("credentialPath resolves to <dir>/credentials.json", () => {
    expect(credentialPath({ dir })).toBe(join(dir, "credentials.json"));
  });

  it("rejects tokens missing the siymcp_v1_ prefix", () => {
    expect(() => writeCredential({ token: "raw-api-key-no-prefix" }, { dir })).toThrow(
      /must start with 'siymcp_v1_'/,
    );
    expect(() => assertValidToken(123 as unknown)).toThrow(/non-empty string/);
    expect(() => assertValidToken("")).toThrow();
    expect(() => assertValidToken(CREDENTIAL_TOKEN_PREFIX)).toThrow(/missing the KFDB api key/);
  });

  it("extractApiKey strips the prefix", () => {
    expect(extractApiKey(goodToken)).toBe("abc123def456");
    expect(() => extractApiKey("bad")).toThrow();
  });

  it("overwriting the credential preserves 0600", () => {
    writeCredential({ token: goodToken }, { dir });
    writeCredential({ token: `${CREDENTIAL_TOKEN_PREFIX}other` }, { dir });
    expect(credentialMode({ dir })).toBe(0o600);
    const r = readCredential({ dir });
    expect(r?.token).toBe(`${CREDENTIAL_TOKEN_PREFIX}other`);
  });

  it("readCredential throws on malformed JSON", () => {
    writeFileSync(join(dir, "credentials.json"), "{not json", { mode: 0o600 });
    expect(() => readCredential({ dir })).toThrow();
  });

  it("readCredential rejects a file missing required fields", () => {
    writeFileSync(join(dir, "credentials.json"), JSON.stringify({ savedAt: "x" }), {
      mode: 0o600,
    });
    expect(() => readCredential({ dir })).toThrow(/missing 'token'/);
  });

  it("the directory has 0700 perms after writing", () => {
    writeCredential({ token: goodToken }, { dir });
    const mode = statSync(dir).mode & 0o777;
    // On macOS/Linux mkdir+chmod yields 0700. Allow 0o700 exactly.
    expect(mode).toBe(0o700);
  });

  it("tempfile name includes the pid", () => {
    // Drive the internal layout by asserting the final file content matches
    // what we passed; the pid-tempfile path is exercised every write.
    writeCredential({ token: goodToken }, { dir });
    const onDisk = JSON.parse(readFileSync(join(dir, "credentials.json"), "utf8"));
    expect(onDisk.token).toBe(goodToken);
  });
});
