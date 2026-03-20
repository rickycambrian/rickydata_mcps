import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { registerTools } from './tools.js';

const server = new McpServer({
  name: 'TEMPLATE_NAME',
  version: '0.1.0',
});

registerTools(server);

async function main() {
  const useHttp = process.env.TRANSPORT === 'http' || process.env.PORT;

  if (useHttp) {
    const { default: express } = await import('express');
    const app = express();
    const port = parseInt(process.env.PORT || '8080', 10);

    let transport: SSEServerTransport | null = null;

    app.get('/health', (_req, res) => res.json({ status: 'ok' }));

    app.get('/sse', async (req, res) => {
      transport = new SSEServerTransport('/messages', res);
      await server.connect(transport);
    });

    app.post('/messages', async (req, res) => {
      if (!transport) return res.status(400).json({ error: 'No SSE connection' });
      await transport.handlePostMessage(req, res);
    });

    app.listen(port, () => {
      console.log(`Server running on http://localhost:${port}`);
    });
  } else {
    const transport = new StdioServerTransport();
    await server.connect(transport);
  }
}

main().catch(console.error);
