import { ApiError, FailClosedError } from './errors.js';
import { withRuntimeIdentity } from './runtime-identity.js';

export const RESPONSE_MAX_LENGTH = parseInt(process.env.RESPONSE_MAX_LENGTH || '120000', 10);

export type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

export function truncate(result: unknown): string {
  const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  if (text.length <= RESPONSE_MAX_LENGTH) return text;
  return `${text.slice(0, RESPONSE_MAX_LENGTH)}\n\n--- Response truncated (${text.length} chars, limit ${RESPONSE_MAX_LENGTH}) ---`;
}

export function ok(result: unknown): ToolResult {
  return { content: [{ type: 'text', text: truncate(withRuntimeIdentity(result)) }] };
}

export function fail(err: unknown): ToolResult {
  if (err instanceof FailClosedError) {
    return {
      content: [{ type: 'text', text: truncate(withRuntimeIdentity({ error: 'fail_closed', message: err.message })) }],
      isError: true,
    };
  }
  if (err instanceof ApiError) {
    return {
      content: [
        {
          type: 'text',
          text: truncate(withRuntimeIdentity({ error: `${err.service}_api_error`, status: err.status, message: err.message })),
        },
      ],
      isError: true,
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: 'text', text: truncate(withRuntimeIdentity({ error: 'tool_error', message })) }],
    isError: true,
  };
}
