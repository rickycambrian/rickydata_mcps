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
  type HILFeed,
  type PriorityItem,
} from './feed.js';
import {
  PRODUCT_COPILOT_APP_ID,
  privateSetupGuidance,
  resolvePrivateTenantConfig,
  setupProductCopilotPrivateTenant,
  type SetupStatus,
} from './setup.js';

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
const PRIVATE_TENANT_SOURCE = 'kfdb-private-tenant://product-copilot/roadmap-items';

export const TOOL_DEFS: Tool[] = [
  {
    name: 'setup_private_product_copilot',
    description: 'Idempotently initialize or verify the active wallet private tenant schema for Product Copilot. Safe to run repeatedly; checks existing schema first and only creates deterministic merge records when missing.',
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
    description: 'List Product Copilot / rickydata HIL priority feed items for the active private tenant, sorted by score, with optional filters.',
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
    description: 'Fetch a single priority item by URL or by repo + issue number from the active private tenant.',
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
    description: 'Summarize Product Copilot release readiness from the active wallet private tenant.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_quality_gates',
    description: 'Return the Product Copilot release quality gates: commands, screenshot views, changelog, leak gate, and HIL approval.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_top_priority_item',
    description: 'Return the highest-priority item for a scope from the active wallet private tenant, with a short explanation suitable for deciding what to work on next.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', description: SCOPE_DESCRIPTION },
      },
    },
  },
  {
    name: 'get_mom_test_evidence_gaps',
    description: 'Group missing Mom Test / discovery evidence by evidence type and list active private-tenant priority items blocked by each gap.',
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
    description: 'List private-tenant priority items requiring human review, evidence, or approval before automation/release work proceeds.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', description: SCOPE_DESCRIPTION },
        limit: { type: 'number', description: 'Max blockers (default 20, max 100).' },
      },
    },
  },
];

function unwrapProperty(value: unknown): unknown {
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if ('String' in obj) return obj.String;
    if ('Integer' in obj) return obj.Integer;
    if ('Float' in obj) return obj.Float;
    if ('Boolean' in obj) return obj.Boolean;
  }
  return value;
}

function normalizeRow(row: unknown): Record<string, unknown> {
  if (!row || typeof row !== 'object') return {};
  const raw = row as Record<string, unknown>;
  const propsCandidate = raw.i_properties ?? raw.properties ?? raw['i.*'] ?? raw.item ?? raw;
  let props: unknown = propsCandidate;
  if (props && typeof props === 'object' && 'String' in (props as Record<string, unknown>)) {
    const maybeJson = (props as Record<string, unknown>).String;
    if (typeof maybeJson === 'string') {
      try { props = JSON.parse(maybeJson); } catch { props = {}; }
    }
  }
  if (!props || typeof props !== 'object') return {};

  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props as Record<string, unknown>)) {
    output[key] = unwrapProperty(value);
  }
  return output;
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      return value.split(',').map((item) => item.trim()).filter(Boolean);
    }
  }
  return [];
}

function asJsonObject(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function rowToPriorityItem(row: unknown): PriorityItem | null {
  const props = normalizeRow(row);
  const repo = String(props.repo ?? '');
  const number = Number(props.number ?? props.issue_number ?? NaN);
  const title = String(props.title ?? '');
  const url = String(props.url ?? props.issue_url ?? '');
  if (!repo || !Number.isFinite(number) || !title || !url) return null;

  const dimensions = asJsonObject(props.dimensions ?? props.dimensions_json);
  const mismatch = asJsonObject(props.mismatch ?? props.mismatch_json);
  return {
    repo,
    owner: props.owner ? String(props.owner) : undefined,
    surface: props.surface ? String(props.surface) : undefined,
    tier: props.tier ? String(props.tier) : undefined,
    number,
    title,
    url,
    updatedAt: props.updated_at ? String(props.updated_at) : props.updatedAt ? String(props.updatedAt) : undefined,
    labels: asStringArray(props.labels ?? props.labels_json),
    total: Number(props.total ?? props.score ?? 0),
    action: props.action ? String(props.action) : undefined,
    dimensions: dimensions as PriorityItem['dimensions'],
    reasons: asStringArray(props.reasons ?? props.reasons_json),
    missingEvidence: asStringArray(props.missing_evidence ?? props.missingEvidence ?? props.missing_evidence_json),
    mismatch: mismatch as PriorityItem['mismatch'],
  };
}

function extractRows(payload: unknown): unknown[] {
  if (!payload || typeof payload !== 'object') return [];
  const obj = payload as Record<string, unknown>;
  if (Array.isArray(obj.rows)) return obj.rows;
  if (Array.isArray(obj.data)) return obj.data;
  const result = obj.result;
  if (result && typeof result === 'object') {
    const nested = result as Record<string, unknown>;
    if (Array.isArray(nested.rows)) return nested.rows;
    if (Array.isArray(nested.data)) return nested.data;
  }
  return [];
}

async function loadPrivateTenantFeed(setupStatus: SetupStatus): Promise<{ source: string; feed: HILFeed; setup: SetupStatus }> {
  const resolved = resolvePrivateTenantConfig();
  const config = resolved.config;
  if (!config?.baseUrl || !config.authToken) {
    return {
      source: PRIVATE_TENANT_SOURCE,
      setup: setupStatus,
      feed: { generatedAt: new Date().toISOString(), itemCount: 0, items: [] },
    };
  }

  const base = config.baseUrl.replace(/\/$/, '');
  const query = `MATCH (i:RoadmapItem) WHERE i.app_id = '${PRODUCT_COPILOT_APP_ID}' RETURN i.* LIMIT 100`;
  const res = await fetch(`${base}/api/v1/query`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.authToken}`,
      'X-Wallet-Address': config.walletAddress,
    },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Product Copilot private RoadmapItem read failed: ${res.status} ${text.slice(0, 300)}`);
  }
  let parsed: unknown = {};
  try { parsed = JSON.parse(text); } catch { /* empty */ }
  const items = extractRows(parsed).map(rowToPriorityItem).filter((item): item is PriorityItem => Boolean(item));
  return {
    source: PRIVATE_TENANT_SOURCE,
    setup: setupStatus,
    feed: { generatedAt: new Date().toISOString(), itemCount: items.length, items },
  };
}

async function loadFeed(): Promise<{ source: string; feed: HILFeed; setup: SetupStatus }> {
  const setup = await setupProductCopilotPrivateTenant();
  if (!setup.ok) {
    throw new Error(`Product Copilot private tenant setup unavailable: ${setup.status}`);
  }

  try {
    const { text, source } = await readConfiguredFeedText();
    const parsed = parseFeed(text, source);
    return { ...parsed, setup };
  } catch (err) {
    if (isPrivateFeedSetupError(err)) {
      return loadPrivateTenantFeed(setup);
    }
    throw err;
  }
}

function isPrivateFeedSetupError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /Product Copilot private feed|PM private feed URL|wallet sign-to-derive|private feed path|private tenant setup unavailable/.test(err.message);
}

function sourceMetadata(loaded: { source: string; feed: HILFeed; setup: SetupStatus }) {
  return {
    source: loaded.source,
    generatedAt: loaded.feed.generatedAt,
    setup: {
      status: loaded.setup.status,
      existingSchema: loaded.setup.existingSchema,
      operationsWritten: loaded.setup.operationsWritten ?? 0,
    },
  };
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
        ...sourceMetadata(loaded),
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
      return item ?? { error: 'priority item not found', ...sourceMetadata(loaded) };
    }
    case 'get_release_readiness': {
      const loaded = await loadFeed();
      return {
        ...sourceMetadata(loaded),
        ...getReleaseReadiness(loaded.feed.items),
      };
    }
    case 'get_quality_gates':
      return getQualityGates();
    case 'get_top_priority_item': {
      const loaded = await loadFeed();
      return {
        ...sourceMetadata(loaded),
        ...getTopPriorityItem(loaded.feed.items, { scope: args.scope as string | undefined }),
      };
    }
    case 'get_mom_test_evidence_gaps': {
      const loaded = await loadFeed();
      return {
        ...sourceMetadata(loaded),
        ...getMomTestEvidenceGaps(loaded.feed.items, {
          scope: args.scope as string | undefined,
          limit: typeof args.limit === 'number' ? args.limit : undefined,
        }),
      };
    }
    case 'get_human_approval_blockers': {
      const loaded = await loadFeed();
      return {
        ...sourceMetadata(loaded),
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
