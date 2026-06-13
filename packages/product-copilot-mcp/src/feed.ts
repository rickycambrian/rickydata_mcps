export interface PriorityDimensions {
  evidence?: number;
  publicShipLeverage?: number;
  narrativeArcStrength?: number;
  learningVelocity?: number;
  strategicFit?: number;
  humanInLoopValue?: number;
  agentExecutionReadiness?: number;
  effort?: number;
  risk?: number;
  scopeSprawl?: number;
}

export interface MismatchReview {
  score?: number;
  reasons?: string[];
  recommendedAction?: string;
  humanQuestion?: string;
}

export interface PriorityItem {
  repo: string;
  owner?: string;
  surface?: string;
  tier?: string;
  canonicalRepoRef?: string;
  repositoryEntityId?: string;
  number: number;
  title: string;
  url: string;
  updatedAt?: string;
  labels?: string[];
  total: number;
  action?: string;
  dimensions?: PriorityDimensions;
  reasons?: string[];
  missingEvidence?: string[];
  mismatch?: MismatchReview;
}

export interface HILFeed {
  generatedAt: string;
  itemCount: number;
  items: PriorityItem[];
}

export interface LoadedFeed {
  source: string;
  feed: HILFeed;
}

const PRODUCT_COPILOT_RELEASE_REPOS = new Set([
  'rickydata_sales_coach',
  'rickydata-product-copilot',
  'rickydata_github',
]);

function prioritySort(a: PriorityItem, b: PriorityItem): number {
  return b.total - a.total || (b.mismatch?.score ?? 0) - (a.mismatch?.score ?? 0);
}

function inScope(item: PriorityItem, scope?: string): boolean {
  if (!scope || scope === 'global') return true;
  if (scope === 'product-copilot-release') return PRODUCT_COPILOT_RELEASE_REPOS.has(item.repo);
  return item.repo === scope || item.surface === scope;
}

export function parseFeed(text: string, source: string): LoadedFeed {
  const parsed = JSON.parse(text) as Partial<HILFeed>;
  if (!Array.isArray(parsed.items)) {
    throw new Error(`Invalid HIL feed from ${source}: missing items[]`);
  }
  return {
    source,
    feed: {
      generatedAt: String(parsed.generatedAt ?? ''),
      itemCount: Number(parsed.itemCount ?? parsed.items.length),
      items: parsed.items as PriorityItem[],
    },
  };
}

export function listItems(
  items: PriorityItem[],
  opts: {
    repo?: string;
    surface?: string;
    minScore?: number;
    minMismatch?: number;
    actionContains?: string;
    limit?: number;
  },
): PriorityItem[] {
  const limit = Math.min(Math.max(Math.floor(opts.limit ?? 20), 1), 100);
  return items
    .filter((item) => !opts.repo || item.repo === opts.repo)
    .filter((item) => !opts.surface || item.surface === opts.surface)
    .filter((item) => opts.minScore === undefined || item.total >= opts.minScore)
    .filter((item) => opts.minMismatch === undefined || (item.mismatch?.score ?? 0) >= opts.minMismatch)
    .filter((item) => !opts.actionContains || (item.action ?? '').toLowerCase().includes(opts.actionContains.toLowerCase()))
    .sort(prioritySort)
    .slice(0, limit);
}

export function findItem(items: PriorityItem[], args: { repo?: string; number?: number; url?: string }): PriorityItem | undefined {
  if (args.url) return items.find((item) => item.url === args.url);
  if (args.repo && typeof args.number === 'number') {
    return items.find((item) => item.repo === args.repo && item.number === args.number);
  }
  return undefined;
}

export function getQualityGates() {
  return {
    requiredCommands: [
      'npm run typecheck',
      'npm test',
      'npm run build',
      'npm run ui:build',
    ],
    liveProviderCommandsWhenKeysAreAvailable: [
      'npm run providers:check',
      'npm run smoke',
      'npm run eval:classifier',
      'npm run eval:simulator',
      'npm run eval:grounding',
    ],
    screenshotViews: [
      'Home / product entry',
      'Scenario/examples selection',
      'Conversation view',
      'Debrief / scorecard',
      'Evidence ledger',
      'Projects view',
      'Insights view',
      'Narrative/refinement view',
      'Error/empty state if relevant',
      'Mobile or narrow viewport smoke screenshot',
    ],
    releaseGates: [
      'Product scope lock',
      'Offline deterministic verification',
      'UI build verification',
      'Screenshot proof',
      'Human-in-loop review',
      'Public mirror/leak gate',
      'Changelog and known limitations',
    ],
  };
}

export function getTopPriorityItem(items: PriorityItem[], opts: { scope?: string } = {}) {
  const scoped = items.filter((item) => inScope(item, opts.scope)).sort(prioritySort);
  const top = scoped[0];
  return {
    scope: opts.scope ?? 'global',
    item: top ?? null,
    explanation: top
      ? [
          `Highest score in scope: ${top.total}.`,
          top.mismatch?.score !== undefined ? `Human-objective mismatch score: ${top.mismatch.score}.` : undefined,
          top.action ? `Recommended action: ${top.action}` : undefined,
        ].filter(Boolean)
      : ['No priority items matched the requested scope.'],
  };
}

export function getMomTestEvidenceGaps(items: PriorityItem[], opts: { scope?: string; limit?: number } = {}) {
  const limit = Math.min(Math.max(Math.floor(opts.limit ?? 20), 1), 100);
  const grouped = new Map<string, PriorityItem[]>();
  for (const item of items.filter((candidate) => inScope(candidate, opts.scope))) {
    for (const gap of item.missingEvidence ?? []) {
      const key = gap.trim();
      if (!key) continue;
      grouped.set(key, [...(grouped.get(key) ?? []), item]);
    }
  }

  return {
    scope: opts.scope ?? 'global',
    gaps: [...grouped.entries()]
      .map(([evidenceType, gapItems]) => ({
        evidenceType,
        count: gapItems.length,
        items: gapItems.sort(prioritySort).slice(0, limit).map((item) => ({
          repo: item.repo,
          number: item.number,
          title: item.title,
          url: item.url,
          score: item.total,
          mismatch: item.mismatch,
        })),
      }))
      .sort((a, b) => b.count - a.count || a.evidenceType.localeCompare(b.evidenceType)),
  };
}

export function getHumanApprovalBlockers(items: PriorityItem[], opts: { scope?: string; limit?: number } = {}) {
  const limit = Math.min(Math.max(Math.floor(opts.limit ?? 20), 1), 100);
  const blockers = items
    .filter((item) => inScope(item, opts.scope))
    .filter((item) => (item.mismatch?.score ?? 0) >= 4 || (item.missingEvidence ?? []).length > 0)
    .sort(prioritySort)
    .slice(0, limit)
    .map((item) => ({
      repo: item.repo,
      number: item.number,
      title: item.title,
      url: item.url,
      score: item.total,
      mismatchScore: item.mismatch?.score ?? 0,
      recommendedAction: item.mismatch?.recommendedAction ?? item.action,
      humanQuestion: item.mismatch?.humanQuestion,
      reasons: item.mismatch?.reasons ?? [],
      missingEvidence: item.missingEvidence ?? [],
    }));

  return {
    scope: opts.scope ?? 'global',
    count: blockers.length,
    blockers,
  };
}

export function getReleaseReadiness(items: PriorityItem[]) {
  const releaseItems = items.filter((item) => PRODUCT_COPILOT_RELEASE_REPOS.has(item.repo));
  const gates = getQualityGates();
  const blockers = releaseItems
    .filter((item) => (item.mismatch?.score ?? 0) >= 4 || item.missingEvidence?.length)
    .sort(prioritySort)
    .slice(0, 12)
    .map((item) => ({
      repo: item.repo,
      number: item.number,
      title: item.title,
      url: item.url,
      score: item.total,
      mismatch: item.mismatch,
      missingEvidence: item.missingEvidence ?? [],
    }));

  return {
    product: 'rickydata Product Copilot',
    privateSourceRepo: 'rickydata_sales_coach',
    publicReleaseRepo: 'rickydata-product-copilot',
    currentStatus: blockers.length === 0 ? 'ready-for-human-release-review' : 'release-candidate-work-required',
    releaseItems: releaseItems.length,
    blockers,
    gates,
    nextBestActions: [
      'Build Product Copilot screenshot proof harness.',
      'Build private-to-public mirror manifest and leak gate.',
      'Expose release candidate review cards in rickydata_github /roadmap.',
      'Only publish public releases after HIL approval is recorded.',
    ],
  };
}
