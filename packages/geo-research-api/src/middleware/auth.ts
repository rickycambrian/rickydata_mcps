import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { ethers } from 'ethers';
import crypto from 'node:crypto';
import { config } from '../config/index.js';
import { WALLET_TOKEN_PREFIX, buildTokenMessage, createWalletToken, verifyWalletToken } from './wallet-token.js';

// In-memory challenge store
const challenges = new Map<string, { message: string; nonce: string; expires_at: number; session_expires_at: string }>();

const SESSION_DURATION_MS = 24 * 60 * 60 * 1000;

declare global {
  namespace Express {
    interface Request {
      wallet?: { address: string };
    }
  }
}

export function authRequired(req: Request, res: Response, next: NextFunction): void {
  if (req.wallet) {
    next();
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authorization header required' });
    return;
  }

  const token = authHeader.slice(7);

  // Try wallet token first
  if (token.startsWith(WALLET_TOKEN_PREFIX)) {
    const result = verifyWalletToken(token);
    if (!result) {
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }
    req.wallet = { address: result.walletAddress };
    next();
    return;
  }

  // Try JWT
  try {
    const payload = jwt.verify(token, config.jwtSecret) as Record<string, unknown>;
    if (payload.wallet_address) {
      req.wallet = { address: (payload.wallet_address as string).toLowerCase() };
      next();
      return;
    }
    res.status(401).json({ error: 'Unrecognized token format' });
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

export function authOptional(req: Request, _res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    if (token.startsWith(WALLET_TOKEN_PREFIX)) {
      const result = verifyWalletToken(token);
      if (result) {
        req.wallet = { address: result.walletAddress };
      }
    } else {
      try {
        const payload = jwt.verify(token, config.jwtSecret) as Record<string, unknown>;
        if (payload.wallet_address) {
          req.wallet = { address: (payload.wallet_address as string).toLowerCase() };
        }
      } catch {
        // Invalid token, continue without auth
      }
    }
  }
  next();
}

function schedulerAuthorized(req: Request): boolean {
  const configuredSecret = config.scheduler.secret?.trim();
  if (!configuredSecret) return false;

  const headerSecret = req.headers['x-scheduler-secret'];
  if (typeof headerSecret === 'string' && headerSecret === configuredSecret) {
    return true;
  }

  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    if (token === configuredSecret) return true;
  }

  return false;
}

export function authOrSchedulerRequired(req: Request, res: Response, next: NextFunction): void {
  if (schedulerAuthorized(req)) {
    req.wallet = req.wallet || { address: 'scheduler' };
    next();
    return;
  }

  authRequired(req, res, next);
}

export function createChallenge(walletAddress: string) {
  const nonce = crypto.randomBytes(32).toString('hex');
  const expires_at = Date.now() + 5 * 60 * 1000;
  const session_expires_at = new Date(Date.now() + SESSION_DURATION_MS).toISOString();
  const message = buildTokenMessage(walletAddress, session_expires_at);

  challenges.set(walletAddress.toLowerCase(), { message, nonce, expires_at, session_expires_at });
  return { message, nonce, expires_at, session_expires_at };
}

export function verifySignature(walletAddress: string, signature: string) {
  const addr = walletAddress.toLowerCase();
  const challenge = challenges.get(addr);

  if (!challenge) {
    throw new Error('No pending challenge for this wallet');
  }

  if (Date.now() > challenge.expires_at) {
    challenges.delete(addr);
    throw new Error('Challenge expired');
  }

  const recoveredAddress = ethers.verifyMessage(challenge.message, signature);
  if (recoveredAddress.toLowerCase() !== addr) {
    throw new Error('Signature verification failed');
  }

  challenges.delete(addr);

  const token = createWalletToken(walletAddress, signature, challenge.session_expires_at);
  if (!token) {
    throw new Error('Signature verification failed');
  }

  return { token, wallet_address: ethers.getAddress(walletAddress), expires_at: challenge.session_expires_at };
}
