#!/usr/bin/env bash
# Production verification script for agent0-mcp MCP server
# Tests critical tools via MCP gateway after publish/deploy
#
# Required env vars:
#   MCP_GATEWAY_URL  - Gateway URL (default: https://mcp.rickydata.org)
#   OPERATOR_WALLET_TOKEN - Bearer token for auth (mcpwt_ or JWT)
#
# Exit codes:
#   0 = all checks passed
#   1 = verification failed

set -euo pipefail

GATEWAY="${MCP_GATEWAY_URL:-https://mcp.rickydata.org}"
TOKEN="${OPERATOR_WALLET_TOKEN:-}"
SESSION_ID=""
PASSED=0
FAILED=0

# Colors (if terminal supports it)
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

log_pass() { echo -e "${GREEN}✓${NC} $1"; ((PASSED++)); }
log_fail() { echo -e "${RED}✗${NC} $1"; ((FAILED++)); }
log_info() { echo -e "${YELLOW}→${NC} $1"; }

# ============================================================================
# MCP JSON-RPC helpers
# ============================================================================

mcp_call() {
  local id="$1"
  local method="$2"
  local params="$3"

  local headers=(-H "Content-Type: application/json")
  if [ -n "$TOKEN" ]; then
    headers+=(-H "Authorization: Bearer $TOKEN")
  fi
  if [ -n "$SESSION_ID" ]; then
    headers+=(-H "mcp-session-id: $SESSION_ID")
  fi

  curl -s -X POST "$GATEWAY/mcp" \
    "${headers[@]}" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":$id,\"method\":\"$method\",\"params\":$params}"
}

# ============================================================================
# Step 1: Initialize MCP session
# ============================================================================

log_info "Initializing MCP session with $GATEWAY"

INIT_RESPONSE=$(mcp_call 1 "initialize" '{
  "protocolVersion": "2024-11-05",
  "capabilities": {},
  "clientInfo": {"name": "agent0-mcp-verify", "version": "1.0.0"}
}')

if echo "$INIT_RESPONSE" | grep -q '"protocolVersion"'; then
  # Extract session ID from response headers (retry with -i)
  INIT_WITH_HEADERS=$(curl -s -i -X POST "$GATEWAY/mcp" \
    -H "Content-Type: application/json" \
    ${TOKEN:+-H "Authorization: Bearer $TOKEN"} \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"agent0-mcp-verify","version":"1.0.0"}}}')
  SESSION_ID=$(echo "$INIT_WITH_HEADERS" | grep -i "mcp-session-id:" | tr -d '\r' | awk '{print $2}')
  log_pass "MCP session initialized (session: ${SESSION_ID:0:12}...)"
else
  log_fail "MCP initialization failed: $INIT_RESPONSE"
  exit 1
fi

# ============================================================================
# Step 2: Enable agent0-mcp server
# ============================================================================

log_info "Enabling @rickydata/agent0-mcp server"

ENABLE_RESPONSE=$(mcp_call 2 "tools/call" '{
  "name": "gateway__enable_server",
  "arguments": {"server_name": "@rickydata/agent0-mcp"}
}')

if echo "$ENABLE_RESPONSE" | grep -q '"toolCount"' || echo "$ENABLE_RESPONSE" | grep -q '"enabled"' || echo "$ENABLE_RESPONSE" | grep -q '"already_enabled"'; then
  log_pass "Server enabled"
else
  # May need cold start — wait and retry
  log_info "Cold start detected, waiting 15s..."
  sleep 15
  ENABLE_RESPONSE=$(mcp_call 2 "tools/call" '{
    "name": "gateway__enable_server",
    "arguments": {"server_name": "@rickydata/agent0-mcp"}
  }')
  if echo "$ENABLE_RESPONSE" | grep -q -E '"toolCount"|"enabled"|"already_enabled"'; then
    log_pass "Server enabled (after cold start)"
  else
    log_fail "Server enable failed: $ENABLE_RESPONSE"
  fi
fi

# ============================================================================
# Step 3: Test critical read-only tools
# ============================================================================

# Test get_supported_chains
log_info "Testing get_supported_chains"
CHAINS_RESPONSE=$(mcp_call 3 "tools/call" '{
  "name": "rickydata-agent0-mcp__get_supported_chains",
  "arguments": {}
}')
if echo "$CHAINS_RESPONSE" | grep -q '"Ethereum"' || echo "$CHAINS_RESPONSE" | grep -q '"chainId"'; then
  log_pass "get_supported_chains returns chain data"
else
  log_fail "get_supported_chains failed: $CHAINS_RESPONSE"
fi

# Test search_agents
log_info "Testing search_agents"
SEARCH_RESPONSE=$(mcp_call 4 "tools/call" '{
  "name": "rickydata-agent0-mcp__search_agents",
  "arguments": {"limit": 2}
}')
if echo "$SEARCH_RESPONSE" | grep -q '"agentId"'; then
  log_pass "search_agents returns agents"
else
  log_fail "search_agents failed: $SEARCH_RESPONSE"
fi

# Test get_auth_status
log_info "Testing get_auth_status"
AUTH_RESPONSE=$(mcp_call 5 "tools/call" '{
  "name": "rickydata-agent0-mcp__get_auth_status",
  "arguments": {}
}')
if echo "$AUTH_RESPONSE" | grep -q '"hasKey"' || echo "$AUTH_RESPONSE" | grep -q '"isReadOnly"'; then
  log_pass "get_auth_status returns status"
else
  log_fail "get_auth_status failed: $AUTH_RESPONSE"
fi

# Test get_registries (new in v0.9.0)
log_info "Testing get_registries (v0.9.0)"
REG_RESPONSE=$(mcp_call 6 "tools/call" '{
  "name": "rickydata-agent0-mcp__get_registries",
  "arguments": {}
}')
if echo "$REG_RESPONSE" | grep -q '"identity"' || echo "$REG_RESPONSE" | grep -q '"0x8004"'; then
  log_pass "get_registries returns contract addresses"
else
  log_fail "get_registries failed: $REG_RESPONSE"
fi

# ============================================================================
# Summary
# ============================================================================

echo ""
echo "================================"
echo "Verification Results"
echo "================================"
echo -e "Passed: ${GREEN}$PASSED${NC}"
echo -e "Failed: ${RED}$FAILED${NC}"
echo ""

if [ "$FAILED" -gt 0 ]; then
  log_fail "Production verification FAILED ($FAILED checks failed)"
  exit 1
else
  log_pass "All production checks passed"
  exit 0
fi
