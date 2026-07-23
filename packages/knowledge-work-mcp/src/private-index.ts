#!/usr/bin/env node
process.env.KNOWLEDGE_WORK_MCP_MODE = 'private-benchmark';
await import('./index.js');
