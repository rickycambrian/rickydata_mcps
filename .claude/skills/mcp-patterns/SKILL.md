---
name: mcp-patterns
description: Reference patterns for MCP server development. Working patterns from rickydata-mcp including dual transport, tool organization, response capping, and wallet token verification.
---

# MCP Development Patterns

## Dual Transport Setup

Every MCP server should support both stdio and HTTP/SSE:

```typescript
// In index.ts
const useHttp = process.env.TRANSPORT === 'http' || process.env.PORT;

if (useHttp) {
  // Express + SSE transport
  const app = express();
  const port = parseInt(process.env.PORT || '8080', 10);
  // ... SSE setup
} else {
  // stdio transport (default for Claude Desktop, etc.)
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
```

## Tool Organization

Group tools by domain in separate files:

```
src/
  index.ts           # Server setup + transport
  tools.ts           # Tool registration (imports from domain files)
  marketplace.ts     # Marketplace-related tools
  wallet-token.ts    # Auth/wallet tools
```

## Response Capping

Cap response sizes to prevent token overflow:

```typescript
const MAX_RESPONSE_LENGTH = 10000;
function capResponse(text: string): string {
  if (text.length <= MAX_RESPONSE_LENGTH) return text;
  return text.slice(0, MAX_RESPONSE_LENGTH) + '\n... (truncated)';
}
```

## Input Validation with Zod

```typescript
import { z } from 'zod';

server.tool(
  'search',
  'Search for items',
  {
    query: z.string().describe('Search query'),
    limit: z.number().optional().default(10).describe('Max results'),
  },
  async ({ query, limit }) => {
    // implementation
  },
);
```
