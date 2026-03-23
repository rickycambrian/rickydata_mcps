import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock agent0-sdk before importing the module under test
vi.mock("agent0-sdk", () => {
  const MockSDK = vi.fn().mockImplementation(() => ({
    searchAgents: vi.fn(),
    getAgent: vi.fn(),
  }));
  return { SDK: MockSDK };
});

import {
  getReadOnlySDK,
  getAuthenticatedSDK,
  setDerivedKey,
  hasAuthentication,
  getCurrentChainId,
  setChainId,
  getAuthStatus,
} from "../src/auth/sdk-client.js";
import { SDK } from "agent0-sdk";

describe("sdk-client", () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset module state by clearing cached SDK instances
    setChainId(11155111);
    delete process.env.ERC8004_PRIVATE_KEY;
    delete process.env.ERC8004_DERIVED_KEY;
  });

  afterEach(() => {
    process.env = { ...origEnv };
  });

  describe("getReadOnlySDK", () => {
    it("returns an SDK instance", async () => {
      const sdk = await getReadOnlySDK();
      expect(sdk).toBeDefined();
      expect(SDK).toHaveBeenCalled();
    });

    it("caches the SDK for the same chain", async () => {
      const sdk1 = await getReadOnlySDK();
      const sdk2 = await getReadOnlySDK();
      expect(sdk1).toBe(sdk2);
    });

    it("creates new SDK for a different chain", async () => {
      await getReadOnlySDK(1);
      await getReadOnlySDK(8453);
      // Different chain IDs should create different instances
      // (though the second call changes the cached chain)
      expect(SDK).toHaveBeenCalledTimes(2);
    });

    it("passes chainId to SDK config", async () => {
      await getReadOnlySDK(8453);
      expect(SDK).toHaveBeenCalledWith(
        expect.objectContaining({ chainId: 8453 }),
      );
    });
  });

  describe("getAuthenticatedSDK", () => {
    it("returns null when no private key is available", async () => {
      const sdk = await getAuthenticatedSDK();
      expect(sdk).toBeNull();
    });

    it("returns SDK when ERC8004_PRIVATE_KEY env is set", async () => {
      process.env.ERC8004_PRIVATE_KEY = "0x1234";
      const sdk = await getAuthenticatedSDK();
      expect(sdk).not.toBeNull();
    });

    it("returns SDK when ERC8004_DERIVED_KEY env is set", async () => {
      process.env.ERC8004_DERIVED_KEY = "0xabcd";
      const sdk = await getAuthenticatedSDK();
      expect(sdk).not.toBeNull();
    });

    it("returns SDK after setDerivedKey is called", async () => {
      setDerivedKey("0xdeadbeef");
      const sdk = await getAuthenticatedSDK();
      expect(sdk).not.toBeNull();
    });
  });

  describe("hasAuthentication", () => {
    it("returns true with env key", () => {
      process.env.ERC8004_PRIVATE_KEY = "0x1234";
      expect(hasAuthentication()).toBe(true);
    });

    it("returns true after setDerivedKey", () => {
      setDerivedKey("0xdeadbeef");
      expect(hasAuthentication()).toBe(true);
    });
  });

  describe("getCurrentChainId / setChainId", () => {
    it("defaults to 11155111", () => {
      expect(getCurrentChainId()).toBe(11155111);
    });

    it("setChainId updates the current chain", () => {
      setChainId(8453);
      expect(getCurrentChainId()).toBe(8453);
    });
  });

  describe("getAuthStatus", () => {
    it("returns env source when ERC8004_PRIVATE_KEY set", () => {
      process.env.ERC8004_PRIVATE_KEY = "0x1234";
      const status = getAuthStatus();
      expect(status.hasKey).toBe(true);
      expect(status.source).toBe("env:ERC8004_PRIVATE_KEY");
      expect(status.isReadOnly).toBe(false);
    });

    it("returns derived source after setDerivedKey", () => {
      setDerivedKey("0xdeadbeef");
      const status = getAuthStatus();
      expect(status.source).toBe("derived");
    });

    it("includes current chainId", () => {
      setChainId(8453);
      const status = getAuthStatus();
      expect(status.chainId).toBe(8453);
    });

    it("env key takes priority over derived key", () => {
      setDerivedKey("0xdeadbeef");
      process.env.ERC8004_PRIVATE_KEY = "0x1234";
      const status = getAuthStatus();
      expect(status.source).toBe("env:ERC8004_PRIVATE_KEY");
    });
  });
});
