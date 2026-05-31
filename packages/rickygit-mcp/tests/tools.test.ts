import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveRickygitBin, runRickygit } from '../src/rickygit.js';
import { TOOL_DEFS } from '../src/tools.js';

describe('rickygit-mcp tool definitions', () => {
  it('defines unique tool names', () => {
    const names = TOOL_DEFS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('exposes the comms + work-ledger surface', () => {
    const names = TOOL_DEFS.map((t) => t.name);
    for (const expected of [
      'rickygit_init',
      'rickygit_work_start',
      'rickygit_note_send',
      'rickygit_note_inbox',
      'rickygit_note_list',
    ]) {
      expect(names).toContain(expected);
    }
  });

  it('work_start defaults to in-place and is opt-out', () => {
    const def = TOOL_DEFS.find((t) => t.name === 'rickygit_work_start')!;
    expect(def.buildArgs({ objective: 'o', agent_id: 'a' })).toContain('--in-place');
    expect(def.buildArgs({ objective: 'o', agent_id: 'a', in_place: false })).not.toContain('--in-place');
  });

  it('note_send threads refs through as repeated --ref flags', () => {
    const def = TOOL_DEFS.find((t) => t.name === 'rickygit_note_send')!;
    const args = def.buildArgs({ from: 'a', to: 'kai', text: 'hi', refs: ['sha256:1', 'sha256:2'] });
    const refCount = args.filter((a) => a === '--ref').length;
    expect(refCount).toBe(2);
    expect(args).toContain('sha256:1');
    expect(args).toContain('sha256:2');
  });
});

// Live round-trip — only runs when a rickygit binary and git are available.
const bin = resolveRickygitBin();
const hasBin = bin !== 'rickygit' || existsSync(bin);
const hasGit = spawnSync('git', ['--version']).status === 0;

describe.runIf(hasBin && hasGit)('rickygit-mcp live round-trip', () => {
  let repo: string;

  beforeAll(() => {
    repo = mkdtempSync(path.join(tmpdir(), 'rickygit-mcp-'));
    const git = (args: string[]) => execFileSync('git', args, { cwd: repo });
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.email', 't@t.com']);
    git(['config', 'user.name', 't']);
    writeFileSync(path.join(repo, 'README.md'), '# t\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'init']);
  });

  afterAll(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  it('init + note send + inbox round-trips', async () => {
    const init = await runRickygit(['init', '--repo', repo, '--json']);
    expect(init.success).toBe(true);

    const sent = await runRickygit([
      'note', 'send', '--repo', repo, '--from', 'agent:hermes', '--to', 'claude-code',
      '--text', 'mcp round-trip', '--json',
    ]);
    expect(sent.success).toBe(true);
    const sentJson = sent.json as { status: string; object: { object_id: string } };
    expect(sentJson.status).toBe('ok');
    expect(sentJson.object.object_id.startsWith('sha256:')).toBe(true);

    const inbox = await runRickygit(['note', 'inbox', '--repo', repo, '--agent', 'claude-code', '--json']);
    expect(inbox.success).toBe(true);
    const inboxJson = inbox.json as { count: number };
    expect(inboxJson.count).toBe(1);
  });
});
