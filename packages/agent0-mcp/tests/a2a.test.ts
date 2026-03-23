import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock agent0-sdk
const mockGetAgent = vi.fn();
const mockCreateA2AClient = vi.fn();

vi.mock("agent0-sdk", () => {
  return {
    SDK: vi.fn().mockImplementation(() => ({
      getAgent: mockGetAgent,
      createA2AClient: mockCreateA2AClient,
    })),
  };
});

import { a2aTools, handleA2ATool } from "../src/tools/a2a.js";
import { setDerivedKey, setChainId } from "../src/auth/sdk-client.js";

function makeA2AClient(overrides: Record<string, unknown> = {}) {
  return {
    messageA2A: vi.fn().mockResolvedValue({
      taskId: "task-123",
      status: "completed",
      response: "Hello from agent",
    }),
    listTasks: vi.fn().mockResolvedValue([
      { taskId: "task-1", status: "completed" },
      { taskId: "task-2", status: "working" },
    ]),
    loadTask: vi.fn().mockResolvedValue({
      taskId: "task-123",
      status: "completed",
      messages: [{ role: "user", text: "hi" }],
    }),
    queryTask: vi.fn().mockResolvedValue({
      taskId: "task-123",
      status: "working",
      messages: [{ role: "user", text: "query" }],
      artifacts: [],
    }),
    cancelTask: vi.fn().mockResolvedValue({ cancelled: true }),
    ...overrides,
  };
}

describe("a2a tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setChainId(11155111);
    setDerivedKey("0x" + "cc".repeat(32));
    mockGetAgent.mockResolvedValue({
      agentId: "11155111:42",
      name: "Test Agent",
      a2a: "https://a2a.test/agent.json",
    });
    mockCreateA2AClient.mockReturnValue(makeA2AClient());
  });

  // ===========================================================================
  // Tool registration
  // ===========================================================================
  describe("tool registration", () => {
    it("registers 6 A2A tools", () => {
      expect(a2aTools).toHaveLength(6);
    });

    const expected = [
      "a2a_send_message",
      "a2a_list_tasks",
      "a2a_get_task",
      "a2a_query_task",
      "a2a_task_message",
      "a2a_cancel_task",
    ];
    for (const name of expected) {
      it(`registers ${name}`, () => {
        expect(a2aTools.find((t) => t.name === name)).toBeDefined();
      });
    }
  });

  // ===========================================================================
  // a2a_send_message
  // ===========================================================================
  describe("a2a_send_message", () => {
    it("sends message and returns task info", async () => {
      const result = (await handleA2ATool("a2a_send_message", {
        agentId: "11155111:42",
        message: "Hello agent",
      })) as { success: boolean; taskId: string; status: string };

      expect(result.success).toBe(true);
      expect(result.taskId).toBe("task-123");
      expect(result.status).toBe("completed");
    });

    it("returns error when agent not found", async () => {
      mockGetAgent.mockResolvedValue(null);

      const result = (await handleA2ATool("a2a_send_message", {
        agentId: "11155111:99999",
        message: "Hello",
      })) as { error: string };

      expect(result.error).toContain("not found");
    });

    it("returns error when agent has no A2A endpoint", async () => {
      mockGetAgent.mockResolvedValue({
        agentId: "11155111:42",
        name: "No A2A Agent",
        a2a: null,
      });

      const result = (await handleA2ATool("a2a_send_message", {
        agentId: "11155111:42",
        message: "Hello",
      })) as { error: string };

      expect(result.error).toContain("does not have an A2A endpoint");
    });

    it("passes taskId for conversation continuation", async () => {
      const client = makeA2AClient();
      mockCreateA2AClient.mockReturnValue(client);

      await handleA2ATool("a2a_send_message", {
        agentId: "11155111:42",
        message: "Follow up",
        taskId: "existing-task",
      });

      expect(client.messageA2A).toHaveBeenCalledWith("Follow up", {
        taskId: "existing-task",
      });
    });

    it("includes chain name in result", async () => {
      const result = (await handleA2ATool("a2a_send_message", {
        agentId: "8453:42",
        message: "Hello",
      })) as { chain: string };

      expect(result.chain).toBe("Base");
    });
  });

  // ===========================================================================
  // a2a_list_tasks
  // ===========================================================================
  describe("a2a_list_tasks", () => {
    it("returns task list with count", async () => {
      const result = (await handleA2ATool("a2a_list_tasks", {
        agentId: "11155111:42",
      })) as { agentId: string; count: number; tasks: unknown[] };

      expect(result.agentId).toBe("11155111:42");
      expect(result.count).toBe(2);
      expect(result.tasks).toHaveLength(2);
    });

    it("returns error when agent not found", async () => {
      mockGetAgent.mockResolvedValue(null);

      const result = (await handleA2ATool("a2a_list_tasks", {
        agentId: "11155111:99999",
      })) as { error: string };

      expect(result.error).toContain("not found");
    });

    it("returns error when agent has no A2A endpoint", async () => {
      mockGetAgent.mockResolvedValue({
        agentId: "11155111:42",
        a2a: null,
      });

      const result = (await handleA2ATool("a2a_list_tasks", {
        agentId: "11155111:42",
      })) as { error: string };

      expect(result.error).toContain("does not have an A2A endpoint");
    });

    it("handles empty task list", async () => {
      const client = makeA2AClient({ listTasks: vi.fn().mockResolvedValue([]) });
      mockCreateA2AClient.mockReturnValue(client);

      const result = (await handleA2ATool("a2a_list_tasks", {
        agentId: "11155111:42",
      })) as { count: number; tasks: unknown[] };

      expect(result.count).toBe(0);
      expect(result.tasks).toEqual([]);
    });
  });

  // ===========================================================================
  // a2a_get_task
  // ===========================================================================
  describe("a2a_get_task", () => {
    it("returns task details", async () => {
      const result = (await handleA2ATool("a2a_get_task", {
        agentId: "11155111:42",
        taskId: "task-123",
      })) as { agentId: string; taskId: string; task: Record<string, unknown> };

      expect(result.agentId).toBe("11155111:42");
      expect(result.taskId).toBe("task-123");
      expect(result.task.status).toBe("completed");
    });

    it("returns error when agent not found", async () => {
      mockGetAgent.mockResolvedValue(null);

      const result = (await handleA2ATool("a2a_get_task", {
        agentId: "11155111:99999",
        taskId: "task-123",
      })) as { error: string };

      expect(result.error).toContain("not found");
    });

    it("returns task error when task not found", async () => {
      const client = makeA2AClient({
        loadTask: vi.fn().mockResolvedValue(null),
      });
      mockCreateA2AClient.mockReturnValue(client);

      const result = (await handleA2ATool("a2a_get_task", {
        agentId: "11155111:42",
        taskId: "nonexistent",
      })) as { task: { error: string } };

      expect(result.task.error).toBe("Task not found");
    });
  });

  // ===========================================================================
  // a2a_query_task
  // ===========================================================================
  describe("a2a_query_task", () => {
    it("returns task status and messages", async () => {
      const result = (await handleA2ATool("a2a_query_task", {
        agentId: "11155111:42",
        taskId: "task-123",
      })) as {
        agentId: string;
        taskId: string;
        status: string;
        messages: unknown[];
        artifacts: unknown[];
      };

      expect(result.agentId).toBe("11155111:42");
      expect(result.taskId).toBe("task-123");
      expect(result.status).toBe("working");
      expect(result.messages).toHaveLength(1);
      expect(result.artifacts).toEqual([]);
    });

    it("passes historyLength to queryTask", async () => {
      const client = makeA2AClient();
      mockCreateA2AClient.mockReturnValue(client);

      await handleA2ATool("a2a_query_task", {
        agentId: "11155111:42",
        taskId: "task-123",
        historyLength: 5,
      });

      expect(client.queryTask).toHaveBeenCalledWith("task-123", {
        historyLength: 5,
      });
    });

    it("returns error when agent not found", async () => {
      mockGetAgent.mockResolvedValue(null);

      const result = (await handleA2ATool("a2a_query_task", {
        agentId: "11155111:99999",
        taskId: "task-123",
      })) as { error: string };

      expect(result.error).toContain("not found");
    });

    it("returns error when agent has no A2A endpoint", async () => {
      mockGetAgent.mockResolvedValue({
        agentId: "11155111:42",
        name: "No A2A Agent",
        a2a: null,
      });

      const result = (await handleA2ATool("a2a_query_task", {
        agentId: "11155111:42",
        taskId: "task-123",
      })) as { error: string };

      expect(result.error).toContain("does not have an A2A endpoint");
    });

    it("returns empty messages and artifacts when task has none", async () => {
      const client = makeA2AClient({
        queryTask: vi.fn().mockResolvedValue({
          taskId: "task-123",
          status: "completed",
          messages: null,
          artifacts: null,
        }),
      });
      mockCreateA2AClient.mockReturnValue(client);

      const result = (await handleA2ATool("a2a_query_task", {
        agentId: "11155111:42",
        taskId: "task-123",
      })) as { messages: unknown[]; artifacts: unknown[] };

      expect(result.messages).toEqual([]);
      expect(result.artifacts).toEqual([]);
    });
  });

  // ===========================================================================
  // a2a_task_message
  // ===========================================================================
  describe("a2a_task_message", () => {
    it("sends follow-up message to existing task", async () => {
      const client = makeA2AClient();
      mockCreateA2AClient.mockReturnValue(client);

      const result = (await handleA2ATool("a2a_task_message", {
        agentId: "11155111:42",
        taskId: "task-123",
        message: "Follow up question",
      })) as {
        success: boolean;
        agentId: string;
        taskId: string;
        status: string;
        response: string;
      };

      expect(result.success).toBe(true);
      expect(result.agentId).toBe("11155111:42");
      expect(result.taskId).toBe("task-123");
      expect(result.status).toBe("completed");
      expect(client.messageA2A).toHaveBeenCalledWith("Follow up question", {
        taskId: "task-123",
      });
    });

    it("includes chain name in result", async () => {
      const result = (await handleA2ATool("a2a_task_message", {
        agentId: "8453:42",
        taskId: "task-123",
        message: "Hello",
      })) as { chain: string };

      expect(result.chain).toBe("Base");
    });

    it("returns error when agent not found", async () => {
      mockGetAgent.mockResolvedValue(null);

      const result = (await handleA2ATool("a2a_task_message", {
        agentId: "11155111:99999",
        taskId: "task-123",
        message: "Hello",
      })) as { error: string };

      expect(result.error).toContain("not found");
    });

    it("returns error when agent has no A2A endpoint", async () => {
      mockGetAgent.mockResolvedValue({
        agentId: "11155111:42",
        a2a: null,
      });

      const result = (await handleA2ATool("a2a_task_message", {
        agentId: "11155111:42",
        taskId: "task-123",
        message: "Hello",
      })) as { error: string };

      expect(result.error).toContain("does not have an A2A endpoint");
    });
  });

  // ===========================================================================
  // a2a_cancel_task
  // ===========================================================================
  describe("a2a_cancel_task", () => {
    it("cancels task successfully", async () => {
      const client = makeA2AClient();
      mockCreateA2AClient.mockReturnValue(client);

      const result = (await handleA2ATool("a2a_cancel_task", {
        agentId: "11155111:42",
        taskId: "task-123",
      })) as {
        success: boolean;
        agentId: string;
        taskId: string;
        cancelled: boolean;
        result: unknown;
      };

      expect(result.success).toBe(true);
      expect(result.agentId).toBe("11155111:42");
      expect(result.taskId).toBe("task-123");
      expect(result.cancelled).toBe(true);
      expect(client.cancelTask).toHaveBeenCalledWith("task-123");
    });

    it("returns error when agent not found", async () => {
      mockGetAgent.mockResolvedValue(null);

      const result = (await handleA2ATool("a2a_cancel_task", {
        agentId: "11155111:99999",
        taskId: "task-123",
      })) as { error: string };

      expect(result.error).toContain("not found");
    });

    it("returns error when agent has no A2A endpoint", async () => {
      mockGetAgent.mockResolvedValue({
        agentId: "11155111:42",
        a2a: null,
      });

      const result = (await handleA2ATool("a2a_cancel_task", {
        agentId: "11155111:42",
        taskId: "task-123",
      })) as { error: string };

      expect(result.error).toContain("does not have an A2A endpoint");
    });

    it("requires authentication", async () => {
      // setDerivedKey("") sets key to "" (falsy) — SDK init fails with auth error
      setDerivedKey("");

      const result = (await handleA2ATool("a2a_cancel_task", {
        agentId: "11155111:42",
        taskId: "task-123",
      })) as { error: string };

      expect(result.error).toBeDefined();
      expect(result.error).toContain("authenticated");

      setDerivedKey("0x" + "cc".repeat(32));
    });

    it("wraps empty cancel result as empty object", async () => {
      const client = makeA2AClient({
        cancelTask: vi.fn().mockResolvedValue(null),
      });
      mockCreateA2AClient.mockReturnValue(client);

      const result = (await handleA2ATool("a2a_cancel_task", {
        agentId: "11155111:42",
        taskId: "task-123",
      })) as { result: unknown };

      expect(result.result).toEqual({});
    });
  });

  // ===========================================================================
  // Unknown tool
  // ===========================================================================
  it("returns error for unknown tool", async () => {
    const result = (await handleA2ATool("nonexistent", {})) as {
      error: string;
    };
    expect(result.error).toContain("Unknown A2A tool");
  });
});
