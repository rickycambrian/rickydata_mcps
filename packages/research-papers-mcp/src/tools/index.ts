import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { discoveryTools, handleDiscoveryTool } from "./discovery.js";
import { ingestionTools, handleIngestionTool } from "./ingestion.js";
import { navigationTools, handleNavigationTool } from "./navigation.js";
import { searchTools, handleSearchTool } from "./search.js";

// Aggregate all tool definitions
export const TOOLS: Tool[] = [
  ...discoveryTools,
  ...ingestionTools,
  ...navigationTools,
  ...searchTools,
];

// Tool name -> handler routing map
const TOOL_HANDLERS: Record<
  string,
  (args: Record<string, unknown>) => Promise<unknown>
> = {};

for (const tool of discoveryTools) {
  TOOL_HANDLERS[tool.name] = (args) => handleDiscoveryTool(tool.name, args);
}
for (const tool of ingestionTools) {
  TOOL_HANDLERS[tool.name] = (args) => handleIngestionTool(tool.name, args);
}
for (const tool of navigationTools) {
  TOOL_HANDLERS[tool.name] = (args) => handleNavigationTool(tool.name, args);
}
for (const tool of searchTools) {
  TOOL_HANDLERS[tool.name] = (args) => handleSearchTool(tool.name, args);
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
