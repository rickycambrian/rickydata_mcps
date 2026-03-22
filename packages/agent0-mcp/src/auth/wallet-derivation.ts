/**
 * Wallet derivation for ERC-8004 agent identity.
 *
 * Derives a deterministic private key from a wallet signature using HKDF.
 * This allows an MCP client user to derive a signing key for ERC-8004 operations
 * without exposing their main wallet private key.
 *
 * Flow:
 * 1. User signs a deterministic message with their wallet
 * 2. HKDF extracts a derived key from the signature
 * 3. The derived key is used for agent0-sdk write operations
 */
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha2";
import { ethers } from "ethers";

export interface DerivedWallet {
  address: string;
  privateKey: string;
}

/**
 * The deterministic signing message used to derive the key.
 * CRITICAL: This MUST NOT contain nonces, timestamps, or any variable data.
 * If changed, all previously derived keys become invalid.
 */
const DERIVATION_MESSAGE =
  "Sign this message to derive your ERC-8004 agent key.\n\n" +
  "This signature will be used to create a deterministic private key " +
  "for managing your on-chain agent identity. " +
  "This does not grant access to your funds.";

/**
 * Get the deterministic message that must be signed for key derivation.
 */
export function getDerivationMessage(): string {
  return DERIVATION_MESSAGE;
}

/**
 * Derive an ERC-8004 agent wallet from a wallet signature.
 *
 * Uses HKDF-SHA256 to extract a 32-byte private key from the signature.
 * The same signature always produces the same derived key.
 *
 * @param signature - The wallet's signature of DERIVATION_MESSAGE (hex string with 0x prefix)
 * @returns DerivedWallet with address and privateKey
 */
export function deriveWalletFromSignature(signature: string): DerivedWallet {
  if (!signature || !signature.startsWith("0x")) {
    throw new Error("Invalid signature: must be a hex string starting with 0x");
  }

  // Convert signature to bytes
  const sigBytes = ethers.getBytes(signature);

  // HKDF: extract + expand
  // salt: "agent0-erc8004" (domain separation)
  // info: "agent-key-v1" (versioned derivation context)
  const salt = new TextEncoder().encode("agent0-erc8004");
  const info = new TextEncoder().encode("agent-key-v1");
  const derivedKeyBytes = hkdf(sha256, sigBytes, salt, info, 32);

  // Create ethers wallet from derived key
  const privateKey = ethers.hexlify(derivedKeyBytes);
  const wallet = new ethers.Wallet(privateKey);

  return {
    address: wallet.address,
    privateKey,
  };
}

/**
 * Verify that a signature was produced by the expected wallet address.
 *
 * @param signature - The signature to verify
 * @param expectedAddress - The wallet address that should have signed
 * @returns true if the signature was produced by expectedAddress
 */
export function verifyDerivationSignature(
  signature: string,
  expectedAddress: string,
): boolean {
  try {
    const recovered = ethers.verifyMessage(DERIVATION_MESSAGE, signature);
    return recovered.toLowerCase() === expectedAddress.toLowerCase();
  } catch {
    return false;
  }
}
