import { ConstraintPolicyError, constraintPolicyProjection, readConstraintPolicy, setConstraintEnabled } from '../services/constraintRegistry/index.js';

const BASE = '/api/projects/:id/constraint-policy';

export function registerConstraintPolicyRoutes(fastify) {
  fastify.get(BASE, async (req) => ({ ok: true, policy: constraintPolicyProjection(await readConstraintPolicy(req.params.id)) }));
  fastify.post(`${BASE}/:constraintId/decision`, async (req, reply) => {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const actor = body.actor || req.headers['x-scienceprism-actor'] || req.collabAuth?.sub || null;
      const policy = await setConstraintEnabled(req.params.id, req.params.constraintId, body.enabled, { actor });
      return { ok: true, policy };
    } catch (error) {
      if (!(error instanceof ConstraintPolicyError)) throw error;
      return reply.code(error.statusCode).send({ ok: false, error: { code: error.code, message: error.message } });
    }
  });
}
