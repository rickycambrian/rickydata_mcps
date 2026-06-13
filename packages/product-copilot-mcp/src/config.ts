import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { EMBEDDED_PUBLIC_FEED_TEXT } from './default-feed.js';

export const DEFAULT_LOCAL_FEED_PATH =
  '/root/projects/rickycambrian/rickydata_sales_coach/docs/pm/reports/human-in-loop-roadmap-feed.json';

export const EMBEDDED_PUBLIC_FEED_SOURCE = 'embedded:product-copilot-public-feed';

export interface ReadConfiguredFeedOptions {
  env?: Record<string, string | undefined>;
  defaultLocalFeedPath?: string;
  localFeedExists?: (path: string) => boolean;
  readFile?: (path: string, encoding: BufferEncoding) => Promise<string>;
  fetcher?: typeof fetch;
}

export function resolveConfiguredFeedSource(options: ReadConfiguredFeedOptions = {}):
  | { type: 'url'; value: string }
  | { type: 'path'; value: string }
  | { type: 'embedded'; value: typeof EMBEDDED_PUBLIC_FEED_SOURCE } {
  const env = options.env ?? process.env;
  const url = env.PRODUCT_COPILOT_PM_REPORT_URL || '';
  if (url) return { type: 'url', value: url };

  const defaultLocalFeedPath = options.defaultLocalFeedPath ?? DEFAULT_LOCAL_FEED_PATH;
  const localFeedExists = options.localFeedExists ?? existsSync;
  const path = env.PRODUCT_COPILOT_PM_REPORT_PATH ||
    (localFeedExists(defaultLocalFeedPath) ? defaultLocalFeedPath : '');
  if (path) return { type: 'path', value: path };

  return { type: 'embedded', value: EMBEDDED_PUBLIC_FEED_SOURCE };
}

export const RESPONSE_MAX_LENGTH = parseInt(
  process.env.RESPONSE_MAX_LENGTH || '120000',
  10,
);

export async function readConfiguredFeedText(
  options: ReadConfiguredFeedOptions = {},
): Promise<{ text: string; source: string }> {
  const source = resolveConfiguredFeedSource(options);

  if (source.type === 'url') {
    const fetcher = options.fetcher ?? fetch;
    const res = await fetcher(source.value, {
      headers: { Accept: 'application/json' },
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`PM feed URL ${res.status}: ${text.slice(0, 200)}`);
    }
    return { text, source: source.value };
  }

  if (source.type === 'embedded') {
    return { text: EMBEDDED_PUBLIC_FEED_TEXT, source: source.value };
  }

  const readFile = options.readFile ?? fs.readFile;
  return {
    text: await readFile(source.value, 'utf8'),
    source: source.value,
  };
}
