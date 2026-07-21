#!/usr/bin/env node
process.env.KNOWLEDGE_WORK_MCP_MODE = 'public-benchmark';
await import('./index.js');
