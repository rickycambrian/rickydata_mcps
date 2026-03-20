import { ethers } from 'ethers';

export const WALLET_TOKEN_PREFIX = 'mcpwt_';
export const PLATFORM_TOKEN_MESSAGE_PREFIX = 'MCP Platform Auth';

const TOKEN_MESSAGE_REGEX =
  /^(MCP (?:Gateway|Platform) Auth)\nWallet: (0x[a-fA-F0-9]{40})\nExpires: (.+)$/;

interface WalletTokenPayload {
  v: number;
  wallet: string;
  exp: number;
  msg: string;
  sig: string;
}

export function buildTokenMessage(walletAddress: string, expiresAt: string): string {
  const checksummed = ethers.getAddress(walletAddress);
  return `${PLATFORM_TOKEN_MESSAGE_PREFIX}\nWallet: ${checksummed}\nExpires: ${expiresAt}`;
}

function buildTokenMessageWithPrefix(prefix: string, walletAddress: string, expiresAt: string): string {
  const checksummed = ethers.getAddress(walletAddress);
  const normalizedPrefix = prefix === 'MCP Gateway Auth' ? 'MCP Gateway Auth' : PLATFORM_TOKEN_MESSAGE_PREFIX;
  return `${normalizedPrefix}\nWallet: ${checksummed}\nExpires: ${expiresAt}`;
}

export function verifyWalletToken(token: string): { walletAddress: string } | null {
  if (!token.startsWith(WALLET_TOKEN_PREFIX)) return null;

  try {
    const json = Buffer.from(token.slice(WALLET_TOKEN_PREFIX.length), 'base64url').toString();
    const payload: WalletTokenPayload = JSON.parse(json);

    if (
      typeof payload.v !== 'number' ||
      typeof payload.wallet !== 'string' ||
      typeof payload.exp !== 'number' ||
      typeof payload.msg !== 'string' ||
      typeof payload.sig !== 'string'
    ) {
      return null;
    }

    if (payload.v !== 1) return null;

    const match = payload.msg.match(TOKEN_MESSAGE_REGEX);
    if (!match) return null;

    const signedPrefix = match[1];
    const signedWallet = ethers.getAddress(match[2]);
    const signedExpiry = Math.floor(new Date(match[3]).getTime() / 1000);
    if (!Number.isFinite(signedExpiry)) return null;

    const recovered = ethers.verifyMessage(payload.msg, payload.sig);
    const checksummedRecovered = ethers.getAddress(recovered);
    const checksummedClaimed = ethers.getAddress(payload.wallet);

    if (checksummedClaimed !== signedWallet) return null;
    if (checksummedRecovered !== checksummedClaimed) return null;
    if (payload.exp !== signedExpiry) return null;
    if (payload.exp < Date.now() / 1000) return null;
    if (payload.msg !== buildTokenMessageWithPrefix(signedPrefix, checksummedClaimed, match[3])) return null;

    return { walletAddress: checksummedClaimed.toLowerCase() };
  } catch {
    return null;
  }
}

export function createWalletToken(walletAddress: string, signature: string, expiresAt: string): string | null {
  const expiresAtMs = new Date(expiresAt).getTime();
  if (!Number.isFinite(expiresAtMs)) return null;

  const msg = buildTokenMessage(walletAddress, expiresAt);

  try {
    const recovered = ethers.getAddress(ethers.verifyMessage(msg, signature));
    const claimed = ethers.getAddress(walletAddress);
    if (recovered !== claimed) return null;
  } catch {
    return null;
  }

  const payload: WalletTokenPayload = {
    v: 1,
    wallet: ethers.getAddress(walletAddress),
    exp: Math.floor(expiresAtMs / 1000),
    msg,
    sig: signature,
  };

  return WALLET_TOKEN_PREFIX + Buffer.from(JSON.stringify(payload)).toString('base64url');
}
