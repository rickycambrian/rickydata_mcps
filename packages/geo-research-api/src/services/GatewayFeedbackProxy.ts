import { config } from '../config/index.js';

const GATEWAY_URL = config.agentGateway.url;

/**
 * Authenticate with the agent gateway using wallet signature (viem).
 * Reuses the same auth pattern as AgentProxy.
 */
async function getGatewayToken(): Promise<string> {
  const { privateKeyToAccount } = await import('viem/accounts');
  const account = privateKeyToAccount(config.agentGateway.privateKey as `0x${string}`);

  const challengeRes = await fetch(`${GATEWAY_URL}/auth/challenge`);
  if (!challengeRes.ok) throw new Error(`Auth challenge failed: ${challengeRes.status}`);
  const { nonce, message: challengeMessage } = await challengeRes.json();

  const signature = await account.signMessage({ message: challengeMessage });

  const verifyRes = await fetch(`${GATEWAY_URL}/auth/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ walletAddress: account.address, signature, nonce }),
  });
  if (!verifyRes.ok) throw new Error(`Auth verify failed: ${verifyRes.status}`);
  const { token } = await verifyRes.json();
  return token;
}

let cachedToken: string | null = null;

async function ensureToken(): Promise<string> {
  if (!cachedToken) {
    cachedToken = await getGatewayToken();
  }
  return cachedToken;
}

function authHeaders(token: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };
}

async function gatewayRequest(method: string, path: string, body?: unknown): Promise<any> {
  const token = await ensureToken();
  const url = `${GATEWAY_URL}${path}`;
  const opts: RequestInit = { method, headers: authHeaders(token) };
  if (body) opts.body = JSON.stringify(body);

  let res = await fetch(url, opts);

  // Auto-retry on 401
  if (res.status === 401) {
    cachedToken = null;
    const newToken = await ensureToken();
    opts.headers = authHeaders(newToken);
    res = await fetch(url, opts);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Gateway ${method} ${path} failed: ${res.status} ${text}`);
  }

  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) return res.json();
  return { ok: true };
}

/**
 * Submit outcome feedback for a claim extraction.
 */
export async function submitOutcomeFeedback(data: {
  paperId: string;
  claimIndex: number;
  claimText: string;
  rating: 'positive' | 'negative';
  comment?: string;
}): Promise<any> {
  return gatewayRequest('POST', '/api/feedback/outcome', {
    context: 'claim_extraction',
    paper_id: data.paperId,
    claim_index: data.claimIndex,
    claim_text: data.claimText,
    rating: data.rating,
    comment: data.comment,
  });
}

/**
 * Rate a previous feedback entry.
 */
export async function rateFeedback(data: {
  feedbackId: string;
  rating: number;
}): Promise<any> {
  return gatewayRequest('POST', '/api/feedback/rate', data);
}

/**
 * Trigger the gateway's self-improvement cycle.
 */
export async function triggerSelfImprovement(): Promise<any> {
  return gatewayRequest('POST', '/wallet/self-improvement/trigger', {});
}

/**
 * Get status of the current self-improvement cycle.
 */
export async function getImprovementStatus(): Promise<any> {
  return gatewayRequest('GET', '/wallet/self-improvement/status');
}

/**
 * Get all skills for the current wallet.
 */
export async function getSkills(): Promise<any> {
  return gatewayRequest('GET', '/wallet/skills');
}
