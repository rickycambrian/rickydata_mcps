#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { registerTools } from './tools.js';
import { loadSignerFromEnv } from './wallet-token.js';
import { HomeKnowledgeClient } from './home-client.js';
import { loadKfdbClientFromEnv } from './kfdb-client.js';
import { S2DSessionManager } from './s2d.js';

const server = new McpServer({
  name: 'knowledge-work-mcp',
  version: '0.1.0',
});

const env = process.env;
const signer = loadSignerFromEnv(env);
const home = new HomeKnowledgeClient({
  baseUrl: env.HOME_API_URL?.trim() || 'http://localhost:8788',
  signer,
});
const s2d =
  env.KFDB_API_URL?.trim() && env.KNOWLEDGE_MCP_PRIVATE_KEY?.trim()
    ? new S2DSessionManager(env.KFDB_API_URL.trim(), env.KNOWLEDGE_MCP_PRIVATE_KEY.trim())
    : null;
const kfdb = loadKfdbClientFromEnv(env, s2d);

registerTools(server, { home, kfdb });

async function main() {
  const useHttp = env.TRANSPORT === 'http' || env.PORT;

  if (useHttp) {
    const [{ default: express }, { default: cors }] = await Promise.all([import('express'), import('cors')]);
    const app = express();
    const port = parseInt(env.PORT || '8080', 10);

    app.use(cors());
    app.use(express.json());

    let transport: SSEServerTransport | null = null;

    app.get('/health', (_req, res) => {
      res.json({
        status: 'ok',
        server: 'knowledge-work-mcp',
        home_configured: Boolean(signer),
        kfdb_configured: Boolean(kfdb),
        s2d_configured: Boolean(s2d),
      });
    });

    app.get('/sse', async (_req, res) => {
      transport = new SSEServerTransport('/messages', res);
      await server.connect(transport);
    });

    app.post('/messages', async (req, res) => {
      if (!transport) return res.status(400).json({ error: 'No SSE connection' });
      await transport.handlePostMessage(req, res);
    });

    app.listen(port, () => {
      console.log(`knowledge-work-mcp running on http://localhost:${port}`);
    });
  } else {
    const transport = new StdioServerTransport();
    await server.connect(transport);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
