import { ConstraintProposalError, decideConstraintProposal, listConstraintProposals } from '../services/constraintRegistry/proposals.js';

const BASE = '/api/projects/:id/constraint-proposals';

export function registerConstraintProposalRoutes(fastify) {
  fastify.get(BASE, async (req) => ({ ok: true, proposals: await listConstraintProposals(req.params.id) }));
  fastify.post(`${BASE}/:proposalId/decision`, async (req, reply) => {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const actor = body.actor || req.headers['x-scienceprism-actor'] || req.collabAuth?.sub || null;
      const proposal = await decideConstraintProposal(req.params.id, req.params.proposalId, { decision: body.decision, actor, enabled: body.enabled });
      return { ok: true, proposal };
    } catch (error) {
      if (!(error instanceof ConstraintProposalError)) throw error;
      return reply.code(error.statusCode).send({ ok: false, error: { code: error.code, message: error.message } });
    }
  });
}
