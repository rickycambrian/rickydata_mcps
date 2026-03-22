/**
 * Validate an Ethereum address (basic checksum-agnostic check).
 */
export function isValidAddress(address: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(address);
}

/**
 * Validate a bytes32 hex string (e.g., agent ID).
 */
export function isValidBytes32(hex: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(hex);
}

/**
 * Validate a positive integer chain ID.
 */
export function isValidChainId(chainId: number): boolean {
  return Number.isInteger(chainId) && chainId > 0;
}
