import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { ingestionTools, handleIngestionTool } from "./ingestion.js";
import { searchTools, handleSearchTool } from "./search.js";
import { analyticsTools, handleAnalyticsTool } from "./analytics.js";
import { configTools, handleConfigTool } from "./config.js";
import { twitterTools, handleTwitterTool } from "./twitter.js";
import { intelligenceTools, handleIntelligenceTool } from "./intelligence.js";

// Aggregate all tool definitions
export const TOOLS: Tool[] = [
  ...ingestionTools,
  ...searchTools,
  ...analyticsTools,
  ...configTools,
  ...twitterTools,
  ...intelligenceTools,
];

// Tool name -> handler routing map
const TOOL_HANDLERS: Record<
  string,
  (args: Record<string, unknown>) => Promise<unknown>
> = {};

for (const tool of ingestionTools) {
  TOOL_HANDLERS[tool.name] = (args) => handleIngestionTool(tool.name, args);
}
for (const tool of searchTools) {
  TOOL_HANDLERS[tool.name] = (args) => handleSearchTool(tool.name, args);
}
for (const tool of analyticsTools) {
  TOOL_HANDLERS[tool.name] = (args) => handleAnalyticsTool(tool.name, args);
}
for (const tool of configTools) {
  TOOL_HANDLERS[tool.name] = (args) => handleConfigTool(tool.name, args);
}
for (const tool of twitterTools) {
  TOOL_HANDLERS[tool.name] = (args) => handleTwitterTool(tool.name, args);
}
for (const tool of intelligenceTools) {
  TOOL_HANDLERS[tool.name] = (args) => handleIntelligenceTool(tool.name, args);
}

export async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const handler = TOOL_HANDLERS[name];
  if (!handler) {
    return { error: `Unknown tool: ${name}` };
  }
  return handler(args);
}
