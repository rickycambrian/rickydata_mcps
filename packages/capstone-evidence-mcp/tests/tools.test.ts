import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleToolCall, TOOLS } from "../src/tools.js";

let evidenceDir: string;

describe("Capstone Evidence MCP tools", () => {
  beforeEach(async () => {
    evidenceDir = await mkdtemp(join(tmpdir(), "evidence-test-"));
    process.env.CAPSTONE_EVIDENCE_DIR = evidenceDir;
  });

  afterEach(async () => {
    await rm(evidenceDir, { recursive: true, force: true });
    delete process.env.CAPSTONE_EVIDENCE_DIR;
  });

  it("defines unique MCP tools", () => {
    const names = TOOLS.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("writes, lists, and reads artifacts", async () => {
    const write = await handleToolCall("evidence_write_artifact", {
      id: "nvda-sec-pack",
      type: "sec_pack",
      title: "NVDA SEC Pack",
      sourceUrls: ["https://www.sec.gov/"],
      validationStatus: "source_fetched",
      claims: [{ claim: "Revenue increased year over year", confidence: "medium" }],
      data: { ticker: "NVDA", revenue: 100 },
    }) as any;
    expect(write.success).toBe(true);

    const list = await handleToolCall("evidence_list_artifacts", {}) as any;
    expect(list.count).toBe(1);

    const get = await handleToolCall("evidence_get_artifact", { id: "nvda-sec-pack" }) as any;
    expect(get.artifact.dataSha256).toHaveLength(64);
  });

  it("builds a claim register", async () => {
    await handleToolCall("evidence_write_artifact", {
      type: "macro_snapshot",
      title: "Rates Snapshot",
      claims: [{ claim: "Rates are a key discount-rate input" }],
      data: { dgs10: 4.2 },
    });
    const register = await handleToolCall("evidence_build_claim_register", {}) as any;
    expect(register.success).toBe(true);
    expect(register.claims[0].claim).toContain("Rates");
  });
});
