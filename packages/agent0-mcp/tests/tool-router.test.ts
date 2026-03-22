import { describe, it, expect } from "vitest";
import { TOOLS, handleToolCall } from "../src/tools/index.js";

describe("tool router", () => {
  it("TOOLS is an array", () => {
    expect(Array.isArray(TOOLS)).toBe(true);
  });

  it("returns error for unknown tool name", async () => {
    const result = await handleToolCall("nonexistent_tool", {});
    expect(result).toEqual({ error: "Unknown tool: nonexistent_tool" });
  });

  it("all tools have required MCP fields", () => {
    for (const tool of TOOLS) {
      expect(tool.name).toBeTypeOf("string");
      expect(tool.name.length).toBeGreaterThan(0);
      expect(tool.description).toBeTypeOf("string");
      expect(tool.inputSchema).toBeDefined();
    }
  });

  it("no duplicate tool names", () => {
    const names = TOOLS.map((t) => t.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });
});
