/**
 * Response shaping helpers. Kept centralized so every tool emits a consistent
 * text payload with a shared max-length guard.
 *
 * `RESPONSE_MAX_LENGTH` mirrors the research-papers-mcp default (200k chars).
 * Override via `SIYUAN_MCP_MAX_RESPONSE` for environments with tighter token
 * budgets.
 */
const DEFAULT_MAX = 200_000;

function resolveMax(): number {
  const raw = process.env.SIYUAN_MCP_MAX_RESPONSE;
  if (!raw) return DEFAULT_MAX;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX;
}

export function truncate(text: string, max: number = resolveMax()): string {
  if (text.length <= max) return text;
  return (
    text.slice(0, max) +
    `\n\n--- Response truncated (${text.length} chars, limit ${max}) ---`
  );
}

/**
 * Wrap a JSON-serializable payload in the MCP `content: [{type: "text"}]`
 * shape and apply the response cap. Use this for every tool handler so the
 * surface is uniform.
 */
export function textResult(payload: unknown): {
  content: Array<{ type: "text"; text: string }>;
} {
  const text =
    typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  return { content: [{ type: "text" as const, text: truncate(text) }] };
}
