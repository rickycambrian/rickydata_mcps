---
name: create-mcp-server
description: Step-by-step guide for creating a new MCP server in the monorepo. Use when the user wants to add a new MCP server package.
---

# Create MCP Server

## Steps

1. **Copy template**
   ```bash
   cp -r _template packages/<server-name>
   ```

2. **Update package.json**
   - Set `name` to the server name
   - Set `description`
   - Add any additional dependencies (e.g., `zod` for input validation)
   - Keep `@modelcontextprotocol/sdk` in dependencies (required for detection)

3. **Update tsconfig.json**
   - Already extends `../../tsconfig.base.json` — no changes needed unless custom paths required

4. **Implement tools in `src/tools.ts`**
   - Import `McpServer` from `@modelcontextprotocol/sdk/server/mcp.js`
   - Use `z` from `zod` for input schemas
   - Register tools with `server.tool(name, description, schema, handler)`
   - Return `{ content: [{ type: 'text', text: '...' }] }` from handlers

5. **Update `src/index.ts`**
   - Update server name and version
   - Import and call `registerTools(server)`

6. **Update Dockerfile**
   - Update HEALTHCHECK if the health endpoint differs

7. **Update README.md**
   - Document tools, configuration, and usage

8. **Test**
   ```bash
   cd packages/<server-name>
   npm install
   npm run dev
   ```

## Detection Requirement

The `package.json` MUST have `@modelcontextprotocol/sdk` in `dependencies` or `devDependencies` for the enrichment pipeline to detect it as an MCP server.
