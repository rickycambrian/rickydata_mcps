import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  stripXssiPrefix,
  splitChunks,
  looksLikeLoginHtml,
  extractRpcPayload,
} from "../src/notebooklm/parse.js";
import { ContractBrokenError, AuthExpiredError } from "../src/notebooklm/errors.js";

const FIX = join(fileURLToPath(new URL(".", import.meta.url)), "..", "fixtures");
const fx = (name: string) => readFileSync(join(FIX, name), "utf8");

describe("stripXssiPrefix", () => {
  it("strips the )]}' anti-hijack prefix", () => {
    expect(stripXssiPrefix(")]}'\n\n[1,2]")).toBe("\n\n[1,2]");
  });
  it("is a no-op when the prefix is absent", () => {
    expect(stripXssiPrefix("[1,2]")).toBe("[1,2]");
  });
});

describe("looksLikeLoginHtml", () => {
  it("detects a Google login page", () => {
    expect(looksLikeLoginHtml(fx("login.response.txt"))).toBe(true);
  });
  it("does not flag a normal RPC body", () => {
    expect(looksLikeLoginHtml(fx("multichunk.response.txt"))).toBe(false);
  });
});

describe("splitChunks", () => {
  it("splits a real length-prefixed envelope into JSON chunks", () => {
    const chunks = splitChunks(stripXssiPrefix(fx("multichunk.response.txt")));
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // Every chunk must be parseable JSON.
    for (const c of chunks) expect(() => JSON.parse(c)).not.toThrow();
  });
  it("recovers via brace-scan when the length prefix is wrong", () => {
    // Deliberately wrong length (999) before a valid array.
    const body = "999\n" + JSON.stringify([["wrb.fr", "X", "[]"]]);
    const chunks = splitChunks(body);
    expect(chunks.length).toBe(1);
    expect(JSON.parse(chunks[0])[0][1]).toBe("X");
  });
});

describe("extractRpcPayload", () => {
  it("extracts + JSON-parses the wrb.fr payload for the rpcid", () => {
    const data = extractRpcPayload(
      fx("multichunk.response.txt"),
      "SAMPLE",
      "download_audio",
      "bl-test",
    );
    // inner payload was [["<url>"]]
    expect(JSON.stringify(data)).toContain("overview.mp3");
  });

  it("decodes the real HpN0Ub authorize frame to an empty array", () => {
    const data = extractRpcPayload(fx("HpN0Ub.response.txt"), "HpN0Ub", "download_audio", "bl");
    expect(data).toEqual([]);
  });

  it("throws AuthExpiredError on a login page", () => {
    expect(() =>
      extractRpcPayload(fx("login.response.txt"), "HpN0Ub", "download_audio", null),
    ).toThrow(AuthExpiredError);
  });

  it("throws ContractBrokenError when the rpcid frame is missing", () => {
    expect(() =>
      extractRpcPayload(fx("missing-frame.response.txt"), "HpN0Ub", "download_audio", "bl-x"),
    ).toThrow(ContractBrokenError);
  });

  it("throws ContractBrokenError on a truncated/undecodable envelope", () => {
    expect(() =>
      extractRpcPayload(fx("truncated.response.txt"), "HpN0Ub", "download_audio", "bl-x"),
    ).toThrow(ContractBrokenError);
  });

  it("ContractBrokenError names the action, rpcid and bl", () => {
    try {
      extractRpcPayload(fx("missing-frame.response.txt"), "HpN0Ub", "download_audio", "bl-42");
      throw new Error("should have thrown");
    } catch (e) {
      const err = e as ContractBrokenError;
      expect(err.action).toBe("download_audio");
      expect(err.rpcid).toBe("HpN0Ub");
      expect(err.bl).toBe("bl-42");
      expect(err.message).toMatch(/npm run capture -- --action=download_audio/);
    }
  });
});
