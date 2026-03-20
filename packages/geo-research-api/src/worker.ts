import { config } from './config/index.js';
import * as KfdbService from './services/KfdbService.js';
import { executeDiscoveryRun, processPromotedCandidate } from './services/DiscoveryOrchestrator.js';
import http from 'node:http';

async function pollOnce(): Promise<void> {
  const pendingRuns = await KfdbService.listDiscoveryRuns('pending', 10);
  for (const run of pendingRuns) {
    console.log(`[WORKER] Executing discovery run ${run.id} for topic profile ${run.topic_profile_id}`);
    try {
      await executeDiscoveryRun(run.id);
    } catch (err) {
      console.error(`[WORKER] Discovery run ${run.id} failed`, err);
    }
  }

  const promotedCandidates = await KfdbService.listPaperCandidates({ status: 'promoted', limit: 10 });
  for (const candidate of promotedCandidates) {
    console.log(`[WORKER] Processing promoted candidate ${candidate.id} (${candidate.arxiv_id})`);
    try {
      await processPromotedCandidate(candidate.id);
    } catch (err) {
      console.error(`[WORKER] Candidate ${candidate.id} failed`, err);
    }
  }
}

async function main(): Promise<void> {
  console.log(`[WORKER] Analyst research center worker started. Poll interval: ${config.worker.pollIntervalMs}ms`);

  const port = parseInt(process.env.PORT || '8080', 10);
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'geo-research-worker' }));
  });
  server.listen(port, () => {
    console.log(`[WORKER] Health server listening on port ${port}`);
  });

  while (true) {
    try {
      await pollOnce();
    } catch (err) {
      console.error('[WORKER] Poll iteration failed', err);
    }

    await new Promise((resolve) => setTimeout(resolve, config.worker.pollIntervalMs));
  }
}

main().catch((err) => {
  console.error('[WORKER] Fatal worker error', err);
  process.exit(1);
});
