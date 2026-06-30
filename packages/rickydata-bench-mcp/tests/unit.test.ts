import { describe, it, expect } from "vitest";
import {
  TOOL_DEFS,
  TOOL_NAMES,
  buildLeaderboard,
  projectRun,
  summarizeSolutionCard,
  projectPattern,
} from "../src/tools.js";
import type { SolutionCard, SolutionPattern } from "../src/bench.js";
import { sanitizeGoldFields } from "../src/sanitize.js";

describe("tool surface", () => {
  it("exposes exactly the 8 documented tools with unique names", () => {
    const names = TOOL_DEFS.map((t) => t.name);
    expect(names.length).toBe(8);
    expect(new Set(names).size).toBe(names.length);
    for (const expected of TOOL_NAMES) expect(names).toContain(expected);
  });
});

describe("summarizeSolutionCard", () => {
  const card: SolutionCard = {
    problem: "trailing newline removed when decoding ansi",
    matchedIssue: { repo: "Textualize/rich", issueNumber: 3577, title: "Trailing line break removed", similarity: 0.8, matchedBy: ["semantic", "lexical"] },
    relatedIssues: [],
    targetFiles: ["rich/ansi.py"],
    recipe: {
      steps: [
        { action: "read_failing_test", label: "Read the failing test", target: null, grounded: false },
        { action: "edit_target", label: "Edit the target file", target: "rich/ansi.py", grounded: true },
        { action: "run_tests", label: "Run the test suite", target: "pytest tests/test_ansi.py", grounded: true },
      ],
      generalized: true,
      notes: [],
    },
    bestApproach: { model: "glm-5.1", provider: "zai", costUsd: 0.115, solved: null, recall: 1, verified: true },
    confidence: { score: 0.66, label: "high", reason: null },
    citations: [],
    caveats: ["No trace runs joined to benchmark_runs."],
  };

  it("renders an actionable briefing with numbered recipe + prescriptive tags", () => {
    const out = summarizeSolutionCard(card);
    expect(out).toContain("Textualize/rich#3577");
    expect(out).toContain("Confidence: high (66%)");
    expect(out).toContain("Target files: rich/ansi.py");
    expect(out).toMatch(/1\. Read the failing test \[prescriptive\]/);
    expect(out).toMatch(/2\. Edit the target file → rich\/ansi\.py/);
    expect(out).toContain("Best approach observed: glm-5.1 (zai) — gold match 100%, ran tests, $0.1150");
    expect(out).toContain("Caveats:");
  });

  it("degrades cleanly when no issue matched", () => {
    const degraded: SolutionCard = { ...card, matchedIssue: null, confidence: { score: 0.1, label: "low", reason: "no close issue" } };
    const out = summarizeSolutionCard(degraded);
    expect(out).toContain("No proven solution matched");
    expect(out).toContain("no close issue");
  });
});

describe("projectPattern", () => {
  it("compacts a pattern to scalars + recipe labels", () => {
    const p: SolutionPattern = {
      type: "python:type-validation",
      label: "Python type validation",
      issueCount: 13,
      repos: ["pydantic/pydantic"],
      recipe: { steps: [{ action: "edit_target", label: "Edit the file(s)", target: null, grounded: false }] },
      bestModel: { model: "kimi-for-coding", solves: 4, attempts: 9 },
      medianCostUsd: 0.245,
      testCommandExample: "pytest",
      exampleIssues: [{ repo: "pydantic/pydantic", issueNumber: 13148, targetFiles: ["pydantic/x.py"] }],
    };
    const out = projectPattern(p);
    expect(out.bestModel).toBe("kimi-for-coding");
    expect(out.medianCostUsd).toBe(0.245);
    expect(out.recipe).toEqual(["Edit the file(s)"]);
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
