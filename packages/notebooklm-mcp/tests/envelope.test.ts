import { describe, it, expect } from "vitest";
import { encodeFReq } from "../src/notebooklm/client.js";

describe("encodeFReq — f.req byte shape", () => {
  it("wraps as [[[rpcid, JSON(payload), null, 'generic']]]", () => {
    const out = encodeFReq("HpN0Ub", ["nb-123"]);
    expect(out).toBe('[[["HpN0Ub","[\\"nb-123\\"]",null,"generic"]]]');
  });

  it("round-trips: the inner string is the JSON of the payload", () => {
    const payload = ["nb-123", "audio-9"];
    const out = encodeFReq("HpN0Ub", payload);
    const parsed = JSON.parse(out);
    expect(parsed[0][0][0]).toBe("HpN0Ub");
    expect(JSON.parse(parsed[0][0][1])).toEqual(payload);
    expect(parsed[0][0][2]).toBeNull();
    expect(parsed[0][0][3]).toBe("generic");
  });

  it("encodes an empty payload deterministically", () => {
    expect(encodeFReq("AbCdEf", [])).toBe('[[["AbCdEf","[]",null,"generic"]]]');
  });
});
