import {
  cancelExperimentRun,
  compareExperimentRuns,
  createExperimentRun,
  decideExperimentRun,
  getExperimentRun,
  listExperimentRuns,
  recordExperimentInterpretation,
  retryExperimentRun,
  startExperimentRun
} from '../services/experimentRunner/index.js';
import { ExperimentRunnerError } from '../services/experimentRunner/errors.js';

const BASE = '/api/projects/:id/experiment-runs';

function bodyOf(req) { return req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}; }
function actor(req, body = {}) { return body.actor || req.headers?.['x-scienceprism-actor'] || req.collabAuth?.sub || 'human'; }

function sendError(req, reply, error) {
  if (error?.code === 'FEATURE_FLAG_DISABLED') return reply.code(403).send({ ok: false, error: { code: error.code, message: error.message, details: error.details } });
  if (error instanceof ExperimentRunnerError) return reply.code(error.statusCode).send({ ok: false, error: { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) } });
  req.log?.error?.(error);
  return reply.code(500).send({ ok: false, error: { code: 'EXPERIMENT_RUNNER_ERROR', message: error instanceof Error ? error.message : String(error) } });
}

function route(handler) {
  return async (req, reply) => {
    try { return reply.send({ ok: true, ...(await handler(req, reply)) }); }
    catch (error) { return sendError(req, reply, error); }
  };
}

export function registerExperimentRunRoutes(fastify) {
  fastify.get(BASE, route(async (req) => ({ runs: await listExperimentRuns(req.params.id, req.query || {}) })));
  fastify.get(`${BASE}/comparisons`, route(async (req) => ({ comparison: await compareExperimentRuns(req.params.id, req.query?.runIds || req.query?.ids) })));
  fastify.get(`${BASE}/:runId`, route(async (req) => ({ run: await getExperimentRun(req.params.id, req.params.runId) })));
  fastify.post(BASE, route(async (req, reply) => { const run = await createExperimentRun(req.params.id, bodyOf(req), { actor: actor(req, bodyOf(req)) }); reply.code(201); return { run }; }));
  fastify.post(`${BASE}/:runId/decision`, route(async (req) => ({ run: await decideExperimentRun(req.params.id, req.params.runId, { ...bodyOf(req), actor: actor(req, bodyOf(req)) }) })));
  fastify.post(`${BASE}/:runId/start`, route(async (req) => ({ run: await startExperimentRun(req.params.id, req.params.runId, { wait: bodyOf(req).wait === true }) })));
  fastify.post(`${BASE}/:runId/cancel`, route(async (req) => ({ run: await cancelExperimentRun(req.params.id, req.params.runId) })));
  fastify.post(`${BASE}/:runId/retry`, route(async (req) => ({ run: await retryExperimentRun(req.params.id, req.params.runId, { actor: actor(req, bodyOf(req)) }) })));
  fastify.post(`${BASE}/:runId/interpret`, route(async (req) => ({ run: await recordExperimentInterpretation(req.params.id, req.params.runId, bodyOf(req), { actor: actor(req, bodyOf(req)) }) })));
}
