import { describe, expect, it } from 'vitest';
import {
  findItem,
  getHumanApprovalBlockers,
  getMomTestEvidenceGaps,
  getQualityGates,
  getReleaseReadiness,
  getTopPriorityItem,
  listItems,
  parseFeed,
  type PriorityItem,
} from '../src/feed.js';
import { TOOL_DEFS, TOOL_NAMES } from '../src/tools.js';

describe('tool surface', () => {
  it('exposes the documented Product Copilot tools with unique names', () => {
    const names = TOOL_DEFS.map((tool) => tool.name);
    expect(names).toHaveLength(7);
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
    repo: 'rickydata_sales_coach',
    number: 5,
    title: 'Product Copilot public release: mirror manifest and leak gate',
    url: 'https://github.com/rickycambrian/rickydata_sales_coach/issues/5',
    total: 20,
    surface: 'sales-coach',
    mismatch: {
      score: 4,
      recommendedAction: 'Ask Ricky to approve the release boundary before publishing.',
      humanQuestion: 'Which private source artifacts are safe to mirror publicly?',
    },
    missingEvidence: ['human approval', 'public mirror proof'],
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
    expect(loaded.feed.itemCount).toBe(4);
  });

  it('filters and ranks priority items', () => {
    const filtered = listItems(items, { repo: 'rickydata_sales_coach', minScore: 20, limit: 10 });
    expect(filtered.map((item) => `${item.repo}#${item.number}`)).toEqual([
      'rickydata_sales_coach#6',
      'rickydata_sales_coach#5',
    ]);
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
    expect(readiness.blockers.map((item) => `${item.repo}#${item.number}`)).toEqual([
      'rickydata_sales_coach#5',
      'rickydata-product-copilot#1',
    ]);
    expect(getQualityGates().screenshotViews).toContain('Debrief / scorecard');
  });

  it('answers highest-priority Product Copilot release scope questions directly', () => {
    const top = getTopPriorityItem(items, { scope: 'product-copilot-release' });
    expect(top.item?.repo).toBe('rickydata_sales_coach');
    expect(top.item?.number).toBe(6);
  });

  it('groups missing Mom Test evidence by gap type', () => {
    const gaps = getMomTestEvidenceGaps(items, { scope: 'product-copilot-release' });
    const approval = gaps.gaps.find((gap) => gap.evidenceType === 'human approval');
    expect(approval?.count).toBe(2);
    expect(approval?.items[0]?.repo).toBe('rickydata_sales_coach');
  });

  it('lists human approval blockers with action and question context', () => {
    const blockers = getHumanApprovalBlockers(items, { scope: 'product-copilot-release' });
    expect(blockers.count).toBe(2);
    expect(blockers.blockers[0]?.recommendedAction).toContain('approve the release boundary');
    expect(blockers.blockers[0]?.humanQuestion).toContain('safe to mirror');
  });
});
