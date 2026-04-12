import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { discoveryTools, handleDiscoveryTool } from "./discovery.js";
import { reputationTools, handleReputationTool } from "./reputation.js";
import { registrationTools, handleRegistrationTool } from "./registration.js";
import { paymentsTools, handlePaymentsTool } from "./payments.js";
import { a2aTools, handleA2ATool } from "./a2a.js";
import { ownershipTools, handleOwnershipTool } from "./ownership.js";
import { kfdbTools, handleKfdbTool } from "./kfdb.js";
import { onchainTools, handleOnchainTool } from "./onchain.js";

// Aggregate all tool definitions
export const TOOLS: Tool[] = [
  ...discoveryTools,
  ...reputationTools,
  ...registrationTools,
  ...paymentsTools,
  ...a2aTools,
  ...ownershipTools,
  ...kfdbTools,
  ...onchainTools,
];

// Tool name -> handler routing map
const TOOL_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {};

for (const tool of discoveryTools) {
  TOOL_HANDLERS[tool.name] = (args) => handleDiscoveryTool(tool.name, args);
}
for (const tool of reputationTools) {
  TOOL_HANDLERS[tool.name] = (args) => handleReputationTool(tool.name, args);
}
for (const tool of registrationTools) {
  TOOL_HANDLERS[tool.name] = (args) => handleRegistrationTool(tool.name, args);
}
for (const tool of paymentsTools) {
  TOOL_HANDLERS[tool.name] = (args) => handlePaymentsTool(tool.name, args);
}
for (const tool of a2aTools) {
  TOOL_HANDLERS[tool.name] = (args) => handleA2ATool(tool.name, args);
}
for (const tool of ownershipTools) {
  TOOL_HANDLERS[tool.name] = (args) => handleOwnershipTool(tool.name, args);
}
for (const tool of kfdbTools) {
  TOOL_HANDLERS[tool.name] = (args) => handleKfdbTool(tool.name, args);
}
for (const tool of onchainTools) {
  TOOL_HANDLERS[tool.name] = (args) => handleOnchainTool(tool.name, args);
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
