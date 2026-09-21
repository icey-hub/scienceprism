import {
  getClaimEvidenceMatrix,
  getEvidence,
  getEvidenceGraph,
  getEvidenceImpact,
  getEvidenceLedger,
  listEvidence,
  linkEvidence,
  upsertEvidence,
  validateStageEvidence
} from '../services/evidenceLedger/index.js';
import { EvidenceLedgerError } from '../services/evidenceLedger/errors.js';

const BASE_PATH = '/api/projects/:id/evidence';

function bodyOf(req) {
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
}

function actorFromRequest(req, body = {}) {
  return body.actor || req.headers?.['x-scienceprism-actor'] || req.headers?.['x-openprism-actor'] || req.collabAuth?.sub || 'human';
}

function sendError(req, reply, error) {
  if (error instanceof EvidenceLedgerError) {
    return reply.code(error.statusCode).send({ ok: false, error: { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) } });
  }
  req.log?.error?.(error);
  return reply.code(500).send({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Internal server error.' } });
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

export function registerEvidenceLedgerRoutes(fastify) {
  fastify.get(BASE_PATH, valueRoute(async (req) => ({ ledger: await getEvidenceLedger(req.params.id) })));
  fastify.get(`${BASE_PATH}/entries`, valueRoute(async (req) => ({ entries: await listEvidence(req.params.id, req.query || {}) })));
  fastify.get(`${BASE_PATH}/graph`, valueRoute(async (req) => ({ graph: await getEvidenceGraph(req.params.id, req.query || {}) })));
  fastify.get(`${BASE_PATH}/impact/:evidenceId`, valueRoute(async (req) => ({ impact: await getEvidenceImpact(req.params.id, req.params.evidenceId) })));
  fastify.get(`${BASE_PATH}/claims/matrix`, valueRoute(async (req) => ({ matrix: await getClaimEvidenceMatrix(req.params.id) })));
  fastify.post(`${BASE_PATH}/claims/check`, valueRoute(async (req) => ({ result: await validateStageEvidence(req.params.id, bodyOf(req).stage || 'writing', bodyOf(req).output || bodyOf(req)) })));
  fastify.get(`${BASE_PATH}/:evidenceId`, valueRoute(async (req) => ({ entry: await getEvidence(req.params.id, req.params.evidenceId) })));

  fastify.post(BASE_PATH, valueRoute(async (req) => ({ result: await upsertEvidence(req.params.id, bodyOf(req), { actor: actorFromRequest(req, bodyOf(req)), expectedVersion: bodyOf(req).expectedVersion }) })));
  fastify.put(`${BASE_PATH}/:evidenceId`, valueRoute(async (req) => ({ result: await upsertEvidence(req.params.id, { ...bodyOf(req), id: req.params.evidenceId }, { actor: actorFromRequest(req, bodyOf(req)), expectedVersion: bodyOf(req).expectedVersion }) })));
  fastify.post(`${BASE_PATH}/relations`, valueRoute(async (req) => ({ result: await linkEvidence(req.params.id, bodyOf(req), { actor: actorFromRequest(req, bodyOf(req)), expectedVersion: bodyOf(req).expectedVersion }) })));
}
