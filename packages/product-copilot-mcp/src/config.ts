import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';

export const DEFAULT_LOCAL_FEED_PATH =
  '/root/projects/rickycambrian/rickydata_sales_coach/docs/pm/reports/human-in-loop-roadmap-feed.json';

export const PRODUCT_COPILOT_PM_REPORT_PATH =
  process.env.PRODUCT_COPILOT_PM_REPORT_PATH ||
  (existsSync(DEFAULT_LOCAL_FEED_PATH) ? DEFAULT_LOCAL_FEED_PATH : '');

export const PRODUCT_COPILOT_PM_REPORT_URL =
  process.env.PRODUCT_COPILOT_PM_REPORT_URL || '';

export const RESPONSE_MAX_LENGTH = parseInt(
  process.env.RESPONSE_MAX_LENGTH || '120000',
  10,
);

export async function readConfiguredFeedText(): Promise<{ text: string; source: string }> {
  if (PRODUCT_COPILOT_PM_REPORT_URL) {
    const res = await fetch(PRODUCT_COPILOT_PM_REPORT_URL, {
      headers: { Accept: 'application/json' },
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`PM feed URL ${res.status}: ${text.slice(0, 200)}`);
    }
    return { text, source: PRODUCT_COPILOT_PM_REPORT_URL };
  }

  if (!PRODUCT_COPILOT_PM_REPORT_PATH) {
    throw new Error(
      'Set PRODUCT_COPILOT_PM_REPORT_URL or PRODUCT_COPILOT_PM_REPORT_PATH.',
    );
  }

  return {
    text: await fs.readFile(PRODUCT_COPILOT_PM_REPORT_PATH, 'utf8'),
    source: PRODUCT_COPILOT_PM_REPORT_PATH,
  };
}
