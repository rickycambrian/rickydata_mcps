import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as crypto from 'crypto';

// Load .env from monorepo root
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const nodeEnv = process.env.NODE_ENV || 'development';
const rawJwtSecret = process.env.JWT_SECRET;

let jwtSecret: string;
if (!rawJwtSecret?.trim()) {
  jwtSecret = crypto.randomBytes(32).toString('hex');
  console.warn('[CONFIG] JWT_SECRET not set; using ephemeral secret.');
} else {
  jwtSecret = rawJwtSecret.trim();
}

export const config = {
  port: parseInt(process.env.PORT || '3002', 10),
  nodeEnv,
  jwtSecret,
  scheduler: {
    secret: process.env.SCHEDULER_SECRET || '',
  },
  worker: {
    pollIntervalMs: parseInt(process.env.WORKER_POLL_INTERVAL_MS || '15000', 10),
  },
  kfdb: {
    url: process.env.KFDB_URL || 'http://34.60.37.158',
    apiKey: process.env.KFDB_API_KEY || '',
  },
  agentGateway: {
    url: process.env.AGENT_GATEWAY_URL || 'https://agents.rickydata.org',
    privateKey: process.env.AGENT_GATEWAY_PRIVATE_KEY || '',
  },
  geo: {
    privateKey: process.env.GEO_PRIVATE_KEY || '',
    graphqlUrl: process.env.GEO_GRAPHQL_URL || 'https://testnet-api.geobrowser.io/graphql',
  },
  cors: {
    origin: process.env.CORS_ORIGIN || '*',
  },
} as const;
