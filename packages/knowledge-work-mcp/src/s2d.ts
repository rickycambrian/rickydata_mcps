import { createHash } from 'node:crypto';
import { Wallet } from 'ethers';

export interface S2DCredentials {
  sessionId: string;
  keyHex: string;
  walletAddress: string;
}

export interface S2DProvider {
  ensure(): Promise<S2DCredentials | null>;
}

export class S2DSessionManager implements S2DProvider {
  private readonly apiUrl: string;
  private readonly wallet: Wallet;
  private current: S2DCredentials | null = null;
  private expiresAt = 0;
  private refreshPromise: Promise<S2DCredentials | null> | null = null;

  constructor(apiUrl: string, privateKeyHex: string) {
    this.apiUrl = apiUrl.replace(/\/$/, '');
    const key = privateKeyHex.startsWith('0x') ? privateKeyHex : `0x${privateKeyHex}`;
    this.wallet = new Wallet(key);
  }

  async ensure(): Promise<S2DCredentials | null> {
    if (this.current && Date.now() < this.expiresAt) return this.current;
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.refresh();
    try {
      return await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  private async refresh(): Promise<S2DCredentials | null> {
    const challengeRes = await fetch(`${this.apiUrl}/api/v1/auth/derive-challenge`, {
      method: 'POST',
    });
    if (!challengeRes.ok) {
      throw new Error(`derive-challenge failed: ${challengeRes.status} ${await challengeRes.text()}`);
    }
    const challenge = (await challengeRes.json()) as {
      challenge_id: string;
      typed_data: {
        domain: { name: string; version: string; chainId: string | number };
        types: { AuthMessage: Array<{ name: string; type: string }> };
        message: { message: string; nonce: string; issuedAt: string | number; expiresAt: string | number };
      };
    };
    const td = challenge.typed_data;
    const signature = await this.wallet.signTypedData(
      {
        name: td.domain.name,
        version: td.domain.version,
        chainId: BigInt(td.domain.chainId),
      },
      { AuthMessage: td.types.AuthMessage },
      {
        message: td.message.message,
        nonce: td.message.nonce,
        issuedAt: BigInt(td.message.issuedAt),
        expiresAt: BigInt(td.message.expiresAt),
      },
    );
    const deriveRes = await fetch(`${this.apiUrl}/api/v1/auth/derive-key`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        challenge_id: challenge.challenge_id,
        signature,
        address: this.wallet.address,
      }),
    });
    if (!deriveRes.ok) {
      throw new Error(`derive-key failed: ${deriveRes.status} ${await deriveRes.text()}`);
    }
    const result = (await deriveRes.json()) as { session_id?: string; key_hex?: string };
    if (!result.session_id) throw new Error('derive-key response missing session_id');
    const sigHex = signature.startsWith('0x') ? signature.slice(2) : signature;
    const fallbackKey = createHash('sha256').update(Buffer.from(sigHex, 'hex')).digest('hex');
    this.current = {
      sessionId: result.session_id,
      keyHex: result.key_hex || fallbackKey,
      walletAddress: this.wallet.address.toLowerCase(),
    };
    this.expiresAt = Date.now() + 50 * 60 * 1000;
    return this.current;
  }
}
