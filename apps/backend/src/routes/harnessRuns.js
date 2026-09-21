import {
  cancelHarnessRun,
  createHarnessRun,
  decideHarnessRun,
  getHarnessRun,
  listHarnessRuns,
  pauseHarnessRun,
  replayHarnessRun,
  resumeHarnessRun,
  startHarnessRun
} from '../services/harnessRuntime/index.js';
import { HarnessRuntimeError } from '../services/harnessRuntime/errors.js';

const BASE_PATH = '/api/projects/:id/harness-runs';

function bodyOf(req) {
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
}

function sendError(req, reply, error) {
  if (error instanceof HarnessRuntimeError) {
    return reply.code(error.statusCode).send({
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details })
      }
    });
  }
  req.log?.error?.(error);
  return reply.code(500).send({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Internal server error.' } });
}

function route(handler) {
  return async (req, reply) => {
    try {
      const run = await handler(req);
      return reply.send({ ok: true, run });
    } catch (error) {
      return sendError(req, reply, error);
    }
  };
}

export function registerHarnessRunRoutes(fastify) {
  fastify.get(BASE_PATH, route((req) => listHarnessRuns(req.params.id, req.query || {})));
  fastify.get(`${BASE_PATH}/:runId`, route((req) => getHarnessRun(req.params.id, req.params.runId)));

  fastify.post(BASE_PATH, route(async (req, reply) => {
    const body = bodyOf(req);
    const { start, ...request } = body;
    const run = await createHarnessRun(req.params.id, request);
    if (!start) {
      reply.code(201);
      return run;
    }
    return startHarnessRun(req.params.id, run.id, { wait: false });
  }));

  fastify.post(`${BASE_PATH}/:runId/start`, route((req) => startHarnessRun(req.params.id, req.params.runId, { wait: false, request: bodyOf(req) })));
  fastify.post(`${BASE_PATH}/:runId/resume`, route((req) => resumeHarnessRun(req.params.id, req.params.runId, { wait: false, request: bodyOf(req) })));
  fastify.post(`${BASE_PATH}/:runId/pause`, route((req) => pauseHarnessRun(req.params.id, req.params.runId)));
  fastify.post(`${BASE_PATH}/:runId/cancel`, route((req) => cancelHarnessRun(req.params.id, req.params.runId)));
  fastify.post(`${BASE_PATH}/:runId/replay`, route((req) => {
    const body = bodyOf(req);
    return replayHarnessRun(req.params.id, req.params.runId, { request: body.request || body, start: body.start !== false });
  }));
  fastify.post(`${BASE_PATH}/:runId/decision`, route((req) => {
    const body = bodyOf(req);
    return decideHarnessRun(req.params.id, req.params.runId, {
      decision: body.decision,
      actor: body.actor || req.headers?.['x-scienceprism-actor'] || 'human',
      note: body.note
    });
  }));
}
