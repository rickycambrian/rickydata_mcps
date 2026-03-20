import app from './app.js';
import { config } from './config/index.js';

app.listen(config.port, () => {
  console.log(`[API] Geo Research Papers API running on port ${config.port}`);
  console.log(`[API] Health: http://localhost:${config.port}/api/v1/health`);
});
