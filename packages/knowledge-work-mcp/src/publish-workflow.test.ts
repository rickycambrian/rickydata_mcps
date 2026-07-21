import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(
  new URL('../../../.github/workflows/publish-knowledge-work-mcp.yml', import.meta.url),
  'utf8',
);

describe('knowledge-work-mcp publish workflow', () => {
  it('requires the four delegated credentials for source-backed registration', () => {
    const expected = ['S2D_SESSION_ID', 'S2D_DERIVED_KEY', 'KFDB_WALLET_ADDRESS', 'HOME_GATEWAY_JWT'];
    const requiredBlock = workflow.match(/const requiredSecrets=\[(.*?)\n            \];/s)?.[1] ?? '';
    const requiredNames = [...requiredBlock.matchAll(/name:'([^']+)'/g)].map((match) => match[1]);
    expect(requiredNames).toEqual(expected);
    for (const name of expected) {
      expect(workflow).toMatch(new RegExp(`name:'${name}'[^\\n]+required:true`));
    }
    expect(workflow).toContain("const requiredEnvVars=registryType === 'git' ? requiredSecrets.map");
    expect(workflow).toContain('required_env_vars:{String:JSON.stringify(requiredEnvVars)}');
    expect(workflow).toContain('secrets_required:{String:JSON.stringify(declaredSecrets)}');
  });

  it('keeps the legacy private key declared as an optional escape hatch', () => {
    expect(workflow).toMatch(/name:'KNOWLEDGE_MCP_PRIVATE_KEY'[^\n]+required:false/);
    expect(workflow).not.toMatch(/name:'KNOWLEDGE_MCP_PRIVATE_KEY'[^\n]+required:true/);
  });

  it('blocks source refresh completion until production exposes the exact commit and tool count', () => {
    expect(workflow).toContain('Verify production source commit');
    expect(workflow).toContain('lastEnrichedCommitSha');
    expect(workflow).toContain('${{ github.sha }}');
    expect(workflow).toContain('toolsCount');
    expect(workflow).toContain('"$COUNT" -ne 16');
    expect(workflow).toContain('"$COUNT" -eq 16');
    expect(workflow).toContain('with 16 tools');
    expect(workflow).toContain('exit 1');
  });

  it('registers and verifies a separate four-tool public benchmark server', () => {
    expect(workflow).toContain('f09f1acc-990a-4305-97a6-8e92c196aa97');
    expect(workflow).toContain('knowledge-work-public-benchmark');
    expect(workflow).toContain('dist/public-index.js');
    expect(workflow).toContain('BENCH_EPOCH_RUNTIME_TOKEN');
    expect(workflow).toContain('Expected 4 public benchmark tools');
    expect(workflow).toContain('PUBLIC_COUNT');
    expect(workflow).toContain('"$PUBLIC_COUNT" -eq 4');
  });

  it('fails closed when the gateway cannot reload the source-backed runtime', () => {
    const syncStep = workflow.match(
      /- name: Sync server in MCP gateway \(instant single-entity refresh\)([\s\S]*?)(?=\n      - name:)/,
    )?.[1] ?? '';
    expect(syncStep).toContain("jq -r '.status // empty'");
    expect(syncStep).toContain("jq -r '.invalidatedInstances // empty'");
    expect(syncStep).toContain('[ "$STATUS" = "updated" ]');
    expect(syncStep).toContain('[[ "$INVALIDATED" =~ ^[0-9]+$ ]]');
    expect(syncStep).toContain('::error::MCP gateway single-server reload failed');
    expect(syncStep).toContain('exit 1');
    expect(syncStep).not.toContain('will pick up on next 10-min cycle');
  });

  it('uses the verified source-backed lane when the npm package is not yet bootstrapped', () => {
    expect(workflow).toContain('id: distribution');
    expect(workflow).toContain('npm_available=false');
    expect(workflow).toContain("steps.distribution.outputs.npm_available == 'true'");
    expect(workflow).toContain("steps.distribution.outputs.npm_available != 'true'");
    expect(workflow).toContain("if: steps.registry.outputs.type == 'git'");
    expect(workflow).toContain('Registering source-backed knowledge-work-mcp');
  });
});
