import { codePreparationService } from '../services/experimentRunner/codePreparations.js';
import { ExperimentRunnerError } from '../services/experimentRunner/errors.js';

export function registerCodePreparationRoutes(app, { service = codePreparationService } = {}) {
  const base = '/api/projects/:id/code-preparations';
  const route = handler => async (request, reply) => {
    try { return { ok: true, ...await handler(request) }; }
    catch (error) { return reply.code(error instanceof ExperimentRunnerError ? error.statusCode : 500).send({ ok: false,
      error: { code: error instanceof ExperimentRunnerError ? error.code : 'CODE_PREPARATION_REQUEST_FAILED',
        message: error instanceof ExperimentRunnerError ? error.message : '代码准备请求失败。' } }); }
  };
  app.get(base, route(request => service.list(request.params.id)));
  app.post(base, route(request => service.create(request.params.id, request.body)));
  app.get(`${base}/:codeId`, route(async request => ({ preparation: await service.get(request.params.id, request.params.codeId) })));
}
