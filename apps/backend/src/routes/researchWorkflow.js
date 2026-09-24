import {
  getResearchAuditTimeline,
  getResearchStageDetails,
  getPendingResearchApprovals,
  getResearchWorkflow,
  ResearchWorkflowError,
  toFrontendWorkflow
} from '../services/researchWorkflow/index.js';
import {
  approveFromRequest,
  getSkillsProjection,
  initializeFromRequest,
  recoverFromRequest,
  resetFromRequest,
  runUiAction,
  updateFromRequest,
  updateSkillsFromRequest,
  uiStageId
} from '../services/researchWorkflow/application.js';

const BASE_PATH = '/api/projects/:id/research-workflow';

function bodyOf(req) {
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
}

const ACTOR_KINDS = new Set(['human', 'ai', 'system']);

/**
 * Returns the identified actor, or null when the request identifies nobody.
 *
 * It deliberately does NOT fall back to 'human'. That default meant an
 * unidentified caller — including an AI driving the API — was recorded in the
 * audit trail as a human decision nobody had actually made (C-04).
 */
function actorFromRequest(req, body = {}) {
  const raw = body.actor || req.headers?.['x-scienceprism-actor'] || req.headers?.['x-openprism-actor'] || req.collabAuth?.sub || null;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

/**
 * C-04: a decision that only a human may make has to say who acted. The kind is
 * validated so a caller cannot label an AI decision as human by typo.
 *
 * Exported because the constraint registry names it as C-04's enforcement seam.
 */
export function requireActor(actor) {
  if (actor === null) {
    throw new ResearchWorkflowError(400, 'ACTOR_REQUIRED', 'This decision must identify its actor: pass actor (human|ai|system) or the x-scienceprism-actor header.');
  }
  if (!ACTOR_KINDS.has(actor)) {
    throw new ResearchWorkflowError(400, 'INVALID_ACTOR', 'Actor must be one of: human, ai, system.', { actor });
  }
  return actor;
}

function sendError(req, reply, error) {
  if (error instanceof ResearchWorkflowError) {
    return reply.code(error.statusCode).send({ ok: false, workflow: null, error: { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) } });
  }
  req.log?.error?.(error);
  return reply.code(500).send({ ok: false, workflow: null, error: { code: 'INTERNAL_ERROR', message: 'Internal server error.' } });
}

function workflowRoute(handler, { statusCode } = {}) {
  return async (req, reply) => {
    try {
      const workflow = await handler(req);
      const resolvedStatusCode = typeof statusCode === 'function' ? statusCode(req) : statusCode;
      if (resolvedStatusCode) reply.code(resolvedStatusCode);
      return reply.send({ ok: true, workflow: toFrontendWorkflow(workflow) });
    } catch (error) {
      return sendError(req, reply, error);
    }
  };
}

function valueRoute(handler) {
  return async (req, reply) => {
    try {
      return reply.send({ ok: true, ...(await handler(req)) });
    } catch (error) {
      return sendError(req, reply, error);
    }
  };
}

export function registerResearchWorkflowRoutes(fastify) {
  fastify.get(BASE_PATH, workflowRoute((req) => getResearchWorkflow(req.params.id)));

  fastify.get(`${BASE_PATH}/stages/:stageId`, valueRoute(async (req) => ({ stage: await getResearchStageDetails(req.params.id, uiStageId(req.params.stageId)) })));
  fastify.get(`${BASE_PATH}/pending-approvals`, valueRoute(async (req) => ({ approvals: await getPendingResearchApprovals(req.params.id) })));
  fastify.get(`${BASE_PATH}/audit`, valueRoute(async (req) => ({ events: await getResearchAuditTimeline(req.params.id, { stageId: uiStageId(req.query?.stage), limit: req.query?.limit }) })));

  fastify.get(`${BASE_PATH}/skills`, valueRoute((req) => getSkillsProjection(req.params.id)));
  fastify.put(`${BASE_PATH}/skills/bindings`, valueRoute(async (req) => {
    const body = bodyOf(req);
    const result = await updateSkillsFromRequest(req.params.id, body, actorFromRequest(req, body));
    return { ...result, workflow: toFrontendWorkflow(result.workflow) };
  }));

  fastify.post(BASE_PATH, workflowRoute(async (req) => {
    const body = bodyOf(req);
    return body.action ? runUiAction(req.params.id, body, actorFromRequest(req, body)) : initializeFromRequest(req.params.id, body, actorFromRequest(req, body));
  }, { statusCode: (req) => (bodyOf(req).action ? undefined : 201) }));

  fastify.patch(BASE_PATH, workflowRoute((req) => {
    const body = bodyOf(req);
    return updateFromRequest(req.params.id, body, actorFromRequest(req, body));
  }));

  fastify.post(`${BASE_PATH}/approve`, workflowRoute((req) => {
    const body = bodyOf(req);
    return approveFromRequest(req.params.id, body, requireActor(actorFromRequest(req, body)));
  }));
  fastify.post(`${BASE_PATH}/reject`, workflowRoute((req) => {
    const body = { ...bodyOf(req), decision: 'reject' };
    return approveFromRequest(req.params.id, body, requireActor(actorFromRequest(req, body)));
  }));
  fastify.post(`${BASE_PATH}/skip`, workflowRoute((req) => {
    const body = { ...bodyOf(req), decision: 'skip' };
    return approveFromRequest(req.params.id, body, requireActor(actorFromRequest(req, body)));
  }));
  fastify.post(`${BASE_PATH}/recover`, workflowRoute((req) => {
    const body = bodyOf(req);
    return recoverFromRequest(req.params.id, body, requireActor(actorFromRequest(req, body)));
  }));
  fastify.post(`${BASE_PATH}/reset`, workflowRoute((req) => {
    const body = bodyOf(req);
    return resetFromRequest(req.params.id, body, requireActor(actorFromRequest(req, body)));
  }));

  fastify.put(`${BASE_PATH}/direction`, workflowRoute((req) => {
    const body = bodyOf(req);
    return updateFromRequest(req.params.id, { ...body, direction: { question: body.question || body.topic || '', keywords: Array.isArray(body.keywords) ? body.keywords : [], scope: body.scope || '', notes: body.notes || '' } }, actorFromRequest(req, body));
  }));
  fastify.post(`${BASE_PATH}/search`, workflowRoute((req) => runUiAction(req.params.id, { ...bodyOf(req), action: 'search' }, actorFromRequest(req, bodyOf(req)))));
  fastify.post(`${BASE_PATH}/papers/select`, workflowRoute((req) => runUiAction(req.params.id, { ...bodyOf(req), action: 'select-papers' }, actorFromRequest(req, bodyOf(req)))));
  fastify.post(`${BASE_PATH}/replication/skip`, workflowRoute((req) => {
    const body = { ...bodyOf(req), stage: 'replication', decision: 'skip' };
    return approveFromRequest(req.params.id, body, actorFromRequest(req, body));
  }));
  fastify.post(`${BASE_PATH}/ideas/generate`, workflowRoute((req) => runUiAction(req.params.id, { ...bodyOf(req), action: 'generate-ideas' }, actorFromRequest(req, bodyOf(req)))));
  fastify.post(`${BASE_PATH}/ideas/select`, workflowRoute((req) => runUiAction(req.params.id, { ...bodyOf(req), action: 'select-ideas' }, actorFromRequest(req, bodyOf(req)))));
  fastify.post(`${BASE_PATH}/method/generate`, workflowRoute((req) => runUiAction(req.params.id, { ...bodyOf(req), action: 'generate-method' }, actorFromRequest(req, bodyOf(req)))));
  fastify.post(`${BASE_PATH}/experiments/run`, workflowRoute((req) => runUiAction(req.params.id, { ...bodyOf(req), action: 'run-experiment' }, actorFromRequest(req, bodyOf(req)))));
  fastify.post(`${BASE_PATH}/writing/handoff`, workflowRoute((req) => runUiAction(req.params.id, { ...bodyOf(req), action: 'handoff-writing' }, actorFromRequest(req, bodyOf(req)))));
}
