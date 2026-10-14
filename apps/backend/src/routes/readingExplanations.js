import { readingExplanationService } from '../services/readingExplanations.js';

export function registerReadingExplanationRoutes(app, { service = readingExplanationService } = {}) {
  const base = '/api/projects/:id/papers/:paperId/explanations';
  const route = action => async (req, reply) => {
    try { return { ok: true, ...await action(req) }; }
    catch (error) {
      const status = Number.isInteger(error.statusCode) ? error.statusCode : 500;
      return reply.code(status).send({ ok: false, error: { code: error.code || 'READING_EXPLANATION_ERROR', message: status < 500 ? error.message : '阅读解释暂不可用，请检查原任务记录。' } });
    }
  };
  app.get(base, route(req => service.list(req.params.id, req.params.paperId)));
  app.post(base, { bodyLimit: 96 * 1024 }, route(req => service.explain(req.params.id, req.params.paperId, req.body)));
}
