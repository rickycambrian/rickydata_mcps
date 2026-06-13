import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { readConfiguredFeedText } from './config.js';
import {
  findItem,
  getQualityGates,
  getReleaseReadiness,
  listItems,
  parseFeed,
} from './feed.js';

export const TOOL_NAMES = [
  'list_priority_items',
  'get_priority_item',
  'get_release_readiness',
  'get_quality_gates',
] as const;

export const TOOL_DEFS: Tool[] = [
  {
    name: 'list_priority_items',
    description: 'List Product Copilot / rickydata HIL priority feed items, sorted by score, with optional repo/surface/mismatch filters.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: "Filter by repo, e.g. 'rickydata_sales_coach'." },
        surface: { type: 'string', description: "Filter by PM surface, e.g. 'product-copilot-public'." },
        min_score: { type: 'number', description: 'Minimum total priority score.' },
        min_mismatch: { type: 'number', description: 'Minimum human-objective mismatch score.' },
        action_contains: { type: 'string', description: 'Case-insensitive substring match on recommended action.' },
        limit: { type: 'number', description: 'Max items (default 20, max 100).' },
      },
    },
  },
  {
    name: 'get_priority_item',
    description: 'Fetch a single priority item by URL or by repo + issue number.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: "Repo name, e.g. 'rickydata_sales_coach'." },
        number: { type: 'number', description: 'GitHub issue number.' },
        url: { type: 'string', description: 'Full GitHub issue URL.' },
      },
    },
  },
  {
    name: 'get_release_readiness',
    description: 'Summarize Product Copilot release readiness, including private/public repo pairing, blockers, and required quality gates.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_quality_gates',
    description: 'Return the Product Copilot release quality gates: commands, screenshot views, changelog, leak gate, and HIL approval.',
    inputSchema: { type: 'object', properties: {} },
  },
];

async function loadFeed() {
  const { text, source } = await readConfiguredFeedText();
  return parseFeed(text, source);
}

export async function handleToolCall(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  switch (name) {
    case 'list_priority_items': {
      const loaded = await loadFeed();
      const items = listItems(loaded.feed.items, {
        repo: args.repo as string | undefined,
        surface: args.surface as string | undefined,
        minScore: typeof args.min_score === 'number' ? args.min_score : undefined,
        minMismatch: typeof args.min_mismatch === 'number' ? args.min_mismatch : undefined,
        actionContains: args.action_contains as string | undefined,
        limit: typeof args.limit === 'number' ? args.limit : undefined,
      });
      return {
        source: loaded.source,
        generatedAt: loaded.feed.generatedAt,
        count: items.length,
        items,
      };
    }
    case 'get_priority_item': {
      const loaded = await loadFeed();
      const item = findItem(loaded.feed.items, {
        repo: args.repo as string | undefined,
        number: typeof args.number === 'number' ? args.number : undefined,
        url: args.url as string | undefined,
      });
      return item ?? { error: 'priority item not found', source: loaded.source };
    }
    case 'get_release_readiness': {
      const loaded = await loadFeed();
      return {
        source: loaded.source,
        generatedAt: loaded.feed.generatedAt,
        ...getReleaseReadiness(loaded.feed.items),
      };
    }
    case 'get_quality_gates':
      return getQualityGates();
    default:
      return { error: `Unknown tool: ${name}` };
  }
}
