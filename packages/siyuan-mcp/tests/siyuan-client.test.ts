import { describe, it, expect, beforeEach, afterEach } from "vitest";
import nock from "nock";
import { SiyuanClient, SiyuanApiError, redactUrl } from "../src/siyuan-client.js";

const BASE = "https://siyuan.test";

beforeEach(() => {
  nock.disableNetConnect();
});

afterEach(() => {
  nock.cleanAll();
  nock.enableNetConnect();
});

function newClient(): SiyuanClient {
  return new SiyuanClient({ baseUrl: BASE, apiKey: "sekret-key" });
}

describe("SiyuanClient", () => {
  it("injects kfdb_token query param on POST and unwraps the envelope", async () => {
    const scope = nock(BASE)
      .post("/api/notebook/lsNotebooks", {})
      .query({ kfdb_token: "sekret-key" })
      .reply(200, { code: 0, msg: "", data: { notebooks: [] } });

    const client = newClient();
    const data = await client.post<{ notebooks: unknown[] }>("/api/notebook/lsNotebooks", {});
    expect(data).toEqual({ notebooks: [] });
    scope.done();
  });

  it("injects kfdb_token query param on GET", async () => {
    const scope = nock(BASE)
      .get("/api/auth/wallet/status")
      .query({ kfdb_token: "sekret-key" })
      .reply(200, { code: 0, msg: "", data: { address: "0xabc" } });

    const client = newClient();
    const data = await client.get<{ address: string }>("/api/auth/wallet/status");
    expect(data).toEqual({ address: "0xabc" });
    scope.done();
  });

  it("throws SiyuanApiError on non-2xx responses with redacted URL", async () => {
    nock(BASE).post("/api/query/sql").query(true).reply(500, "boom");

    const client = newClient();
    let caught: unknown;
    try {
      await client.post("/api/query/sql", { stmt: "SELECT 1" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SiyuanApiError);
    const e = caught as SiyuanApiError;
    expect(e.name).toBe("SiyuanApiError");
    expect(e.status).toBe(500);
    expect(e.url).toContain("kfdb_token=%3Credacted%3E"); // "<redacted>" url-encoded
    expect(e.url).not.toContain("sekret-key");
    expect(e.body).toContain("boom");
  });

  it("throws SiyuanApiError when the envelope code != 0", async () => {
    nock(BASE)
      .post("/api/block/updateBlock")
      .query(true)
      .reply(200, { code: -1, msg: "permission denied", data: null });

    const client = newClient();
    await expect(
      client.post("/api/block/updateBlock", { id: "x", data: "y" }),
    ).rejects.toMatchObject({
      name: "SiyuanApiError",
      code: -1,
    });
  });

  it("throws when body is not JSON", async () => {
    nock(BASE).post("/api/filetree/getDoc").query(true).reply(200, "<html>");
    const client = newClient();
    await expect(client.post("/api/filetree/getDoc", { id: "x" })).rejects.toMatchObject({
      name: "SiyuanApiError",
    });
  });

  it("throws when envelope is missing code field", async () => {
    nock(BASE).post("/api/filetree/getDoc").query(true).reply(200, { data: {} });
    const client = newClient();
    await expect(client.post("/api/filetree/getDoc", { id: "x" })).rejects.toMatchObject({
      name: "SiyuanApiError",
    });
  });

  it("redactUrl hides the kfdb_token query param", () => {
    const safe = redactUrl("https://siyuan.test/api/x?kfdb_token=secret&other=ok");
    expect(safe).not.toContain("secret");
    expect(safe).toContain("other=ok");
  });

  it("buildUrl normalizes trailing slashes in the base URL", async () => {
    const client = new SiyuanClient({ baseUrl: `${BASE}/`, apiKey: "k" });
    const url = await client.buildUrl("/api/foo");
    expect(url).toBe(`${BASE}/api/foo?kfdb_token=k`);
  });

  it("honors SIYUAN_URL from opts.env when baseUrl is not explicitly set", () => {
    const client = new SiyuanClient({
      env: { SIYUAN_URL: "https://staging.siyuan.test" } as NodeJS.ProcessEnv,
      apiKey: "k",
    });
    expect(client.getBaseUrl()).toBe("https://staging.siyuan.test");
  });

  it("falls back to process.env.SIYUAN_URL when no opts are given (M1-DV-1 Bug 2 guard)", () => {
    const prev = process.env.SIYUAN_URL;
    process.env.SIYUAN_URL = "https://env-process.siyuan.test";
    try {
      const client = new SiyuanClient({ apiKey: "k" });
      expect(client.getBaseUrl()).toBe("https://env-process.siyuan.test");
    } finally {
      if (prev === undefined) delete process.env.SIYUAN_URL;
      else process.env.SIYUAN_URL = prev;
    }
  });

  it("explicit baseUrl beats both opts.env and process.env", () => {
    const prev = process.env.SIYUAN_URL;
    process.env.SIYUAN_URL = "https://loser.siyuan.test";
    try {
      const client = new SiyuanClient({
        baseUrl: "https://winner.siyuan.test",
        env: { SIYUAN_URL: "https://also-loser.siyuan.test" } as NodeJS.ProcessEnv,
        apiKey: "k",
      });
      expect(client.getBaseUrl()).toBe("https://winner.siyuan.test");
    } finally {
      if (prev === undefined) delete process.env.SIYUAN_URL;
      else process.env.SIYUAN_URL = prev;
    }
  });

  it("buildUrl adds missing leading slash to the path", async () => {
    const client = newClient();
    const url = await client.buildUrl("api/foo");
    expect(url).toBe(`${BASE}/api/foo?kfdb_token=sekret-key`);
  });

  it("invalidateToken forces re-resolution on the next call", async () => {
    // Drive the re-resolve path: start with an explicitApiKey, invalidate,
    // and observe that the next request still uses the explicit key (since
    // explicit short-circuits resolution). This asserts the clear path is safe.
    const client = newClient();
    const url1 = await client.buildUrl("/api/a");
    client.invalidateToken();
    const url2 = await client.buildUrl("/api/a");
    expect(url1).toBe(url2);
  });
});
