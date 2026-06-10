import { describe, it, expect } from "vitest";
import { TOOL_DEFS, TOOL_NAMES, buildLeaderboard, projectRun } from "../src/tools.js";
import { sanitizeGoldFields } from "../src/sanitize.js";

describe("tool surface", () => {
  it("exposes exactly the 6 documented tools with unique names", () => {
    const names = TOOL_DEFS.map((t) => t.name);
    expect(names.length).toBe(6);
    expect(new Set(names).size).toBe(names.length);
    for (const expected of TOOL_NAMES) expect(names).toContain(expected);
  });
});

describe("buildLeaderboard", () => {
  const rec = {
    campaignId: "c1",
    observedConfigCoverage: [
      { config: "a", displayName: "A", observedRows: 5, scoreableRows: 4, successes: 1 },
      { config: "b", displayName: "B", observedRows: 3, scoreableRows: 2, successes: 2 },
      { config: "c", displayName: "C", observedRows: 10, scoreableRows: 10, successes: 5 },
      { config: "d", displayName: "D", observedRows: 1, scoreableRows: 0, successes: 0 },
    ],
  };

  it("ranks by success rate desc, then scoreable rows desc", () => {
    const lb = buildLeaderboard(rec, 10);
    // b: 1.0, c: 0.5, a: 0.25, d: 0.0
    expect(lb.map((e) => e.config)).toEqual(["b", "c", "a", "d"]);
    expect(lb[0].successRate).toBe(1);
    expect(lb[1].successRate).toBe(0.5);
    expect(lb[3].successRate).toBe(0); // zero scoreable -> rate 0, never NaN
  });

  it("honors the limit and never returns less than one when coverage exists", () => {
    expect(buildLeaderboard(rec, 2).length).toBe(2);
    expect(buildLeaderboard(rec, 0).length).toBe(1);
  });

  it("returns empty when there is no coverage", () => {
    expect(buildLeaderboard({ campaignId: "x" }, 5)).toEqual([]);
  });
});

describe("projectRun", () => {
  it("keeps analysis fields and omits verbose attestation/trace blobs", () => {
    const out = projectRun({
      run_id: "r1",
      repo: "o/r",
      provider: "anthropic",
      quality_score: { value: 0.8 },
      success: true,
      attestation_image_digest: "sha256:big",
      trace_artifact_hash: "sha256:big2",
    });
    expect(out.run_id).toBe("r1");
    expect(out.provider).toBe("anthropic");
    expect(out.success).toBe(true);
    expect("attestation_image_digest" in out).toBe(false);
    expect("trace_artifact_hash" in out).toBe(false);
  });
});

describe("sanitizeGoldFields (defense-in-depth)", () => {
  it("drops gold_* / fix_commit / pr_merge keys recursively", () => {
    const out = sanitizeGoldFields({
      items: [{ title: "t", gold_diff: "x", fix_commit: "y", pr_merge_commit_sha: "z" }],
    }) as { items: Array<Record<string, unknown>> };
    const it0 = out.items[0];
    expect(it0.title).toBe("t");
    expect("gold_diff" in it0).toBe(false);
    expect("fix_commit" in it0).toBe(false);
    expect("pr_merge_commit_sha" in it0).toBe(false);
  });
});
