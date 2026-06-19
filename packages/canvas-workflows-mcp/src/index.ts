#!/usr/bin/env node
/**
 * canvas-workflows-mcp — a narrow, wallet-scoped MCP that drives rickydata_home's
 * canvas workflows through home's authenticated /api/canvas/* routes. Home owns the
 * CanvasExecutor, the durable KFDB store, and the HITL bridge; this server is a thin,
 * FAIL-CLOSED remote control authenticated AS the operator wallet.
 *
 * Env:
 *   HOME_API_URL            base URL of rickydata_home (default http://localhost:8788)
 *   CANVAS_MCP_PRIVATE_KEY  operator wallet private key — mints the scwt_ bearer.
 *                           Absent → every tool fails closed (the wallet is the auth boundary).
 *   TRANSPORT=http | PORT   run the HTTP/SSE transport instead of stdio.
 *
 * Dual transport mirrors the monorepo template: stdio by default, HTTP/SSE when
 * TRANSPORT=http or PORT is set.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { registerTools, TOOL_NAMES } from './tools.js';
import { HomeCanvasClient } from './home-client.js';
import { loadSignerFromEnv } from './wallet-token.js';

const SERVER_NAME = 'canvas-workflows-mcp';
const SERVER_VERSION = '0.1.0';

const HOME_API_URL = process.env.HOME_API_URL || 'http://localhost:8788';

/** Build the fail-closed home client from env: signer is null when no key is set. */
function buildClient(): HomeCanvasClient {
  return new HomeCanvasClient({
    baseUrl: HOME_API_URL,
    signer: loadSignerFromEnv(),
  });
}

function createServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerTools(server, { client: buildClient() });
  return server;
}

async function main(): Promise<void> {
  const useHttp = process.env.TRANSPORT === 'http' || Boolean(process.env.PORT);

  if (useHttp) {
    const { default: express } = await import('express');
    const { default: cors } = await import('cors');
    const app = express();
    app.use(cors());
    const port = parseInt(process.env.PORT || '8080', 10);

    let transport: SSEServerTransport | null = null;

    app.get('/health', (_req, res) =>
      res.json({ status: 'ok', server: SERVER_NAME, version: SERVER_VERSION, tools: TOOL_NAMES.length, home: HOME_API_URL }),
    );

    app.get('/sse', async (_req, res) => {
      transport = new SSEServerTransport('/messages', res);
      await createServer().connect(transport);
    });

    app.post('/messages', async (req, res) => {
      if (!transport) {
        res.status(400).json({ error: 'No SSE connection' });
        return;
      }
      await transport.handlePostMessage(req, res);
    });

    app.listen(port, () => {
      // stdout is fine in HTTP mode (no stdio MCP framing to corrupt).
      console.log(`${SERVER_NAME} running on http://localhost:${port} (${TOOL_NAMES.length} tools, home=${HOME_API_URL})`);
    });
  } else {
    // In stdio mode, stdout is the MCP channel — keep logs on stderr.
    console.log = console.error;
    const transport = new StdioServerTransport();
    await createServer().connect(transport);
    console.error(`${SERVER_NAME} running on stdio (${TOOL_NAMES.length} tools, home=${HOME_API_URL})`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
