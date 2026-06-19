/**
 * wallet-token.ts — mint the `scwt_` wallet token rickydata_home's `requireAuth`
 * accepts, by signing home's canonical auth message with a server-held private
 * key. This is the AUTH BOUNDARY: the operator wallet IS the identity, and the
 * private key never leaves this process (and is never returned by any tool).
 *
 * The message format + token encoding here are a BYTE-COMPATIBLE port of
 * rickydata_home/src/auth/wallet-token.ts (`buildAuthMessage` + `mintWalletToken`)
 * and src/auth/local-wallet.ts. The brand string, field order, lowercased
 * address, and integer-seconds windows MUST match exactly or home's
 * `ethers.verifyMessage` will not recover the signer. Keep them in sync.
 */
import { Wallet } from 'ethers';

/** Bearer prefix — MUST match home (`scwt_`). */
const TOKEN_PREFIX = 'scwt_';

/** Brand string — MUST match home's AUTH_BRAND byte-for-byte. */
const AUTH_BRAND = 'rickydata-home wallet auth';

/** Default token lifetime (24h) — mirrors home's DEFAULT_TOKEN_TTL_SECONDS. */
export const DEFAULT_TOKEN_TTL_SECONDS = 24 * 60 * 60;

/** Replay-window cap (48h) — mirrors home's MAX_TOKEN_TTL_SECONDS. */
export const MAX_TOKEN_TTL_SECONDS = 48 * 60 * 60;

export interface WalletAuthClaims {
  /** Lowercased 0x address — the verified identity. */
  address: string;
  /** Issued-at, integer unix seconds. */
  issuedAt: number;
  /** Expiry, integer unix seconds. */
  expiresAt: number;
}

/** A signer is the only thing minting needs — keeps the key out of the rest. */
export interface WalletSigner {
  /** Lowercased 0x address derived from the key. */
  address: string;
  /** EIP-191 personal_sign over a UTF-8 message. */
  signMessage(message: string): Promise<string>;
}

/** Current unix time in whole seconds. */
function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * The exact, reproducible message the wallet signs — ONE source of truth shared
 * with home's mint + verify. Lowercased address + integer seconds so there is no
 * checksum/timezone drift between this MCP and home's verifier.
 */
export function buildAuthMessage(claims: WalletAuthClaims): string {
  return [
    AUTH_BRAND,
    `address: ${claims.address.toLowerCase()}`,
    `issuedAt: ${claims.issuedAt}`,
    `expiresAt: ${claims.expiresAt}`,
  ].join('\n');
}

export interface MintWalletTokenOptions {
  /** 0x wallet address (case-insensitive; embedded lowercased). */
  address: string;
  /** EIP-191 personal_sign over a string. */
  signFn: (message: string) => Promise<string>;
  /** Token lifetime in seconds; defaults to DEFAULT_TOKEN_TTL_SECONDS, capped at MAX. */
  ttlSeconds?: number;
  /** Issued-at override (integer seconds) for deterministic tests; defaults to now. */
  issuedAt?: number;
}

/** Mint an `scwt_` token by signing the canonical message (byte-compatible with home). */
export async function mintWalletToken(opts: MintWalletTokenOptions): Promise<string> {
  const address = opts.address.toLowerCase();
  const issuedAt = opts.issuedAt ?? nowSeconds();
  const ttl = Math.min(opts.ttlSeconds ?? DEFAULT_TOKEN_TTL_SECONDS, MAX_TOKEN_TTL_SECONDS);
  const expiresAt = issuedAt + ttl;
  const signature = await opts.signFn(buildAuthMessage({ address, issuedAt, expiresAt }));
  const payload = { address, issuedAt, expiresAt, signature };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return TOKEN_PREFIX + body;
}

/**
 * Build a signer from a 0x-prefixed (or bare) private-key hex string. Ported
 * from home's createLocalWalletSigner; the address is lowercased to match the
 * token claims.
 */
export function createWalletSigner(privateKeyHex: string): WalletSigner {
  const key = privateKeyHex.startsWith('0x') ? privateKeyHex : `0x${privateKeyHex}`;
  const wallet = new Wallet(key);
  return {
    address: wallet.address.toLowerCase(),
    signMessage: (message) => wallet.signMessage(message),
  };
}

/**
 * Resolve the operator signer from env (`CANVAS_MCP_PRIVATE_KEY`). Returns null
 * when no key is present — the FAIL-CLOSED signal: every tool refuses rather
 * than falling back to an unauthenticated path. The wallet is the auth boundary.
 */
export function loadSignerFromEnv(
  env: Record<string, string | undefined> = process.env,
): WalletSigner | null {
  const key = env.CANVAS_MCP_PRIVATE_KEY;
  if (!key || key.trim() === '') return null;
  return createWalletSigner(key.trim());
}
