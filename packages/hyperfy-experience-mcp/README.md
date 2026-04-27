# @rickydata/hyperfy-experience-mcp

MCP server for planning, generating, registering, and publishing RickyData Hyperfy experiences.

## Tools

- `plan_experience_room` - create a room-scale experience plan with walk-up stations and asset prompts.
- `create_agent_station_spec` - create a single RickyData agent station spec.
- `list_hyperfy_assets` - search the Hyperfy asset library.
- `generate_meshy_asset` - call the Hyperfy Meshy Text-to-3D generator and register the output asset.
- `create_hyperfy_app_record` - create a portable public Hyperfy app/experience registry record.
- `publish_experience_to_kfdb` - prepare or submit a KFDB write payload for `HyperfyExperience`.

## Configuration

```bash
HYPERFY_REPO=/Users/riccardoesclapon/Documents/github/knowledgeflow_hyperfy
MESHI_API_KEY=...
GEMIN_API_KEY=...
KFDB_API_URL=http://34.60.37.158
KFDB_API_KEY=...
```

`MESHY_API_KEY` / `GEMINI_API_KEY` are also supported by the Hyperfy generation scripts.

## Development

```bash
npm install
npm run build
npm run dev
```

## HTTP Transport

```bash
npm run build
node dist/index.js --http
curl -s http://localhost:8080/health
```

## Stdio Smoke Test

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  | node dist/index.js
```
