import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';

export const DEFAULT_LOCAL_FEED_PATH =
  '/root/projects/rickycambrian/rickydata_sales_coach/docs/pm/reports/human-in-loop-roadmap-feed.json';

export interface ReadConfiguredFeedOptions {
  env?: Record<string, string | undefined>;
  defaultLocalFeedPath?: string;
  localFeedExists?: (path: string) => boolean;
  readFile?: (path: string, encoding: BufferEncoding) => Promise<string>;
  fetcher?: typeof fetch;
}

export interface ProductCopilotPrivateHeaders {
  Authorization?: string;
  'X-Wallet-Address'?: string;
  'X-Derive-Session-Id'?: string;
  'X-Derive-Key'?: string;
}

export function privateFeedHeaders(env: Record<string, string | undefined> = process.env): ProductCopilotPrivateHeaders {
  const bearer = env.PRODUCT_COPILOT_PM_REPORT_BEARER_TOKEN || env.RICKYDATA_KFDB_API_KEY || env.KFDB_API_KEY;
  const wallet = env.PRODUCT_COPILOT_WALLET_ADDRESS || env.RICKYDATA_KFDB_WALLET_ADDRESS;
  const deriveSessionId = env.PRODUCT_COPILOT_KFDB_DERIVE_SESSION_ID || env.RICKYDATA_KFDB_DERIVE_SESSION_ID;
  const deriveKey = env.PRODUCT_COPILOT_KFDB_DERIVE_KEY || env.RICKYDATA_KFDB_DERIVE_KEY;
  const headers: ProductCopilotPrivateHeaders = {};
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  if (wallet) headers['X-Wallet-Address'] = wallet;
  if (deriveSessionId) headers['X-Derive-Session-Id'] = deriveSessionId;
  if (deriveKey) headers['X-Derive-Key'] = deriveKey;
  return headers;
}

export function assertPrivateFeedConfigured(env: Record<string, string | undefined> = process.env): void {
  const source = env.PRODUCT_COPILOT_PM_REPORT_URL || env.PRODUCT_COPILOT_PM_REPORT_PATH;
  const headers = privateFeedHeaders(env);
  if (!source) {
    throw new Error(
      'Product Copilot private feed is not configured: set PRODUCT_COPILOT_PM_REPORT_URL or PRODUCT_COPILOT_PM_REPORT_PATH. Public/embedded fallback is disabled.',
    );
  }
  if (!headers['X-Wallet-Address'] || !headers['X-Derive-Session-Id'] || !headers['X-Derive-Key']) {
    throw new Error(
      'Product Copilot private feed requires wallet sign-to-derive material: X-Wallet-Address, X-Derive-Session-Id, and X-Derive-Key.',
    );
  }
}

export function resolveConfiguredFeedSource(options: ReadConfiguredFeedOptions = {}):
  | { type: 'url'; value: string }
  | { type: 'path'; value: string } {
  const env = options.env ?? process.env;
  assertPrivateFeedConfigured(env);
  const url = env.PRODUCT_COPILOT_PM_REPORT_URL || '';
  if (url) return { type: 'url', value: url };

  const defaultLocalFeedPath = options.defaultLocalFeedPath ?? DEFAULT_LOCAL_FEED_PATH;
  const localFeedExists = options.localFeedExists ?? existsSync;
  const path = env.PRODUCT_COPILOT_PM_REPORT_PATH ||
    (localFeedExists(defaultLocalFeedPath) ? defaultLocalFeedPath : '');
  if (path) return { type: 'path', value: path };

  throw new Error('Product Copilot private feed path does not exist');
}

export const RESPONSE_MAX_LENGTH = parseInt(
  process.env.RESPONSE_MAX_LENGTH || '120000',
  10,
);

export async function readConfiguredFeedText(
  options: ReadConfiguredFeedOptions = {},
): Promise<{ text: string; source: string }> {
  const env = options.env ?? process.env;
  const source = resolveConfiguredFeedSource(options);

  if (source.type === 'url') {
    const fetcher = options.fetcher ?? fetch;
    const headers = privateFeedHeaders(env);
    const res = await fetcher(source.value, {
      headers: { Accept: 'application/json', ...headers },
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`PM private feed URL ${res.status}: ${text.slice(0, 200)}`);
    }
    return { text, source: source.value };
  }

  const readFile = options.readFile ?? fs.readFile;
  return {
    text: await readFile(source.value, 'utf8'),
    source: source.value,
  };
}
