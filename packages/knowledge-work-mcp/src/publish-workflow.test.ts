import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(
  new URL('../../../.github/workflows/publish-knowledge-work-mcp.yml', import.meta.url),
  'utf8',
);

describe('knowledge-work-mcp publish workflow', () => {
  it('blocks source refresh completion until production exposes the exact commit and tool count', () => {
    expect(workflow).toContain('Verify production source commit');
    expect(workflow).toContain('lastEnrichedCommitSha');
    expect(workflow).toContain('${{ github.sha }}');
    expect(workflow).toContain('toolsCount');
    expect(workflow).toContain('exit 1');
  });
});
