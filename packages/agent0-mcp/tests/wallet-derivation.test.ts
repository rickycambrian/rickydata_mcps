import { describe, it, expect, vi } from "vitest";

// Mock ethers to avoid needing a real crypto environment
vi.mock("ethers", () => ({
  ethers: {
    getBytes: vi.fn((hex: string) =>
      Uint8Array.from(Buffer.from(hex.replace("0x", ""), "hex")),
    ),
    hexlify: vi.fn((bytes: Uint8Array) =>
      "0x" + Buffer.from(bytes).toString("hex"),
    ),
    Wallet: vi.fn().mockImplementation((key: string) => ({
      address: "0xDerived" + key.slice(2, 10),
      privateKey: key,
    })),
    verifyMessage: vi.fn().mockReturnValue("0xSignerAddress"),
  },
}));

import {
  getDerivationMessage,
  deriveWalletFromSignature,
  verifyDerivationSignature,
} from "../src/auth/wallet-derivation.js";

describe("wallet-derivation", () => {
  describe("getDerivationMessage", () => {
    it("returns a non-empty string", () => {
      const msg = getDerivationMessage();
      expect(typeof msg).toBe("string");
      expect(msg.length).toBeGreaterThan(0);
    });

    it("is deterministic (no nonces/timestamps)", () => {
      const msg1 = getDerivationMessage();
      const msg2 = getDerivationMessage();
      expect(msg1).toBe(msg2);
    });

    it("contains ERC-8004 context", () => {
      expect(getDerivationMessage()).toContain("ERC-8004");
    });

    it("contains safety notice about funds", () => {
      expect(getDerivationMessage()).toContain(
        "does not grant access to your funds",
      );
    });
  });

  describe("deriveWalletFromSignature", () => {
    it("returns address and privateKey", () => {
      // Use a valid-looking hex signature (65 bytes = 130 hex chars)
      const sig =
        "0x" + "ab".repeat(65);
      const wallet = deriveWalletFromSignature(sig);
      expect(wallet.address).toBeTypeOf("string");
      expect(wallet.privateKey).toBeTypeOf("string");
      expect(wallet.privateKey).toMatch(/^0x/);
    });

    it("is deterministic: same signature -> same key", () => {
      const sig = "0x" + "cd".repeat(65);
      const w1 = deriveWalletFromSignature(sig);
      const w2 = deriveWalletFromSignature(sig);
      expect(w1.privateKey).toBe(w2.privateKey);
      expect(w1.address).toBe(w2.address);
    });

    it("different signatures -> different keys", () => {
      const sig1 = "0x" + "aa".repeat(65);
      const sig2 = "0x" + "bb".repeat(65);
      const w1 = deriveWalletFromSignature(sig1);
      const w2 = deriveWalletFromSignature(sig2);
      expect(w1.privateKey).not.toBe(w2.privateKey);
    });

    it("throws for empty signature", () => {
      expect(() => deriveWalletFromSignature("")).toThrow("Invalid signature");
    });

    it("throws for signature without 0x prefix", () => {
      expect(() => deriveWalletFromSignature("abcdef")).toThrow(
        "Invalid signature",
      );
    });
  });

  describe("verifyDerivationSignature", () => {
    it("returns true when signer matches expected address", () => {
      // Mock is set to return "0xSignerAddress"
      expect(
        verifyDerivationSignature("0xabc123", "0xSignerAddress"),
      ).toBe(true);
    });

    it("is case-insensitive for address comparison", () => {
      expect(
        verifyDerivationSignature("0xabc123", "0xsigneraddress"),
      ).toBe(true);
    });

    it("returns false when signer does not match", () => {
      expect(
        verifyDerivationSignature("0xabc123", "0xDifferentAddress"),
      ).toBe(false);
    });
  });
});
