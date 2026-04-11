---
name: agent-update-workflow
description: Verified workflow for updating agent definitions in mcp_deployments_registry to use new/updated MCP servers. Use when integrating a new MCP server from this monorepo into a deployed agent.
---

# Agent Update Workflow

Verified 2026-04-11. Process for updating agents deployed via mcp_deployments_registry to use MCP servers from this monorepo.

## Prerequisites

- MCP server published to npm and registered on gateway (visible via `rickydata mcp search <name>`)
- Server UUID from KFDB (use `mcp__mcp-gateway__gateway__server_info` or gateway API)
- Access to mcp_deployments_registry repo

## Step 1: Find Server UUID

```bash
# Via gateway search
rickydata mcp search research-papers-mcp
# Or via API
curl -s 'https://mcp.rickydata.org/api/enrichment/check?repo=https://github.com/rickycambrian/rickydata_mcps' | python3 -c "import sys,json; print(json.load(sys.stdin).get('serverId'))"
```

Verified: research-papers-mcp UUID is `ea0bb10e-0ea3-425a-bde9-271e653abde5`.

## Step 2: Update Agent Definition

Edit `.claude/agents/<agent-name>.md` in mcp_deployments_registry:

1. Add UUID to `mcp_servers` (comma-separated): `mcp_servers: ..., ea0bb10e-0ea3-425a-bde9-271e653abde5`
2. Add tool documentation section with usage examples
3. Update Tool Reliability table with new tools
4. Update priority instructions in frontmatter

## Step 3: Update Related Skills

Edit `.claude/skills/<skill>/SKILL.md` for any skills that reference the tools:

- Add "Preferred Approach" section pointing to new tools
- Keep existing approach as fallback
- Do NOT rewrite working skills — add to them

## Step 4: Push to Deploy

```bash
cd /path/to/mcp_deployments_registry
git add .claude/agents/<agent>.md .claude/skills/*/SKILL.md
git commit -m "feat(agent): add <server> to <agent>"
git push origin main
```

CI auto-deploys when `.claude/agents/` or `.claude/skills/` change on main.

## Step 5: Verify Deployment

```bash
# Check agent gateway picked up changes (wait ~2-3 min for CI)
curl -s "https://agents.rickydata.org/agents/<agent-slug>" | python3 -c "import sys,json; d=json.load(sys.stdin); print('MCP servers:', d.get('mcpServers',[])); print('Tools:', len(d.get('tools',[])))"
```

## Step 6: E2E Test

```bash
# Via rickydata CLI
rickydata chat <agent-slug> --model haiku

# Or direct API
TOKEN=$(rickydata auth token)
SESSION=$(curl -s -X POST "https://agents.rickydata.org/agents/<agent-slug>/sessions" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"model":"haiku"}' | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))")
echo "Session: $SESSION"
```

## Gotchas

- **CI deploy takes 2-3 minutes** after push. Check GitHub Actions for status.
- **Tool name collisions**: Gateway prefixes with server UUID, so same-named tools from different servers won't conflict at protocol level. But agent instructions should clarify which to use.
- **list_papers ambiguity**: research-papers-mcp `list_papers` (KFDB persistent) vs blazickjp `list_papers` (session-only). Agent instructions must clarify.
