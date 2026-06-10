// ============================================================================
// OUTPUT SANITIZER
// ============================================================================
//
// Defense-in-depth against benchmark solution leakage. Even though KFDB
// server-side redaction (Phase 1b) strips gold fields from code-intelligence
// responses, the MCP layer independently drops any key that names a gold field
// before it can reach an agent under evaluation. Belt and suspenders: a
// regression on either side does not leak the answer.
//
// Dropped keys (case-insensitive) match: ^gold_  | fix_commit | pr_merge

const GOLD_KEY_RE = /^gold_|fix_commit|pr_merge/i;

/**
 * Recursively drop any object key whose name matches a gold-field pattern.
 * Arrays are walked element-wise; primitives pass through untouched.
 */
export function sanitizeGoldFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeGoldFields);
  }
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
