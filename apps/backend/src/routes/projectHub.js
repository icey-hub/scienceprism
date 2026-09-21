import {
  checkPaperSource,
  deletePaper,
  getPaper,
  importPaper,
  listPapers,
  updatePaper
} from '../services/projectHub/paperLibrary.js';
import {
  cancelTask,
  getTask,
  listTasks,
  retryTask
} from '../services/projectHub/taskCenter.js';
import { getProjectDashboard, initializeProject } from '../services/projectHub/dashboard.js';
import { getWritingQuality, recordAiQualityCheck } from '../services/projectHub/writingQuality.js';

const BASE = '/api/projects/:id';

function bodyOf(req) {
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
}

function actor(req, body = {}) {
  return body.actor || req.headers?.['x-scienceprism-actor'] || req.collabAuth?.sub || 'human';
}

function sendError(req, reply, error) {
  const message = error instanceof Error ? error.message : String(error);
  const status = /not found/i.test(message) ? 404 : /required|must be|invalid|not retryable|no longer active/i.test(message) ? 400 : 500;
  req.log?.error?.(error);
  return reply.code(status).send({ ok: false, error: { code: status === 404 ? 'NOT_FOUND' : 'PROJECT_HUB_ERROR', message } });
}

function route(handler) {
  return async (req, reply) => {
    try { return reply.send({ ok: true, ...(await handler(req)) }); }
    catch (error) { return sendError(req, reply, error); }
  };
}

export function registerProjectHubRoutes(fastify) {
  fastify.get(`${BASE}/dashboard`, route(async (req) => ({ dashboard: await getProjectDashboard(req.params.id) })));
  fastify.post(`${BASE}/initialize`, route(async (req) => ({ result: await initializeProject(req.params.id, bodyOf(req), actor(req, bodyOf(req))) })));

  fastify.get(`${BASE}/papers`, route(async (req) => ({ papers: await listPapers(req.params.id, req.query || {}) })));
  fastify.get(`${BASE}/papers/:paperId`, route(async (req) => ({ paper: await getPaper(req.params.id, req.params.paperId) })));
  fastify.post(`${BASE}/papers`, route(async (req) => ({ result: await importPaper(req.params.id, bodyOf(req), { actor: actor(req, bodyOf(req)) }) })));
  fastify.patch(`${BASE}/papers/:paperId`, route(async (req) => ({ result: await updatePaper(req.params.id, req.params.paperId, bodyOf(req), { actor: actor(req, bodyOf(req)) }) })));
  fastify.post(`${BASE}/papers/:paperId/source-check`, route(async (req) => ({ result: await checkPaperSource(req.params.id, req.params.paperId) })));
  fastify.delete(`${BASE}/papers/:paperId`, route(async (req) => ({ result: await deletePaper(req.params.id, req.params.paperId) })));

  fastify.get(`${BASE}/tasks`, route(async (req) => ({ tasks: await listTasks(req.params.id, req.query || {}) })));
  fastify.get(`${BASE}/tasks/:taskId`, route(async (req) => ({ task: await getTask(req.params.id, req.params.taskId) })));
  fastify.post(`${BASE}/tasks/:taskId/retry`, route(async (req) => ({ result: await retryTask(req.params.id, req.params.taskId) })));
  fastify.post(`${BASE}/tasks/:taskId/cancel`, route(async (req) => ({ result: await cancelTask(req.params.id, req.params.taskId) })));

  fastify.get(`${BASE}/writing-quality`, route(async (req) => ({ quality: await getWritingQuality(req.params.id) })));
  fastify.post(`${BASE}/writing-quality/check`, route(async (req) => ({ check: await recordAiQualityCheck(req.params.id, bodyOf(req).result || bodyOf(req), actor(req, bodyOf(req))) })));
}

