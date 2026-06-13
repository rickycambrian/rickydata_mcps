import { describe, expect, it } from 'vitest';
import {
  findItem,
  getQualityGates,
  getReleaseReadiness,
  listItems,
  parseFeed,
  type PriorityItem,
} from '../src/feed.js';
import { TOOL_DEFS, TOOL_NAMES } from '../src/tools.js';

describe('tool surface', () => {
  it('exposes the documented Product Copilot tools with unique names', () => {
    const names = TOOL_DEFS.map((tool) => tool.name);
    expect(names).toHaveLength(4);
    expect(new Set(names).size).toBe(names.length);
    for (const expected of TOOL_NAMES) expect(names).toContain(expected);
  });
});

const items: PriorityItem[] = [
  {
    repo: 'rickydata_sales_coach',
    number: 6,
    title: 'Product Copilot release quality: screenshot proof harness',
    url: 'https://github.com/rickycambrian/rickydata_sales_coach/issues/6',
    total: 21,
    surface: 'sales-coach',
    mismatch: { score: 0 },
    missingEvidence: [],
  },
  {
    repo: 'rickydata-product-copilot',
    number: 1,
    title: 'Release candidate: initialize v0.1 Product Copilot public release',
    url: 'https://github.com/rickycambrian/rickydata-product-copilot/issues/1',
    total: 14,
    surface: 'product-copilot-public',
    mismatch: { score: 5 },
    missingEvidence: ['human approval'],
  },
  {
    repo: 'rickydata_bench',
    number: 39,
    title: 'Benchmark issue',
    url: 'https://github.com/rickycambrian/rickydata_bench/issues/39',
    total: 22,
    surface: 'bench',
    mismatch: { score: 4 },
  },
];

describe('priority feed helpers', () => {
  it('parses the HIL feed shape and preserves source metadata', () => {
    const loaded = parseFeed(JSON.stringify({ generatedAt: 'now', items }), 'fixture');
    expect(loaded.source).toBe('fixture');
    expect(loaded.feed.itemCount).toBe(3);
  });

  it('filters and ranks priority items', () => {
    const filtered = listItems(items, { repo: 'rickydata_sales_coach', minScore: 20, limit: 10 });
    expect(filtered.map((item) => `${item.repo}#${item.number}`)).toEqual(['rickydata_sales_coach#6']);
  });

  it('finds priority items by url or repo/number', () => {
    expect(findItem(items, { repo: 'rickydata-product-copilot', number: 1 })?.title).toContain('Release candidate');
    expect(findItem(items, { url: items[0].url })?.number).toBe(6);
  });

  it('summarizes Product Copilot release readiness and gates', () => {
    const readiness = getReleaseReadiness(items);
    expect(readiness.privateSourceRepo).toBe('rickydata_sales_coach');
    expect(readiness.publicReleaseRepo).toBe('rickydata-product-copilot');
    expect(readiness.currentStatus).toBe('release-candidate-work-required');
    expect(readiness.blockers.length).toBeGreaterThan(0);
    expect(getQualityGates().screenshotViews).toContain('Debrief / scorecard');
  });
});
