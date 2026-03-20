import { Router, type Request, type Response } from 'express';
import { createChallenge, verifySignature } from '../middleware/auth.js';
import { config } from '../config/index.js';

const router = Router();

const GATEWAY_URL = config.agentGateway.url;

router.post('/challenge', (req: Request, res: Response) => {
  const { walletAddress } = req.body;
  if (!walletAddress) {
    res.status(400).json({ error: 'walletAddress required' });
    return;
  }

  try {
    const challenge = createChallenge(walletAddress);
    res.json(challenge);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/verify', async (req: Request, res: Response) => {
  const { walletAddress, signature } = req.body;
  if (!walletAddress || !signature) {
    res.status(400).json({ error: 'walletAddress and signature required' });
    return;
  }

  try {
    const result = verifySignature(walletAddress, signature);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// --- Gateway auth proxy (avoids CORS from browser → agents.rickydata.org) ---

router.get('/gateway/challenge', async (req: Request, res: Response) => {
  const walletAddress = req.query.walletAddress as string;
  if (!walletAddress) {
    res.status(400).json({ error: 'walletAddress query param required' });
    return;
  }

  try {
    const upstream = await fetch(
      `${GATEWAY_URL}/auth/challenge?walletAddress=${encodeURIComponent(walletAddress)}`,
    );
    if (!upstream.ok) {
      const body = await upstream.text();
      res.status(upstream.status).json({ error: body || `Gateway challenge failed: ${upstream.status}` });
      return;
    }
    const data = await upstream.json();
    res.json(data);
  } catch (err: any) {
    res.status(502).json({ error: err.message || 'Failed to reach gateway' });
  }
});

router.post('/gateway/verify', async (req: Request, res: Response) => {
  const { walletAddress, signature, nonce } = req.body;
  if (!walletAddress || !signature || !nonce) {
    res.status(400).json({ error: 'walletAddress, signature, and nonce required' });
    return;
  }

  try {
    const upstream = await fetch(`${GATEWAY_URL}/auth/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ walletAddress, signature, nonce }),
    });
    if (!upstream.ok) {
      const body = await upstream.text();
      res.status(upstream.status).json({ error: body || `Gateway verify failed: ${upstream.status}` });
      return;
    }
    const data = await upstream.json();
    res.json(data);
  } catch (err: any) {
    res.status(502).json({ error: err.message || 'Failed to reach gateway' });
  }
});

// --- Gateway wallet balance proxy ---

router.get('/gateway/wallet/balance', async (req: Request, res: Response) => {
  const gatewayToken = req.headers['x-gateway-token'] as string;
  if (!gatewayToken) {
    res.status(401).json({ error: 'X-Gateway-Token header required' });
    return;
  }

  try {
    const upstream = await fetch(`${GATEWAY_URL}/wallet/balance`, {
      headers: { Authorization: `Bearer ${gatewayToken}` },
    });
    if (!upstream.ok) {
      const body = await upstream.text();
      res.status(upstream.status).json({ error: body || `Gateway wallet balance failed: ${upstream.status}` });
      return;
    }
    const data = await upstream.json();
    res.json(data);
  } catch (err: any) {
    res.status(502).json({ error: err.message || 'Failed to reach gateway' });
  }
});

export default router;
