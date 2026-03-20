/**
 * Voice proxy routes — mirrors the gateway URL structure that
 * @rickydata/react's useAgentVoiceChat expects:
 *
 *   POST /agents/:agentId/voice/livekit-token
 *   POST /agents/:agentId/voice/session/start
 *   POST /agents/:agentId/voice/session/end
 *
 * These proxy through to the agent gateway via AgentProxy, solving
 * CORS (browser cannot call the gateway directly).
 *
 * Auth: The SDK sends the gateway token in Authorization: Bearer.
 * We extract it and forward it to the gateway (which validates it).
 * The gateway handles auth — this proxy is just a CORS pass-through.
 */

import { Router, type Request, type Response } from 'express';
import * as AgentProxy from '../services/AgentProxy.js';

const router = Router();

/** Extract gateway token from Authorization header or X-Gateway-Token. */
function extractGatewayToken(req: Request): string | undefined {
  // SDK sends gateway token in Authorization: Bearer
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  // Fallback: app may send via X-Gateway-Token
  return req.headers['x-gateway-token'] as string | undefined;
}

router.post('/:agentId/voice/livekit-token', async (req: Request, res: Response) => {
  try {
    const agentId = req.params.agentId;
    const gatewayToken = extractGatewayToken(req);
    const { voice } = req.body as { voice?: string };

    if (!gatewayToken) {
      res.status(401).json({ error: 'Authorization required' });
      return;
    }

    const result = await AgentProxy.requestLivekitVoiceToken(
      agentId as AgentProxy.AgentType,
      { voice },
      gatewayToken,
    );

    res.json(result);
  } catch (err: any) {
    const status = err.message?.includes('402') ? 402 : 500;
    res.status(status).json({ error: err.message || 'Failed to get LiveKit token' });
  }
});

router.post('/:agentId/voice/session/start', async (req: Request, res: Response) => {
  try {
    const agentId = req.params.agentId;
    const gatewayToken = extractGatewayToken(req);
    const { model } = req.body as { model?: string };

    if (!gatewayToken) {
      res.status(401).json({ error: 'Authorization required' });
      return;
    }

    const result = await AgentProxy.startVoiceSession(
      agentId as AgentProxy.AgentType,
      { model },
      gatewayToken,
    );

    res.json(result);
  } catch (err: any) {
    const status = err.message?.includes('402') ? 402 : 500;
    res.status(status).json({ error: err.message || 'Failed to start voice session' });
  }
});

router.post('/:agentId/voice/session/end', async (req: Request, res: Response) => {
  try {
    const agentId = req.params.agentId;
    const gatewayToken = extractGatewayToken(req);
    const { sessionId, durationMs } = req.body as { sessionId?: string; durationMs?: number };

    if (!gatewayToken) {
      res.status(401).json({ error: 'Authorization required' });
      return;
    }

    const result = await AgentProxy.endVoiceSession(
      agentId as AgentProxy.AgentType,
      { sessionId: sessionId || '', durationMs: durationMs || 0 },
      gatewayToken,
    );

    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to end voice session' });
  }
});

export default router;
