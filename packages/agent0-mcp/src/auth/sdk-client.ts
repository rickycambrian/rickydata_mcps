/**
 * Agent0 SDK client management.
 *
 * Provides read-only and authenticated SDK instances for ERC-8004 operations.
 *
 * Key resolution order:
 * 1. ERC8004_PRIVATE_KEY env var (explicit private key)
 * 2. ERC8004_DERIVED_KEY env var (previously derived key from wallet signature)
 * 3. Prompt user for wallet signature derivation (via configure_wallet tool)
 */
// Dynamic import to avoid module-level initialization from agent0-sdk
// which can hang in containerized environments with network restrictions
type SDKConfig = { chainId: number; rpcUrl?: string; overrideRpcUrls?: Record<number, string>; privateKey?: string; ipfs?: "pinata" | "helia" | "node" | "filecoinPin"; pinataJwt?: string };
async function loadSDK() { return (await import("agent0-sdk")).SDK; }

// ============================================================================
// CONFIGURATION
// ============================================================================

// Default to Base (8453) — matches x402 payment chain where USDC is used
const DEFAULT_CHAIN_ID = parseInt(process.env.AGENT0_CHAIN_ID || "8453", 10);
const RPC_URL = process.env.AGENT0_RPC_URL;
const IPFS_PROVIDER = (process.env.AGENT0_IPFS_PROVIDER || "pinata") as
  | "pinata"
  | "helia"
  | "node"
  | "filecoinPin";
const PINATA_JWT = process.env.PINATA_JWT;

// ============================================================================
// SDK CLIENT STATE
// ============================================================================

let _readOnlySDK: any = null;
let _authenticatedSDK: any = null;
let _currentPrivateKey: string | null = null;
let _currentChainId: number = DEFAULT_CHAIN_ID;

/**
 * Resolve the private key from environment or stored state.
 * Returns null if no key is available (read-only mode).
 */
export function resolvePrivateKey(): string | null {
  // 1. Explicit private key
  if (process.env.ERC8004_PRIVATE_KEY) {
    return process.env.ERC8004_PRIVATE_KEY;
  }
  // 2. Previously derived key
  if (process.env.ERC8004_DERIVED_KEY) {
    return process.env.ERC8004_DERIVED_KEY;
  }
  // 3. Stored from configure_wallet
  return _currentPrivateKey;
}

/**
 * Build SDK config for the given chain.
 */
import { getDrpcUrl, buildDrpcOverrides } from '../utils/chains.js';

function buildConfig(
  chainId: number,
  privateKey?: string | null,
): SDKConfig {
  const config: any = { chainId };

  // Primary chain RPC: explicit env var > dRPC > none (SDK defaults)
  const rpcUrl = RPC_URL || getDrpcUrl(chainId);
  if (rpcUrl) config.rpcUrl = rpcUrl;

  // Override ALL known chains with dRPC URLs
  if (process.env.DRPC_API_KEY) {
    config.overrideRpcUrls = buildDrpcOverrides();
  }

  if (privateKey) config.privateKey = privateKey;

  // Only configure IPFS when we have a private key (write operations need IPFS)
  if (privateKey && PINATA_JWT) {
    config.ipfs = IPFS_PROVIDER;
    config.pinataJwt = PINATA_JWT;
  }

  return config;
}

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Get a read-only SDK instance (no signing capabilities).
 * Suitable for search, discovery, and reputation queries.
 */
export async function getReadOnlySDK(chainId?: number): Promise<any> {
  const targetChain = chainId ?? _currentChainId;

  // Cache the read-only SDK for the current chain
  if (_readOnlySDK && targetChain === _currentChainId) {
    return _readOnlySDK;
  }

  const SDK = await loadSDK();
  _readOnlySDK = new SDK(buildConfig(targetChain));
  if (!chainId) _currentChainId = targetChain;
  return _readOnlySDK;
}

/**
 * Get an authenticated SDK instance (with signing capabilities).
 * Returns null if no private key is available.
 */
export async function getAuthenticatedSDK(chainId?: number): Promise<any | null> {
  const privateKey = resolvePrivateKey();
  if (!privateKey) return null;

  const targetChain = chainId ?? _currentChainId;

  // Return cached if key and chain haven't changed
  if (
    _authenticatedSDK &&
    _currentPrivateKey === privateKey &&
    targetChain === _currentChainId
  ) {
    return _authenticatedSDK;
  }

  const SDK = await loadSDK();
  _authenticatedSDK = new SDK(buildConfig(targetChain, privateKey));
  _currentPrivateKey = privateKey;
  _currentChainId = targetChain;
  return _authenticatedSDK;
}

/** Track how the current key was set — 'derived' from signature, 'injected' by gateway. */
let _keySource: 'derived' | 'injected' | null = null;

/**
 * Set the derived private key (from wallet signature derivation).
 * Clears cached authenticated SDK so it's rebuilt on next access.
 */
export function setDerivedKey(privateKey: string): void {
  _currentPrivateKey = privateKey;
  _keySource = 'derived';
  _authenticatedSDK = null;
}

/**
 * Inject a private key from the hosting gateway (server-side).
 * NOT exposed as an MCP tool — only callable programmatically.
 * Clears cached authenticated SDK so it's rebuilt on next access.
 */
export function injectPrivateKey(privateKey: string): void {
  _currentPrivateKey = privateKey;
  _keySource = 'injected';
  _authenticatedSDK = null;
}

/**
 * Clear the stored private key and reset to read-only mode.
 * Call on session cleanup to avoid key leakage across sessions.
 */
export function clearKey(): void {
  _currentPrivateKey = null;
  _keySource = null;
  _authenticatedSDK = null;
}

/**
 * Check if an authenticated SDK is available (has a private key).
 */
export function hasAuthentication(): boolean {
  return resolvePrivateKey() !== null;
}

/**
 * Get the current chain ID.
 */
export function getCurrentChainId(): number {
  return _currentChainId;
}

/**
 * Set the current chain ID (clears cached SDK instances).
 */
export function setChainId(chainId: number): void {
  _currentChainId = chainId;
  _readOnlySDK = null;
  _authenticatedSDK = null;
}

/**
 * Get authentication status information.
 */
export function getAuthStatus(): {
  hasKey: boolean;
  chainId: number;
  source: "env:ERC8004_PRIVATE_KEY" | "env:ERC8004_DERIVED_KEY" | "derived" | "injected" | "none";
  isReadOnly: boolean;
} {
  let source: "env:ERC8004_PRIVATE_KEY" | "env:ERC8004_DERIVED_KEY" | "derived" | "injected" | "none" = "none";
  if (process.env.ERC8004_PRIVATE_KEY) source = "env:ERC8004_PRIVATE_KEY";
  else if (process.env.ERC8004_DERIVED_KEY) source = "env:ERC8004_DERIVED_KEY";
  else if (_currentPrivateKey && _keySource) source = _keySource;

  return {
    hasKey: source !== "none",
    chainId: _currentChainId,
    source,
    isReadOnly: source === "none",
  };
}
