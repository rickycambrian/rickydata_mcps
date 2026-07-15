import packageJson from '../package.json' with { type: 'json' };

export const PACKAGE_VERSION = packageJson.version;

export type RuntimeIdentity = {
  server: 'knowledge-work-mcp';
  version: string;
  source_commit: string | null;
};

export function getRuntimeIdentity(env: NodeJS.ProcessEnv = process.env): RuntimeIdentity {
  const candidate = env.MCP_SOURCE_COMMIT_SHA?.trim() || '';
  const sourceCommit = /^[0-9a-f]{7,64}$/i.test(candidate) ? candidate.toLowerCase() : null;
  return {
    server: 'knowledge-work-mcp',
    version: PACKAGE_VERSION,
    source_commit: sourceCommit,
  };
}

export function withRuntimeIdentity(result: unknown): Record<string, unknown> {
  const runtimeIdentity = getRuntimeIdentity();
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const entries = Object.entries(result as Record<string, unknown>)
      .filter(([key]) => key !== 'runtime_identity');
    return Object.fromEntries([
      ['runtime_identity', runtimeIdentity],
      ...entries,
    ]);
  }
  return { runtime_identity: runtimeIdentity, result };
}
