import { getProjectFeatureFlags } from '../services/featureFlags.js';
import { getProjectObservability } from '../services/observability/index.js';

function sendError(req, reply, error) {
  if (error?.code === 'FEATURE_FLAG_DISABLED') {
    return reply.code(403).send({ ok: false, error: { code: error.code, message: error.message, details: error.details } });
  }
  req.log?.error?.(error);
  return reply.code(500).send({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Internal server error.' } });
}

export function registerObservabilityRoutes(fastify) {
  fastify.get('/api/projects/:id/observability', async (req, reply) => {
    try {
      return { ok: true, observability: await getProjectObservability(req.params.id, req.query || {}) };
    } catch (error) {
      return sendError(req, reply, error);
    }
  });

  fastify.get('/api/projects/:id/feature-flags', async (req, reply) => {
    try {
      return { ok: true, featureFlags: await getProjectFeatureFlags(req.params.id) };
    } catch (error) {
      return sendError(req, reply, error);
    }
  });
}
