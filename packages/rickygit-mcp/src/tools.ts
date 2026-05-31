import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z, type ZodRawShape } from 'zod';
import { defaultRelayUrl, defaultRepo, runRickygit } from './rickygit.js';

type ToolInput = Record<string, unknown>;

interface ToolDef {
  name: string;
  description: string;
  schema: ZodRawShape;
  buildArgs: (input: ToolInput) => string[];
}

function repoOf(input: ToolInput): string {
  return (input.repo as string | undefined) ?? defaultRepo();
}

function pushStr(args: string[], flag: string, value: unknown): void {
  if (typeof value === 'string' && value.length > 0) {
    args.push(flag, value);
  }
}

const repoField = {
  repo: z
    .string()
    .optional()
    .describe('Repository path. Defaults to RICKYGIT_REPO or the server cwd.'),
};

export const TOOL_DEFS: ToolDef[] = [
  {
    name: 'rickygit_init',
    description:
      'Initialize the rickydata sidecar (.git/rickydata + refs/rickydata) in a repo. Local-only, ignored by normal git, reversible.',
    schema: { ...repoField },
    buildArgs: (input) => ['init', '--repo', repoOf(input), '--json'],
  },
  {
    name: 'rickygit_status',
    description: 'Read-only readiness status of the rickydata sidecar (store, verify, optional remote parity).',
    schema: {
      ...repoField,
      remote: z.string().optional().describe('Git remote to check ref parity against, e.g. origin.'),
    },
    buildArgs: (input) => {
      const args = ['status', '--repo', repoOf(input)];
      pushStr(args, '--remote', input.remote);
      args.push('--json');
      return args;
    },
  },
  {
    name: 'rickygit_work_start',
    description:
      'Start work: create a WorkIntent + AgentAttempt. Defaults to in-place (records against the current working tree, no isolated worktree).',
    schema: {
      ...repoField,
      objective: z.string().describe('Clear task objective.'),
      agent_id: z.string().describe('Agent identity, e.g. agent:claude-code.'),
      idempotency_key: z.string().optional().describe('Stable key so repeated starts are idempotent.'),
      issue_repository: z.string().optional().describe('owner/repo when binding to a GitHub issue.'),
      issue_id: z.string().optional().describe('Issue number when binding to a GitHub issue.'),
      in_place: z
        .boolean()
        .optional()
        .describe('Record against the main working tree (default true). Set false for an isolated worktree.'),
    },
    buildArgs: (input) => {
      const args = [
        'work',
        'start',
        '--repo',
        repoOf(input),
        '--objective',
        String(input.objective ?? ''),
        '--agent-id',
        String(input.agent_id ?? ''),
      ];
      if (input.in_place !== false) args.push('--in-place');
      pushStr(args, '--idempotency-key', input.idempotency_key);
      pushStr(args, '--issue-repository', input.issue_repository);
      pushStr(args, '--issue-id', input.issue_id);
      args.push('--json');
      return args;
    },
  },
  {
    name: 'rickygit_note_send',
    description:
      'Send a signed, content-addressed agent note (fast-lane coordination). `to` is an agent name, `all` (broadcast), or `kai` (human).',
    schema: {
      ...repoField,
      from: z.string().describe('Sender agent id.'),
      to: z.string().describe('Recipient: an agent name, `all`, or `kai`.'),
      text: z.string().describe('Note body.'),
      thread: z.string().optional().describe('Optional thread/topic key.'),
      in_reply_to: z.string().optional().describe('Object id of a note being replied to.'),
      refs: z
        .array(z.string())
        .optional()
        .describe('rickydata object ids this note concerns (intent/attempt/run/patch).'),
    },
    buildArgs: (input) => {
      const args = [
        'note',
        'send',
        '--repo',
        repoOf(input),
        '--from',
        String(input.from ?? ''),
        '--to',
        String(input.to ?? ''),
        '--text',
        String(input.text ?? ''),
      ];
      pushStr(args, '--thread', input.thread);
      pushStr(args, '--in-reply-to', input.in_reply_to);
      if (Array.isArray(input.refs)) {
        for (const ref of input.refs) pushStr(args, '--ref', ref);
      }
      args.push('--json');
      return args;
    },
  },
  {
    name: 'rickygit_note_inbox',
    description: 'Read notes addressed to an agent or `all`, new since the agent last read (advances the read marker unless peek).',
    schema: {
      ...repoField,
      agent: z.string().describe('The reading agent id.'),
      peek: z.boolean().optional().describe('Read without advancing the read marker.'),
      all_history: z.boolean().optional().describe('Ignore the read marker and return all matching notes.'),
      since_ms: z.number().optional().describe('Only notes newer than this Unix-ms timestamp.'),
      include_self: z.boolean().optional().describe('Include notes the agent sent itself.'),
    },
    buildArgs: (input) => {
      const args = ['note', 'inbox', '--repo', repoOf(input), '--agent', String(input.agent ?? '')];
      if (input.peek === true) args.push('--peek');
      if (input.all_history === true) args.push('--all-history');
      if (input.include_self === true) args.push('--include-self');
      if (typeof input.since_ms === 'number') args.push('--since-ms', String(input.since_ms));
      args.push('--json');
      return args;
    },
  },
  {
    name: 'rickygit_note_list',
    description: 'Marker-independent full note history, optionally filtered by from/to/thread.',
    schema: {
      ...repoField,
      from: z.string().optional().describe('Filter by sender.'),
      to: z.string().optional().describe('Filter by recipient.'),
      thread: z.string().optional().describe('Filter by thread/topic.'),
    },
    buildArgs: (input) => {
      const args = ['note', 'list', '--repo', repoOf(input)];
      pushStr(args, '--from', input.from);
      pushStr(args, '--to', input.to);
      pushStr(args, '--thread', input.thread);
      args.push('--json');
      return args;
    },
  },
  {
    name: 'rickygit_sync_push',
    description: 'Push refs/rickydata/* to a normal Git remote.',
    schema: { ...repoField, remote: z.string().optional().describe('Git remote (default origin).') },
    buildArgs: (input) => {
      const args = ['sync', 'push', '--repo', repoOf(input)];
      pushStr(args, '--remote', input.remote ?? 'origin');
      args.push('--json');
      return args;
    },
  },
  {
    name: 'rickygit_sync_pull',
    description: 'Fetch refs/rickydata/* from a normal Git remote.',
    schema: { ...repoField, remote: z.string().optional().describe('Git remote (default origin).') },
    buildArgs: (input) => {
      const args = ['sync', 'pull', '--repo', repoOf(input)];
      pushStr(args, '--remote', input.remote ?? 'origin');
      args.push('--json');
      return args;
    },
  },
  {
    name: 'rickygit_relay_push',
    description: 'Push rickydata object bundles to the shared relay (cross-fleet meeting point).',
    schema: {
      ...repoField,
      url: z.string().optional().describe('Relay URL. Defaults to RICKYDATA_GIT_RELAY_URL.'),
      repo_id: z.string().optional().describe('Relay repo_id namespace.'),
    },
    buildArgs: (input) => {
      const args = ['relay', 'push', '--repo', repoOf(input)];
      pushStr(args, '--url', input.url ?? defaultRelayUrl());
      pushStr(args, '--repo-id', input.repo_id);
      args.push('--json');
      return args;
    },
  },
  {
    name: 'rickygit_relay_pull',
    description: 'Pull rickydata object bundles from the shared relay.',
    schema: {
      ...repoField,
      url: z.string().optional().describe('Relay URL. Defaults to RICKYDATA_GIT_RELAY_URL.'),
      repo_id: z.string().optional().describe('Relay repo_id namespace.'),
    },
    buildArgs: (input) => {
      const args = ['relay', 'pull', '--repo', repoOf(input)];
      pushStr(args, '--url', input.url ?? defaultRelayUrl());
      pushStr(args, '--repo-id', input.repo_id);
      args.push('--json');
      return args;
    },
  },
  {
    name: 'rickygit_proof',
    description: 'End-to-end health check across local objects, Git remote, relay, and KFDB.',
    schema: {
      ...repoField,
      remote: z.string().optional().describe('Git remote (default origin).'),
      relay_url: z.string().optional().describe('Relay URL. Defaults to RICKYDATA_GIT_RELAY_URL.'),
      repo_id: z.string().optional().describe('Relay repo_id namespace.'),
    },
    buildArgs: (input) => {
      const args = ['proof', '--repo', repoOf(input)];
      pushStr(args, '--remote', input.remote ?? 'origin');
      pushStr(args, '--relay-url', input.relay_url ?? defaultRelayUrl());
      pushStr(args, '--repo-id', input.repo_id);
      args.push('--json');
      return args;
    },
  },
];

export function registerTools(server: McpServer): void {
  for (const def of TOOL_DEFS) {
    server.tool(def.name, def.description, def.schema, async (input: ToolInput) => {
      const result = await runRickygit(def.buildArgs(input));
      const payload = result.json ?? { stdout: result.stdout, stderr: result.stderr };
      return {
        isError: !result.success,
        content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
      };
    });
  }
}
