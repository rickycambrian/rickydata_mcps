# rickydata MCPs Development Guide

## Overview

Monorepo for custom MCP servers. Each server lives in `packages/<name>/`.

## Creating a New MCP Server

Use the `create-mcp-server` skill: copy `_template/` to `packages/<name>/`, then customize.

1. Copy template: `cp -r _template packages/<name>`
2. Update `packages/<name>/package.json` — set name, description, dependencies
3. Implement tools in `packages/<name>/src/tools.ts`
4. Update `packages/<name>/README.md`
5. Test: `cd packages/<name> && npm install && npm run dev`

## Detection Marker

For the enrichment pipeline to detect a package as an MCP server, it MUST have `@modelcontextprotocol/sdk` in `package.json` dependencies (or `mcp` in `pyproject.toml` for Python).

## Structure

```
packages/
  rickydata-mcp/          # Marketplace + wallet tools
  research-papers-mcp/    # arXiv ingestion + KFDB-backed paper navigation (6 tools)
  geo-research-api/       # Geo research paper API (not an MCP server)
  <your-server>/          # Your new MCP server
_template/                # Template for new servers
```

## Development

```bash
# Install all workspace dependencies
npm install

# Build all packages
npm run build

# Work on a specific package
cd packages/<name>
npm run dev
```

## Patterns

- **Dual transport**: Every MCP server supports both stdio (default) and HTTP/SSE (via TRANSPORT=http or PORT env var)
- **Tool organization**: Group tools by domain in separate files, register them in `tools.ts`
- **Response capping**: Cap response content to prevent token overflow
- **Wallet token verification**: Use `wallet-token.ts` pattern for auth when needed

## Skills Reference

- **`create-mcp-server`**: Step-by-step scaffold guide for new MCP servers
- **`mcp-patterns`**: Reusable patterns (dual transport, tool organization, response capping, Zod validation)
- **`research-papers-dev`**: Verified build/run/test workflow for `research-papers-mcp` — use when working on that package
