// ============================================================================
// SESSION STATE — ego-graph seed allowlist (bench mode)
// ============================================================================
//
// In bench mode an agent may only expand the call graph around node_ids it has
// already legitimately discovered via a scoped search/symbol/context call. This
// prevents probing for arbitrary node_ids (e.g. ids that belong to a HEAD-branch
// corpus or another repo) by guessing or by replaying ids seen elsewhere.
//
// The allowlist is per-process (one process == one bench run / one MCP session).

const seenNodeIds = new Set<string>();

/** Record node_ids returned by a scoped, trusted call so they can later seed ego graphs. */
export function rememberNodeIds(ids: Iterable<string>): void {
  for (const id of ids) {
    if (id) seenNodeIds.add(id);
  }
}

/** True if this node_id was previously returned by a scoped call this session. */
export function isNodeIdAllowed(id: string): boolean {
  return seenNodeIds.has(id);
}

/** Test-only: reset session state. */
export function _resetSession(): void {
  seenNodeIds.clear();
}

/** Test/diagnostic: number of remembered ids. */
export function rememberedCount(): number {
  return seenNodeIds.size;
}
