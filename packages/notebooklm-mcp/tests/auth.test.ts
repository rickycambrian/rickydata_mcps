import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, afterEach } from "vitest";
import {
  parseBootstrapTokens,
  buildAuthorization,
  buildCookieHeader,
  hasExpiredCriticalCookie,
  loadCookieJar,
} from "../src/notebooklm/auth.js";
import { AuthExpiredError, NotConnectedError } from "../src/notebooklm/errors.js";
import type { StoredCookie } from "../src/notebooklm/types.js";

const FIX = join(fileURLToPath(new URL(".", import.meta.url)), "..", "fixtures");
const fx = (name: string) => readFileSync(join(FIX, name), "utf8");

function jar(entries: Array<[string, string, number?]>): Map<string, StoredCookie> {
  const m = new Map<string, StoredCookie>();
  for (const [name, value, expires] of entries) {
    m.set(name, { name, value, domain: ".google.com", expires: expires ?? -1 });
  }
  return m;
}

describe("parseBootstrapTokens", () => {
  it("reads SNlM0e→at, cfb2h→bl, FdrFJe→f.sid from WIZ_global_data", () => {
    const t = parseBootstrapTokens(fx("bootstrap.html"));
    expect(t.at).toMatch(/^AEXAMPLE/);
    expect(t.bl).toBe("boq_labs-tailwind-frontend_20260601.00_p0");
    expect(t.fsid).toBe("-1234567890123456789");
  });

  it("throws AuthExpiredError when tokens are absent (login page)", () => {
    expect(() => parseBootstrapTokens(fx("login.response.txt"))).toThrow(AuthExpiredError);
  });
});

describe("buildAuthorization", () => {
  it("emits a SAPISIDHASH triple with a fixed timestamp", () => {
    const auth = buildAuthorization(
      jar([["SAPISID", "sapisid-val"], ["__Secure-1PAPISID", "1p-val"], ["__Secure-3PAPISID", "3p-val"]]),
      "https://notebooklm.google.com",
      1_700_000_000_000,
    );
    expect(auth).toMatch(/^SAPISIDHASH 1700000000_[0-9a-f]{40}/);
    expect(auth).toContain("SAPISID1PHASH 1700000000_");
    expect(auth).toContain("SAPISID3PHASH 1700000000_");
  });

  it("is deterministic for a fixed timestamp + origin (sha1 of 'ts sapisid origin')", () => {
    const a1 = buildAuthorization(jar([["SAPISID", "x"]]), "https://o", 1000);
    const a2 = buildAuthorization(jar([["SAPISID", "x"]]), "https://o", 1000);
    expect(a1).toBe(a2);
    // Different origin → different hash.
    expect(buildAuthorization(jar([["SAPISID", "x"]]), "https://other", 1000)).not.toBe(a1);
  });
});

describe("buildCookieHeader", () => {
  it("serializes name=value pairs joined by '; '", () => {
    const h = buildCookieHeader(jar([["SID", "a"], ["HSID", "b"]]));
    expect(h).toBe("SID=a; HSID=b");
  });
});

describe("hasExpiredCriticalCookie", () => {
  it("false when criticals are session cookies (-1)", () => {
    expect(hasExpiredCriticalCookie(jar([["SID", "a"], ["SAPISID", "b"]]))).toBe(false);
  });
  it("true when a critical cookie has a past concrete expiry", () => {
    expect(hasExpiredCriticalCookie(jar([["SID", "a", 1]]))).toBe(true); // expires=1s (1970)
  });
  it("false when a critical cookie expires in the far future", () => {
    expect(hasExpiredCriticalCookie(jar([["SID", "a", 4_000_000_000]]))).toBe(false);
  });
});

describe("loadCookieJar env sources", () => {
  const saved = {
    cookies: process.env.NOTEBOOKLM_COOKIES,
    b64: process.env.NOTEBOOKLM_STATE_B64,
    path: process.env.NOTEBOOKLM_STATE_PATH,
  };
  afterEach(() => {
    process.env.NOTEBOOKLM_COOKIES = saved.cookies;
    process.env.NOTEBOOKLM_STATE_B64 = saved.b64;
    process.env.NOTEBOOKLM_STATE_PATH = saved.path;
  });

  const state = JSON.stringify({
    cookies: [
      { name: "SAPISID", value: "s", domain: ".google.com" },
      { name: "SID", value: "i", domain: ".google.com" },
      { name: "Other", value: "x", domain: ".example.com" },
    ],
  });

  it("loads from NOTEBOOKLM_COOKIES (raw JSON) and drops non-google cookies", () => {
    delete process.env.NOTEBOOKLM_STATE_B64;
    delete process.env.NOTEBOOKLM_STATE_PATH;
    process.env.NOTEBOOKLM_COOKIES = state;
    const j = loadCookieJar();
    expect(j.has("SAPISID")).toBe(true);
    expect(j.has("SID")).toBe(true);
    expect(j.has("Other")).toBe(false);
  });

  it("loads from NOTEBOOKLM_STATE_B64 (base64 JSON)", () => {
    delete process.env.NOTEBOOKLM_COOKIES;
    delete process.env.NOTEBOOKLM_STATE_PATH;
    process.env.NOTEBOOKLM_STATE_B64 = Buffer.from(state).toString("base64");
    expect(loadCookieJar().has("SAPISID")).toBe(true);
  });

  it("throws NotConnectedError when nothing is configured", () => {
    delete process.env.NOTEBOOKLM_COOKIES;
    delete process.env.NOTEBOOKLM_STATE_B64;
    process.env.NOTEBOOKLM_STATE_PATH = "/nonexistent/definitely/not/here.json";
    expect(() => loadCookieJar()).toThrow(NotConnectedError);
  });

  it("throws NotConnectedError when the session has no SAPISID", () => {
    delete process.env.NOTEBOOKLM_STATE_B64;
    delete process.env.NOTEBOOKLM_STATE_PATH;
    process.env.NOTEBOOKLM_COOKIES = JSON.stringify({
      cookies: [{ name: "SID", value: "i", domain: ".google.com" }],
    });
    expect(() => loadCookieJar()).toThrow(NotConnectedError);
  });
});
