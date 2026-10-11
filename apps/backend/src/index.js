import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import { ensureDir } from './utils/fsUtils.js';
import { DATA_DIR, PORT, TUNNEL_MODE } from './config/constants.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerArxivRoutes } from './routes/arxiv.js';
import { registerProjectRoutes } from './routes/projects.js';
import { registerProjectBackupRoutes } from './routes/projectBackups.js';
import { registerCompileRoutes } from './routes/compile.js';
import { registerLLMRoutes } from './routes/llm.js';
import { registerVisionRoutes } from './routes/vision.js';
import { registerPlotRoutes } from './routes/plot.js';
import { registerAgentRoutes } from './routes/agent.js';
import { registerCollabRoutes } from './routes/collab.js';
import { registerTransferRoutes } from './routes/transfer.js';
import { registerResearchWorkflowRoutes } from './routes/researchWorkflow.js';
import { registerHarnessRunRoutes } from './routes/harnessRuns.js';
import { registerEvidenceLedgerRoutes } from './routes/evidenceLedger.js';
import { registerProjectHubRoutes } from './routes/projectHub.js';
import { registerExperimentRunRoutes } from './routes/experimentRuns.js';
import { registerObservabilityRoutes } from './routes/observability.js';
import { registerConstraintProposalRoutes } from './routes/constraintProposals.js';
import { registerMcpRoutes } from './routes/mcp.js';
import { registerExplorationRoutes } from './routes/exploration.js';
import { registerConstraintPolicyRoutes } from './routes/constraintPolicy.js';
import { tryStartTunnel } from './services/tunnel.js';
import { registerApiAuth } from './utils/authUtils.js';
import { shutdownExperimentRuns } from './services/experimentRunner/index.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { registerFrontendStatic } from './utils/frontendStatic.js';

const fastify = Fastify({ logger: true });

await fastify.register(cors, { origin: true });
await fastify.register(multipart, {
  limits: {
    fileSize: 200 * 1024 * 1024
  }
});
await fastify.register(websocket);
registerApiAuth(fastify);

registerHealthRoutes(fastify);
registerArxivRoutes(fastify);
registerProjectRoutes(fastify);
registerProjectBackupRoutes(fastify);
registerCompileRoutes(fastify);
registerLLMRoutes(fastify);
registerVisionRoutes(fastify);
registerPlotRoutes(fastify);
registerAgentRoutes(fastify);
registerCollabRoutes(fastify);
registerTransferRoutes(fastify);
registerResearchWorkflowRoutes(fastify);
registerHarnessRunRoutes(fastify);
registerEvidenceLedgerRoutes(fastify);
registerProjectHubRoutes(fastify);
registerExperimentRunRoutes(fastify);
registerObservabilityRoutes(fastify);
registerConstraintProposalRoutes(fastify);
registerConstraintPolicyRoutes(fastify);
registerExplorationRoutes(fastify);
registerMcpRoutes(fastify);

// Serve frontend static files in tunnel/production mode
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const frontendDist = join(__dirname, '../../frontend/dist');

if (existsSync(frontendDist)) {
  await registerFrontendStatic(fastify, frontendDist);
}

await ensureDir(DATA_DIR);

let shutdownStarted = false;
async function shutdown() {
  if (shutdownStarted) return;
  shutdownStarted = true;
  const closing = fastify.close();
  try {
    await shutdownExperimentRuns();
    await closing;
    process.exit(0);
  } catch (error) {
    fastify.log.error(error, 'Server shutdown failed');
    process.exit(1);
  }
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

await fastify.listen({ port: PORT, host: '0.0.0.0' });

console.log('');
console.log(`  SciencePrism started at http://localhost:${PORT}`);
console.log('');

const tunnelMode = TUNNEL_MODE.toLowerCase().trim();
if (tunnelMode !== 'false' && tunnelMode !== '0' && tunnelMode !== 'no') {
  console.log('  Tunnel starting...');
  const result = await tryStartTunnel(PORT);
  if (result) {
    console.log(`  Tunnel active (${result.provider}):`);
    console.log(`  Public URL: ${result.url}`);
    console.log('  Share this URL to collaborate remotely!');
    console.log('');
  } else {
    console.log('  Tunnel failed to start. Check that the provider is installed.');
    console.log('');
  }
} else {
  console.log('  Want remote collaboration? Start with tunnel:');
    console.log('    SCIENCEPRISM_TUNNEL=localtunnel npm start');
    console.log('    SCIENCEPRISM_TUNNEL=cloudflared npm start');
    console.log('    SCIENCEPRISM_TUNNEL=ngrok npm start');
  console.log('');
}
