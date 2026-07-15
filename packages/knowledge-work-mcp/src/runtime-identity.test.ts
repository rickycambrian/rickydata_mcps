import { afterEach, describe, expect, it } from 'vitest';
import packageJson from '../package.json' with { type: 'json' };
import { fail, ok } from './response.js';
import { getRuntimeIdentity } from './runtime-identity.js';

const originalSourceCommit = process.env.MCP_SOURCE_COMMIT_SHA;

afterEach(() => {
  if (originalSourceCommit === undefined) delete process.env.MCP_SOURCE_COMMIT_SHA;
  else process.env.MCP_SOURCE_COMMIT_SHA = originalSourceCommit;
});

describe('knowledge-work-mcp runtime identity', () => {
  it('adds the exact reviewed source commit to successful tool responses', () => {
    process.env.MCP_SOURCE_COMMIT_SHA = 'ABC123DEF4567890';

    const result = ok({ status: 'ok', value: 42 });
    const body = JSON.parse(result.content[0]!.text);

    expect(Object.keys(body)[0]).toBe('runtime_identity');
    expect(body.runtime_identity).toEqual({
      server: 'knowledge-work-mcp',
      version: packageJson.version,
      source_commit: 'abc123def4567890',
    });
    expect(body).toMatchObject({ status: 'ok', value: 42 });
  });

  it('reports a null source commit when the runtime did not receive a valid reviewed SHA', () => {
    process.env.MCP_SOURCE_COMMIT_SHA = 'main; echo unreviewed';

    expect(getRuntimeIdentity()).toEqual({
      server: 'knowledge-work-mcp',
      version: packageJson.version,
      source_commit: null,
    });
  });

  it('adds runtime identity to structured tool failures', () => {
    process.env.MCP_SOURCE_COMMIT_SHA = 'deadbeef12345678';

    const result = fail(new Error('expected failure'));
    const body = JSON.parse(result.content[0]!.text);

    expect(body.runtime_identity.source_commit).toBe('deadbeef12345678');
    expect(body).toMatchObject({ error: 'tool_error', message: 'expected failure' });
  });
});
