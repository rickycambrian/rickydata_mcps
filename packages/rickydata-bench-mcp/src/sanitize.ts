// ============================================================================
// OUTPUT SANITIZER
// ============================================================================
//
// This MCP only reads public, gold-redacted bench endpoints. The sanitizer is
// defense-in-depth: even if a future endpoint regression exposed a gold field,
// the analysis MCP would never forward it to a consumer. Same contract as
// @rickydata/kfdb-code-mcp.
//
// Dropped keys (case-insensitive): ^gold_ | fix_commit | pr_merge

const GOLD_KEY_RE = /^gold_|fix_commit|pr_merge/i;

export function sanitizeGoldFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeGoldFields);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (GOLD_KEY_RE.test(key)) continue;
      out[key] = sanitizeGoldFields(v);
    }
    return out;
  }
  return value;
}
