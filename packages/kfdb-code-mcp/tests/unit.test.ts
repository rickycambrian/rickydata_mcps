import { describe, it, expect, beforeEach } from "vitest";
import { sanitizeGoldFields } from "../src/sanitize.js";
import { resolveScopePayload } from "../src/kfdb.js";
import {
  rememberNodeIds,
  isNodeIdAllowed,
  rememberedCount,
  _resetSession,
} from "../src/session.js";

describe("sanitizeGoldFields", () => {
  it("drops gold_* / fix_commit / pr_merge keys recursively (case-insensitive)", () => {
    const input = {
      file_path: "src/lib.rs",
      gold_diff: "SECRET PATCH",
      gold_files_changed: ["a.rs"],
      Fix_Commit: "deadbeef",
      pr_merge_commit_sha: "cafe",
      results: [
        { name: "f", gold_patch: "x", nested: { fix_commit: "y", keep: 1 } },
      ],
    };
    const out = sanitizeGoldFields(input) as Record<string, unknown>;
    expect(out.file_path).toBe("src/lib.rs");
    expect("gold_diff" in out).toBe(false);
    expect("gold_files_changed" in out).toBe(false);
    expect("Fix_Commit" in out).toBe(false);
    expect("pr_merge_commit_sha" in out).toBe(false);
    const r0 = (out.results as Array<Record<string, unknown>>)[0];
    expect("gold_patch" in r0).toBe(false);
    expect(r0.name).toBe("f");
    const nested = r0.nested as Record<string, unknown>;
    expect("fix_commit" in nested).toBe(false);
    expect(nested.keep).toBe(1);
  });

  it("passes primitives and non-gold keys through untouched", () => {
    expect(sanitizeGoldFields("plain")).toBe("plain");
    expect(sanitizeGoldFields(42)).toBe(42);
    const obj = { a: 1, b: [1, 2, { c: "ok" }] };
    expect(sanitizeGoldFields(obj)).toEqual(obj);
  });

  it("does not over-match keys that merely contain 'gold' mid-string", () => {
    // ^gold_ anchors at start; 'threshold' / 'goldilocks' must survive.
    const out = sanitizeGoldFields({ threshold: 1, goldilocks: 2 }) as Record<
      string,
      unknown
    >;
    expect(out.threshold).toBe(1);
    expect(out.goldilocks).toBe(2);
  });
});

describe("forced-scope override (resolveScopePayload)", () => {
  const BENCH = "11111111-1111-1111-1111-111111111111";

  it("bench mode forces the pinned scope + strict_scope, ignoring caller scope", () => {
    const out = resolveScopePayload(
      { query: "x" },
      ["attacker-supplied-repo", "another"],
      true,
      BENCH,
    );
    expect(out.repo_scope).toEqual([BENCH]);
    expect(out.strict_scope).toBe(true);
    expect(out.query).toBe("x");
  });

  it("bench mode forces scope even when caller supplies none", () => {
    const out = resolveScopePayload({ query: "x" }, undefined, true, BENCH);
    expect(out.repo_scope).toEqual([BENCH]);
    expect(out.strict_scope).toBe(true);
  });

  it("non-bench passes caller scope through and never sets strict_scope", () => {
    const out = resolveScopePayload({ query: "x" }, ["repo-a"], false, "");
    expect(out.repo_scope).toEqual(["repo-a"]);
    expect("strict_scope" in out).toBe(false);
  });

  it("non-bench with no caller scope leaves scope unset", () => {
    const out = resolveScopePayload({ query: "x" }, undefined, false, "");
    expect("repo_scope" in out).toBe(false);
    expect("strict_scope" in out).toBe(false);
  });
});

describe("ego-graph seed allowlist", () => {
  beforeEach(() => _resetSession());

  it("rejects unknown node_ids and accepts remembered ones", () => {
    expect(isNodeIdAllowed("abc")).toBe(false);
    rememberNodeIds(["abc", "def"]);
    expect(isNodeIdAllowed("abc")).toBe(true);
    expect(isNodeIdAllowed("def")).toBe(true);
    expect(isNodeIdAllowed("ghi")).toBe(false);
  });

  it("ignores empty ids", () => {
    rememberNodeIds(["", "x"]);
    expect(rememberedCount()).toBe(1);
    expect(isNodeIdAllowed("")).toBe(false);
  });
});
