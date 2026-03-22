# @rickydata/agent0-mcp

MCP server wrapping the [Agent0 SDK](https://www.npmjs.com/package/agent0-sdk) for ERC-8004 trustless agent operations. Discover, register, and interact with on-chain AI agents across Ethereum, Base, and Polygon.

## Quick Connect

```bash
# stdio (Claude Code / Claude Desktop)
cd packages/agent0-mcp && npm run dev -- --stdio

# HTTP (Streamable HTTP transport)
cd packages/agent0-mcp && PORT=8080 npm run dev

# Claude Code
claude mcp add --transport http agent0-mcp http://localhost:8080/mcp
```

## Tools (17)

### Discovery (read-only, no auth needed)
| Tool | Description |
|------|-------------|
| `search_agents` | Multi-chain agent search with filters (name, tools, skills, reputation) |
| `get_agent` | Get agent details by chainId:tokenId |
| `get_supported_chains` | List ERC-8004 supported chains and registry addresses |
| `get_platform_stats` | Aggregate stats (total agents, MCP/A2A/x402 counts) |
| `get_reputation_summary` | Reputation count + average + trust label for an agent |
| `search_feedback` | Search feedback by agent, reviewer, tags, value range |

### Authentication
| Tool | Description |
|------|-------------|
| `configure_wallet` | Set up wallet for write ops (private key or signature derivation) |
| `get_derivation_message` | Get the message to sign for key derivation |
| `get_auth_status` | Check wallet configuration status |

### Registration (requires wallet)
| Tool | Description |
|------|-------------|
| `register_agent` | Register new agent on-chain (IPFS or data URI) |
| `update_agent` | Update existing agent properties |

### Reputation (requires wallet)
| Tool | Description |
|------|-------------|
| `give_feedback` | Submit on-chain feedback/review (0-100 score) |
| `revoke_feedback` | Revoke previously submitted feedback |

### Payments
| Tool | Description |
|------|-------------|
| `x402_request` | HTTP request with x402 payment handling |

### A2A (requires wallet)
| Tool | Description |
|------|-------------|
| `a2a_send_message` | Send message to agent via A2A protocol |
| `a2a_list_tasks` | List A2A tasks/conversations |
| `a2a_get_task` | Get A2A task details |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `AGENT0_CHAIN_ID` | No | Default chain (default: 11155111 Sepolia) |
| `AGENT0_RPC_URL` | No | Custom RPC URL |
| `ERC8004_PRIVATE_KEY` | No | Direct private key for write ops |
| `ERC8004_DERIVED_KEY` | No | Previously derived key |
| `PINATA_JWT` | No | Pinata JWT for IPFS registration |

## Development

```bash
npm install
npm run dev       # stdio mode
npm run build     # compile TypeScript
npm test          # run vitest
```

## Docker

```bash
docker build -t agent0-mcp .
docker run -p 8080:8080 agent0-mcp
```
