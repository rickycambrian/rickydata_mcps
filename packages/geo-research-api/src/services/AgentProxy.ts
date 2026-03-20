import { config } from '../config/index.js';

const GATEWAY_URL = config.agentGateway.url;

/** Known agent types for the gateway */
export type AgentType = 'research-paper-analyst' | 'research-paper-analyst-geo-uploader';

/** Default agent for claim extraction (backward compat) */
const DEFAULT_AGENT_ID: AgentType = 'research-paper-analyst-geo-uploader';

export interface SSEEvent {
  type: string;
  data?: any;
  [key: string]: any;
}

/**
 * Authenticate with the agent gateway using wallet signature (viem).
 */
async function getGatewayToken(): Promise<string> {
  const { privateKeyToAccount } = await import('viem/accounts');
  const account = privateKeyToAccount(config.agentGateway.privateKey as `0x${string}`);

  // Get challenge
  const challengeRes = await fetch(`${GATEWAY_URL}/auth/challenge`);
  if (!challengeRes.ok) throw new Error(`Auth challenge failed: ${challengeRes.status}`);
  const { nonce, message: challengeMessage } = await challengeRes.json();

  // Sign
  const signature = await account.signMessage({ message: challengeMessage });

  // Verify
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

async function buildGatewayError(res: Response, fallbackPrefix: string): Promise<Error> {
  let errorMessage = `${fallbackPrefix}: ${res.status}`;
  try {
    const errBody = await res.json();
    if (res.status === 402) {
      errorMessage = errBody?.error === 'sponsor_budget_exhausted'
        ? 'Agent gateway sponsor budget exhausted. It will reset automatically.'
        : 'Agent gateway quota exceeded. Please check your account balance or try again later.';
    } else if (errBody?.error) {
      errorMessage = errBody.error;
    } else if (errBody?.message) {
      errorMessage = errBody.message;
    }
  } catch { /* response may not be JSON */ }
  return new Error(errorMessage);
}

async function gatewayJsonRequest<T>(path: string, options: RequestInit, userGatewayToken?: string): Promise<T> {
  const url = `${GATEWAY_URL}${path}`;
  let token = userGatewayToken || await ensureToken();

  const send = async (authToken: string) => fetch(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      ...authHeaders(authToken),
    },
  });

  let res = await send(token);
  if (res.status === 401 && !userGatewayToken) {
    cachedToken = null;
    token = await ensureToken();
    res = await send(token);
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    const errorMessage = body.error || body.message || `Gateway request failed: ${res.status}`;
    throw new Error(errorMessage);
  }

  return res.json() as Promise<T>;
}

/**
 * Create an agent session. Returns session ID.
 * @param agentId - which agent to create a session for (defaults to geo-uploader)
 * @param model - model to use (defaults to haiku)
 */
export async function createSession(agentId: AgentType = DEFAULT_AGENT_ID, model = 'haiku', userGatewayToken?: string): Promise<string> {
  if (userGatewayToken) {
    console.log('[AgentProxy] Using user gateway token for', agentId);
  } else {
    console.log('[AgentProxy] No user token, falling back to server token for', agentId);
  }
  const token = userGatewayToken || await ensureToken();
  const url = `${GATEWAY_URL}/agents/${encodeURIComponent(agentId)}/sessions`;
  const res = await fetch(url, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ model }),
  });

  if (res.status === 401 && !userGatewayToken) {
    cachedToken = null;
    const newToken = await ensureToken();
    const retry = await fetch(url, {
      method: 'POST',
      headers: authHeaders(newToken),
      body: JSON.stringify({ model }),
    });
    if (!retry.ok) throw await buildGatewayError(retry, 'Failed to create session');
    const data = await retry.json();
    return data.id;
  }

  if (!res.ok) throw await buildGatewayError(res, 'Failed to create session');
  const data = await res.json();
  return data.id;
}

/**
 * Send a message to the agent and return an SSE ReadableStream.
 * The caller is responsible for parsing SSE events.
 * @param agentId - which agent to chat with (defaults to geo-uploader)
 * @param model - optional model override (haiku, sonnet, opus)
 */
export async function sendMessage(sessionId: string, message: string, agentId: AgentType = DEFAULT_AGENT_ID, model?: string, userGatewayToken?: string): Promise<ReadableStream<Uint8Array> | null> {
  if (userGatewayToken) {
    console.log('[AgentProxy] Using user gateway token for', agentId);
  } else {
    console.log('[AgentProxy] No user token, falling back to server token for', agentId);
  }
  const token = userGatewayToken || await ensureToken();
  const url = `${GATEWAY_URL}/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}/chat`;
  const body: Record<string, string> = { message };
  if (model) body.model = model;

  const res = await fetch(url, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(body),
  });

  if (res.status === 401 && !userGatewayToken) {
    cachedToken = null;
    const newToken = await ensureToken();
    const retry = await fetch(url, {
      method: 'POST',
      headers: authHeaders(newToken),
      body: JSON.stringify(body),
    });
    if (!retry.ok) throw await buildGatewayError(retry, 'Chat failed');
    return retry.body;
  }

  if (!res.ok) throw await buildGatewayError(res, 'Chat failed');
  return res.body;
}

export async function requestLivekitVoiceToken(
  agentId: AgentType,
  params?: { voice?: string },
  userGatewayToken?: string,
): Promise<{ token: string; url: string; roomName: string; sessionId: string }> {
  return gatewayJsonRequest(`/agents/${encodeURIComponent(agentId)}/voice/livekit-token`, {
    method: 'POST',
    body: JSON.stringify({ voice: params?.voice }),
  }, userGatewayToken);
}

export async function startVoiceSession(
  agentId: AgentType,
  params?: { model?: string },
  userGatewayToken?: string,
): Promise<{ sessionId: string; startedAt?: string }> {
  return gatewayJsonRequest(`/agents/${encodeURIComponent(agentId)}/voice/session/start`, {
    method: 'POST',
    body: JSON.stringify({ model: params?.model }),
  }, userGatewayToken);
}

export async function endVoiceSession(
  agentId: AgentType,
  params: { sessionId: string; durationMs: number },
  userGatewayToken?: string,
): Promise<{ status?: string }> {
  return gatewayJsonRequest(`/agents/${encodeURIComponent(agentId)}/voice/session/end`, {
    method: 'POST',
    body: JSON.stringify({
      sessionId: params.sessionId,
      durationMs: params.durationMs,
    }),
  }, userGatewayToken);
}

/**
 * Parse an SSE stream and yield events.
 */
export async function* parseSSEStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<SSEEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const chunk = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        const dataLine = extractSSEData(chunk);
        if (dataLine) {
          try {
            const event: SSEEvent = JSON.parse(dataLine);
            yield event;
          } catch {
            // Skip malformed JSON
          }
        }

        boundary = buffer.indexOf('\n\n');
      }
    }

    // Process remaining buffer
    if (buffer.trim()) {
      const dataLine = extractSSEData(buffer);
      if (dataLine) {
        try {
          yield JSON.parse(dataLine);
        } catch {
          // Skip
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function extractSSEData(chunk: string): string | null {
  const lines = chunk.split('\n');
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith('data: ')) dataLines.push(line.slice(6));
    else if (line.startsWith('data:')) dataLines.push(line.slice(5));
  }
  return dataLines.length > 0 ? dataLines.join('\n') : null;
}
