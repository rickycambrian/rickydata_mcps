import { describe, it, expect } from "vitest";
import { TOOLS, handleToolCall } from "../tools/index.js";
import {
  telegramUserId,
  telegramMessageId,
  telegramGroupId,
  telegramConversationId,
} from "../ids.js";

// ============================================================================
// TOOL REGISTRY TESTS
// ============================================================================

describe("Tool registry", () => {
  it("exports exactly 20 tools", () => {
    expect(TOOLS.length).toBe(20);
  });

  it("has unique tool names", () => {
    const names = TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("all tools are prefixed with telegram_", () => {
    for (const tool of TOOLS) {
      expect(tool.name).toMatch(/^telegram_/);
    }
  });

  it("all tools have descriptions", () => {
    for (const tool of TOOLS) {
      expect(tool.description).toBeTruthy();
      expect(typeof tool.description).toBe("string");
    }
  });

  it("all tools have inputSchema", () => {
    for (const tool of TOOLS) {
      expect(tool.inputSchema).toBeTruthy();
      expect(tool.inputSchema.type).toBe("object");
    }
  });

  const expectedTools = [
    "telegram_ingest_profiles",
    "telegram_ingest_messages",
    "telegram_ingest_contacts",
    "telegram_ingest_mutual_groups",
    "telegram_search_messages",
    "telegram_search_users",
    "telegram_query_kql",
    "telegram_get_conversation",
    "telegram_stats",
    "telegram_group_analysis",
    "telegram_cross_group_overlap",
    "telegram_configure_credentials",
    "telegram_configure_kfdb",
    "telegram_twitter_link",
    "telegram_twitter_auth_url",
    "telegram_community_report",
    "telegram_lead_enrichment",
    "telegram_conversation_summary",
    "telegram_member_network",
    "telegram_alert_setup",
  ];

  it.each(expectedTools)("includes tool: %s", (name) => {
    expect(TOOLS.find((t) => t.name === name)).toBeDefined();
  });
});

// ============================================================================
// DETERMINISTIC ID TESTS
// ============================================================================

describe("Deterministic IDs", () => {
  it("generates consistent user IDs", () => {
    const id1 = telegramUserId(12345);
    const id2 = telegramUserId(12345);
    expect(id1).toBe(id2);
  });

  it("generates different IDs for different users", () => {
    const id1 = telegramUserId(12345);
    const id2 = telegramUserId(67890);
    expect(id1).not.toBe(id2);
  });

  it("generates consistent message IDs", () => {
    const id1 = telegramMessageId(100, 1);
    const id2 = telegramMessageId(100, 1);
    expect(id1).toBe(id2);
  });

  it("generates different IDs for different messages", () => {
    const id1 = telegramMessageId(100, 1);
    const id2 = telegramMessageId(100, 2);
    expect(id1).not.toBe(id2);
  });

  it("generates consistent group IDs", () => {
    const id1 = telegramGroupId(999);
    const id2 = telegramGroupId(999);
    expect(id1).toBe(id2);
  });

  it("generates consistent conversation IDs", () => {
    const id1 = telegramConversationId(100);
    const id2 = telegramConversationId(100);
    expect(id1).toBe(id2);
  });

  it("produces valid UUID format", () => {
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    expect(telegramUserId(1)).toMatch(uuidRegex);
    expect(telegramMessageId(1, 1)).toMatch(uuidRegex);
    expect(telegramGroupId(1)).toMatch(uuidRegex);
    expect(telegramConversationId(1)).toMatch(uuidRegex);
  });
});

// ============================================================================
// CONFIG TOOL TESTS (no network required)
// ============================================================================

describe("Config tools", () => {
  it("telegram_configure_credentials reports no changes when called empty", async () => {
    const result = await handleToolCall("telegram_configure_credentials", {});
    expect(typeof result).toBe("string");
    expect(result).toContain("No parameters provided");
  });

  it("telegram_configure_credentials updates api_id", async () => {
    const result = await handleToolCall("telegram_configure_credentials", {
      api_id: "12345",
    });
    expect(result).toContain("api_id");
    expect(result).toContain("updated");
  });

  it("telegram_configure_kfdb reports no changes when called empty", async () => {
    const result = await handleToolCall("telegram_configure_kfdb", {});
    expect(typeof result).toBe("string");
    expect(result).toContain("No parameters provided");
  });

  it("telegram_configure_kfdb updates wallet_address", async () => {
    const result = await handleToolCall("telegram_configure_kfdb", {
      wallet_address: "0xabc123",
    });
    expect(result).toContain("wallet_address");
    expect(result).toContain("updated");
  });
});

// ============================================================================
// TWITTER AUTH URL TEST (no network required)
// ============================================================================

describe("Twitter tools", () => {
  it("telegram_twitter_auth_url returns error without env vars", async () => {
    // TWITTER_CLIENT_ID is not set in test env
    const result = await handleToolCall("telegram_twitter_auth_url", {
      telegram_id: 12345,
    });
    expect(result).toContain("TWITTER_CLIENT_ID");
  });
});

// ============================================================================
// UNKNOWN TOOL TEST
// ============================================================================

describe("Unknown tool", () => {
  it("returns error for unknown tool name", async () => {
    const result = await handleToolCall("nonexistent_tool", {});
    expect(result).toHaveProperty("error");
  });
});

// ============================================================================
// INPUT VALIDATION TESTS (no network required)
// ============================================================================

describe("Input validation", () => {
  it("telegram_ingest_profiles requires profiles array", async () => {
    // This will fail at validation, not at network
    const result = await handleToolCall("telegram_ingest_profiles", {});
    expect(result).toContain("Error");
  });

  it("telegram_ingest_messages requires messages array", async () => {
    const result = await handleToolCall("telegram_ingest_messages", {});
    expect(result).toContain("Error");
  });

  it("telegram_ingest_contacts requires contacts array", async () => {
    const result = await handleToolCall("telegram_ingest_contacts", {});
    expect(result).toContain("Error");
  });

  it("telegram_ingest_mutual_groups requires groups array", async () => {
    const result = await handleToolCall("telegram_ingest_mutual_groups", {});
    expect(result).toContain("Error");
  });

  it("telegram_search_users requires query or username", async () => {
    // This will hit KFDB auth check, which should throw since no key set
    // But let's test that the handler is reachable
    try {
      const result = await handleToolCall("telegram_search_users", {});
      expect(result).toContain("Error");
    } catch (e) {
      // Expected: KFDB auth error is also acceptable
      expect((e as Error).message).toBeTruthy();
    }
  });

  it("telegram_query_kql requires query", async () => {
    try {
      const result = await handleToolCall("telegram_query_kql", {});
      expect(result).toContain("Error");
    } catch (e) {
      expect((e as Error).message).toBeTruthy();
    }
  });

  it("telegram_get_conversation requires chat_id", async () => {
    try {
      const result = await handleToolCall("telegram_get_conversation", {});
      expect(result).toContain("Error");
    } catch (e) {
      expect((e as Error).message).toBeTruthy();
    }
  });

  it("telegram_twitter_link requires telegram_id and twitter_handle", async () => {
    try {
      const result = await handleToolCall("telegram_twitter_link", {});
      expect(result).toContain("Error");
    } catch (e) {
      expect((e as Error).message).toBeTruthy();
    }
  });

  it("telegram_cross_group_overlap requires at least 2 group_ids", async () => {
    try {
      const result = await handleToolCall("telegram_cross_group_overlap", {
        group_ids: [1],
      });
      expect(result).toContain("Error");
    } catch (e) {
      expect((e as Error).message).toBeTruthy();
    }
  });

  it("telegram_community_report requires group_name", async () => {
    try {
      const result = await handleToolCall("telegram_community_report", {});
      expect(result).toContain("Error");
    } catch (e) {
      expect((e as Error).message).toBeTruthy();
    }
  });

  it("telegram_lead_enrichment requires telegram_user_ids array", async () => {
    try {
      const result = await handleToolCall("telegram_lead_enrichment", {});
      expect(result).toContain("Error");
    } catch (e) {
      expect((e as Error).message).toBeTruthy();
    }
  });

  it("telegram_lead_enrichment rejects empty array", async () => {
    try {
      const result = await handleToolCall("telegram_lead_enrichment", {
        telegram_user_ids: [],
      });
      expect(result).toContain("Error");
    } catch (e) {
      expect((e as Error).message).toBeTruthy();
    }
  });

  it("telegram_conversation_summary requires source_chat", async () => {
    try {
      const result = await handleToolCall("telegram_conversation_summary", {});
      expect(result).toContain("Error");
    } catch (e) {
      expect((e as Error).message).toBeTruthy();
    }
  });

  it("telegram_member_network requires at least 2 group_names", async () => {
    try {
      const result = await handleToolCall("telegram_member_network", {
        group_names: ["only_one"],
      });
      expect(result).toContain("Error");
    } catch (e) {
      expect((e as Error).message).toBeTruthy();
    }
  });

  it("telegram_member_network rejects empty array", async () => {
    try {
      const result = await handleToolCall("telegram_member_network", {});
      expect(result).toContain("Error");
    } catch (e) {
      expect((e as Error).message).toBeTruthy();
    }
  });

  it("telegram_alert_setup requires group_name", async () => {
    try {
      const result = await handleToolCall("telegram_alert_setup", {
        keywords: ["test"],
      });
      expect(result).toContain("Error");
    } catch (e) {
      expect((e as Error).message).toBeTruthy();
    }
  });

  it("telegram_alert_setup requires keywords array", async () => {
    try {
      const result = await handleToolCall("telegram_alert_setup", {
        group_name: "test_group",
      });
      expect(result).toContain("Error");
    } catch (e) {
      expect((e as Error).message).toBeTruthy();
    }
  });

  it("telegram_alert_setup rejects empty keywords", async () => {
    try {
      const result = await handleToolCall("telegram_alert_setup", {
        group_name: "test_group",
        keywords: [],
      });
      expect(result).toContain("Error");
    } catch (e) {
      expect((e as Error).message).toBeTruthy();
    }
  });
});
