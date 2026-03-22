import { describe, it, expect } from "vitest";
import {
  isValidAddress,
  isValidBytes32,
  isValidChainId,
} from "../src/utils/validation.js";

describe("isValidAddress", () => {
  it("accepts a valid lowercase address", () => {
    expect(isValidAddress("0x75992f829df3b5d515d70db0f77a98171ce261ef")).toBe(
      true,
    );
  });

  it("accepts a valid checksummed address", () => {
    expect(isValidAddress("0x75992f829DF3B5d515D70DB0f77A98171cE261EF")).toBe(
      true,
    );
  });

  it("rejects address without 0x prefix", () => {
    expect(isValidAddress("75992f829df3b5d515d70db0f77a98171ce261ef")).toBe(
      false,
    );
  });

  it("rejects address that is too short", () => {
    expect(isValidAddress("0x75992f829df3b5d515d70db0f77a98171ce261e")).toBe(
      false,
    );
  });

  it("rejects address that is too long", () => {
    expect(isValidAddress("0x75992f829df3b5d515d70db0f77a98171ce261efff")).toBe(
      false,
    );
  });

  it("rejects address with non-hex characters", () => {
    expect(isValidAddress("0x75992f829df3b5d515d70db0f77a98171ce261eG")).toBe(
      false,
    );
  });

  it("rejects empty string", () => {
    expect(isValidAddress("")).toBe(false);
  });

  it("rejects 0x alone", () => {
    expect(isValidAddress("0x")).toBe(false);
  });
});

describe("isValidBytes32", () => {
  it("accepts a valid bytes32 hex string", () => {
    const validBytes32 =
      "0x0000000000000000000000000000000000000000000000000000000000000001";
    expect(isValidBytes32(validBytes32)).toBe(true);
  });

  it("accepts uppercase hex", () => {
    const validBytes32 =
      "0xABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789";
    expect(isValidBytes32(validBytes32)).toBe(true);
  });

  it("rejects without 0x prefix", () => {
    expect(
      isValidBytes32(
        "0000000000000000000000000000000000000000000000000000000000000001",
      ),
    ).toBe(false);
  });

  it("rejects too short", () => {
    expect(
      isValidBytes32(
        "0x000000000000000000000000000000000000000000000000000000000000001",
      ),
    ).toBe(false);
  });

  it("rejects too long", () => {
    expect(
      isValidBytes32(
        "0x00000000000000000000000000000000000000000000000000000000000000011",
      ),
    ).toBe(false);
  });

  it("rejects non-hex characters", () => {
    expect(
      isValidBytes32(
        "0xGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG",
      ),
    ).toBe(false);
  });
});

describe("isValidChainId", () => {
  it("accepts 1 (Ethereum mainnet)", () => {
    expect(isValidChainId(1)).toBe(true);
  });

  it("accepts 8453 (Base)", () => {
    expect(isValidChainId(8453)).toBe(true);
  });

  it("accepts large chain ID", () => {
    expect(isValidChainId(999999)).toBe(true);
  });

  it("rejects 0", () => {
    expect(isValidChainId(0)).toBe(false);
  });

  it("rejects negative numbers", () => {
    expect(isValidChainId(-1)).toBe(false);
  });

  it("rejects non-integer", () => {
    expect(isValidChainId(1.5)).toBe(false);
  });

  it("rejects NaN", () => {
    expect(isValidChainId(NaN)).toBe(false);
  });

  it("rejects Infinity", () => {
    expect(isValidChainId(Infinity)).toBe(false);
  });
});
