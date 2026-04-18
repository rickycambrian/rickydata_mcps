import { describe, it, expect, beforeEach, afterEach } from "vitest";
import nock from "nock";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_SIYUAN_URL,
  exchangeJwtForApiKey,
  resetJwtExchangeCache,
  resolveToken,
} from "../src/auth.js";
import { CREDENTIAL_TOKEN_PREFIX, writeCredential } from "../src/credential-store.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "siyuan-mcp-auth-"));
  resetJwtExchangeCache();
  nock.disableNetConnect();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  nock.cleanAll();
  nock.enableNetConnect();
});

describe("resolveToken", () => {
  it("prefers SIYUAN_KFDB_TOKEN when set", async () => {
    const got = await resolveToken({
      env: { SIYUAN_KFDB_TOKEN: "raw-key" } as NodeJS.ProcessEnv,
      credentialOptions: { dir },
    });
    expect(got).toEqual({ apiKey: "raw-key", source: "env:SIYUAN_KFDB_TOKEN" });
  });

  it("trims whitespace on SIYUAN_KFDB_TOKEN", async () => {
    const got = await resolveToken({
      env: { SIYUAN_KFDB_TOKEN: "  padded-key  \n" } as NodeJS.ProcessEnv,
      credentialOptions: { dir },
    });
    expect(got.apiKey).toBe("padded-key");
  });

  it("falls through to SIYUAN_KFDB_JWT when raw token is empty", async () => {
    nock(DEFAULT_SIYUAN_URL)
      .post("/api/auth/kfdb/token", { token: "jwt-value" })
      .reply(200, { code: 0, msg: "", data: { token: "derived-key" } });

    const got = await resolveToken({
      env: {
        SIYUAN_KFDB_TOKEN: "",
        SIYUAN_KFDB_JWT: "jwt-value",
      } as NodeJS.ProcessEnv,
      credentialOptions: { dir },
    });
    expect(got).toEqual({ apiKey: "derived-key", source: "env:SIYUAN_KFDB_JWT" });
  });

  it("falls through to the credential file when no env vars are set", async () => {
    writeCredential({ token: `${CREDENTIAL_TOKEN_PREFIX}filekey` }, { dir });
    const got = await resolveToken({
      env: {} as NodeJS.ProcessEnv,
      credentialOptions: { dir },
    });
    expect(got).toEqual({ apiKey: "filekey", source: "credential-file" });
  });

  it("throws a descriptive error when nothing is configured", async () => {
    await expect(
      resolveToken({ env: {} as NodeJS.ProcessEnv, credentialOptions: { dir } }),
    ).rejects.toThrow(/no SiYuan auth credential found/);
  });
});

describe("exchangeJwtForApiKey", () => {
  it("exchanges the JWT, caches the derived key in-memory, and never leaks the JWT", async () => {
    const scope = nock(DEFAULT_SIYUAN_URL)
      .post("/api/auth/kfdb/token", { token: "the-jwt" })
      .reply(200, { code: 0, msg: "", data: { token: "api-key-xyz" } });

    const first = await exchangeJwtForApiKey("the-jwt");
    expect(first).toBe("api-key-xyz");
    scope.done();

    // Second call should be cached — no additional HTTP mock needed.
    const second = await exchangeJwtForApiKey("the-jwt");
    expect(second).toBe("api-key-xyz");
  });

  it("accepts the api_key alias in the response body", async () => {
    nock(DEFAULT_SIYUAN_URL)
      .post("/api/auth/kfdb/token")
      .reply(200, { code: 0, msg: "", data: { api_key: "alias-key" } });

    expect(await exchangeJwtForApiKey("jwt-alias")).toBe("alias-key");
  });

  it("throws when the response is non-2xx, without leaking the JWT", async () => {
    nock(DEFAULT_SIYUAN_URL).post("/api/auth/kfdb/token").reply(401, "nope");

    const jwt = "super-secret-jwt";
    let caught: unknown;
    try {
      await exchangeJwtForApiKey(jwt);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const e = caught as Error;
    expect(e.message).toMatch(/401/);
    expect(e.message).not.toContain(jwt);
  });

  it("throws when the envelope code is non-zero", async () => {
    nock(DEFAULT_SIYUAN_URL)
      .post("/api/auth/kfdb/token")
      .reply(200, { code: -1, msg: "invalid token", data: null });

    await expect(exchangeJwtForApiKey("bad-jwt")).rejects.toThrow(/code=-1.*invalid token/);
  });

  it("throws when response is missing the api key", async () => {
    nock(DEFAULT_SIYUAN_URL)
      .post("/api/auth/kfdb/token")
      .reply(200, { code: 0, msg: "", data: {} });

    await expect(exchangeJwtForApiKey("jwt-no-key")).rejects.toThrow(/missing api key/);
  });

  it("throws when response body is not JSON", async () => {
    nock(DEFAULT_SIYUAN_URL).post("/api/auth/kfdb/token").reply(200, "<html>");
    await expect(exchangeJwtForApiKey("jwt-html")).rejects.toThrow(/not JSON/);
  });

  it("rejects an empty JWT before making any HTTP request", async () => {
    await expect(exchangeJwtForApiKey("")).rejects.toThrow(/empty/);
  });

  it("respects a custom siyuanUrl", async () => {
    nock("https://alt.siyuan.test")
      .post("/api/auth/kfdb/token")
      .reply(200, { code: 0, msg: "", data: { token: "alt-key" } });

    const got = await exchangeJwtForApiKey("custom-jwt", {
      siyuanUrl: "https://alt.siyuan.test",
    });
    expect(got).toBe("alt-key");
  });
});
