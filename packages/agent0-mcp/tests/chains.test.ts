import { describe, it, expect } from "vitest";
import { CHAINS, getChain, getChainName } from "../src/utils/chains.js";

describe("CHAINS config", () => {
  it("includes Ethereum Mainnet (1)", () => {
    expect(CHAINS[1]).toBeDefined();
    expect(CHAINS[1].name).toBe("Ethereum Mainnet");
    expect(CHAINS[1].chainId).toBe(1);
  });

  it("includes Base (8453)", () => {
    expect(CHAINS[8453]).toBeDefined();
    expect(CHAINS[8453].name).toBe("Base");
  });

  it("includes Arbitrum One (42161)", () => {
    expect(CHAINS[42161]).toBeDefined();
    expect(CHAINS[42161].name).toBe("Arbitrum One");
  });

  it("includes Optimism (10)", () => {
    expect(CHAINS[10]).toBeDefined();
    expect(CHAINS[10].name).toBe("Optimism");
  });

  it("all chains have required fields", () => {
    for (const chain of Object.values(CHAINS)) {
      expect(chain.chainId).toBeTypeOf("number");
      expect(chain.name).toBeTypeOf("string");
      expect(chain.rpcUrl).toMatch(/^https?:\/\//);
      expect(chain.explorerUrl).toMatch(/^https?:\/\//);
    }
  });
});

describe("getChain", () => {
  it("returns config for known chain", () => {
    const chain = getChain(8453);
    expect(chain).toBeDefined();
    expect(chain!.name).toBe("Base");
  });

  it("returns undefined for unknown chain", () => {
    expect(getChain(99999)).toBeUndefined();
  });
});

describe("getChainName", () => {
  it("returns name for known chain", () => {
    expect(getChainName(1)).toBe("Ethereum Mainnet");
    expect(getChainName(8453)).toBe("Base");
  });

  it("returns fallback string for unknown chain", () => {
    expect(getChainName(12345)).toBe("Chain 12345");
  });
});
