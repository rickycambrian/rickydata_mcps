import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { readConfiguredFeedText } from './config.js';
import {
  findItem,
  getHumanApprovalBlockers,
  getMomTestEvidenceGaps,
  getQualityGates,
  getReleaseReadiness,
  getTopPriorityItem,
  listItems,
  parseFeed,
} from './feed.js';
import { privateSetupGuidance, setupProductCopilotPrivateTenant } from './setup.js';

export const TOOL_NAMES = [
  'setup_private_product_copilot',
  'list_priority_items',
  'get_priority_item',
  'get_release_readiness',
  'get_quality_gates',
  'get_top_priority_item',
  'get_mom_test_evidence_gaps',
  'get_human_approval_blockers',
] as const;

const SCOPE_DESCRIPTION = "Scope can be 'global', 'product-copilot-release', a repo name, or a surface name.";

export const TOOL_DEFS: Tool[] = [
  {
    name: 'setup_private_product_copilot',
    description: 'Idempotently initialize or verify the active wallet private tenant schema for Product Copilot. Safe to run repeatedly; creates deterministic merge records if missing and leaves existing schema alone.',
    inputSchema: {
      type: 'object',
      properties: {
        dry_run: { type: 'boolean', description: 'When true, validate config and show planned schema operations without writing.' },
        schema_version: { type: 'string', description: 'Optional schema version override; defaults to the current Product Copilot schema version.' },
      },
    },
  },
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
  {
    name: 'get_top_priority_item',
    description: 'Return the highest-priority item for a scope, with a short explanation suitable for deciding what to work on next.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', description: SCOPE_DESCRIPTION },
      },
    },
  },
  {
    name: 'get_mom_test_evidence_gaps',
    description: 'Group missing Mom Test / discovery evidence by evidence type and list the priority items blocked by each gap.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', description: SCOPE_DESCRIPTION },
        limit: { type: 'number', description: 'Max items per evidence gap (default 20, max 100).' },
      },
    },
  },
  {
    name: 'get_human_approval_blockers',
    description: 'List priority items that need human review, evidence, or approval before automation/release work proceeds.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', description: SCOPE_DESCRIPTION },
        limit: { type: 'number', description: 'Max blockers (default 20, max 100).' },
      },
    },
  },
];

async function loadFeed() {
  const { text, source } = await readConfiguredFeedText();
  return parseFeed(text, source);
}

function isPrivateFeedSetupError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /Product Copilot private feed|PM private feed URL|wallet sign-to-derive|private feed path/.test(err.message);
}

export async function handleToolCall(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  try {
    switch (name) {
      case 'setup_private_product_copilot':
        return setupProductCopilotPrivateTenant({
          dryRun: args.dry_run === true,
          schemaVersion: typeof args.schema_version === 'string' ? args.schema_version : undefined,
        });
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
    case 'get_top_priority_item': {
      const loaded = await loadFeed();
      return {
        source: loaded.source,
        generatedAt: loaded.feed.generatedAt,
        ...getTopPriorityItem(loaded.feed.items, { scope: args.scope as string | undefined }),
      };
    }
    case 'get_mom_test_evidence_gaps': {
      const loaded = await loadFeed();
      return {
        source: loaded.source,
        generatedAt: loaded.feed.generatedAt,
        ...getMomTestEvidenceGaps(loaded.feed.items, {
          scope: args.scope as string | undefined,
          limit: typeof args.limit === 'number' ? args.limit : undefined,
        }),
      };
    }
    case 'get_human_approval_blockers': {
      const loaded = await loadFeed();
      return {
        source: loaded.source,
        generatedAt: loaded.feed.generatedAt,
        ...getHumanApprovalBlockers(loaded.feed.items, {
          scope: args.scope as string | undefined,
          limit: typeof args.limit === 'number' ? args.limit : undefined,
        }),
      };
    }
      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    if (isPrivateFeedSetupError(err)) {
      return privateSetupGuidance(err);
    }
    throw err;
  }
}
