import { createNativeFigure, createTableFigure, getFigureSource, listProjectFigures, reviseFigureArtifact } from '../services/figureArtifacts/index.js';
import { ResearchWorkflowError } from '../services/researchWorkflow/errors.js';
const base = '/api/projects/:id/figures';
function actor(req) {
  const value = req.headers?.['x-scienceprism-actor'] || req.headers?.['x-openprism-actor'];
  if (value !== 'human') throw new ResearchWorkflowError(403, 'HUMAN_INPUT_REQUIRED', '请由人工请求结构化图导出或样式版本。');
  return value;
}
function route(handler) {
  return async (req, reply) => {
    try { return { ok: true, ...await handler(req) }; }
    catch (error) {
      if (error instanceof ResearchWorkflowError) return reply.code(error.statusCode).send({ ok: false, error: { code: error.code, message: error.message } });
      req.log?.error?.(error); return reply.code(500).send({ ok: false, error: { code: 'INTERNAL_ERROR', message: '图产物服务暂不可用。' } });
    }
  };
}
export function registerFigureRoutes(fastify, { render, nativeRender } = {}) {
  fastify.get(base, route(async req => ({ figures: await listProjectFigures(req.params.id) })));
  fastify.post(`${base}/native`, route(async req => ({ figure: await createNativeFigure(req.params.id, req.body, { actor: actor(req), ...(nativeRender ? { nativeRender } : {}) }) })));
  fastify.post(`${base}/from-table`, route(async req => {
    const figure = await createTableFigure(req.params.id, req.body, { actor: actor(req), ...(render ? { render } : {}) });
    return { figure, assetPath: figure.files.png.path };
  }));
  fastify.post(`${base}/:figureId/revisions`, route(async req => ({ figure: await reviseFigureArtifact(req.params.id, req.params.figureId, req.body, { actor: actor(req), ...(render ? { render } : {}), ...(nativeRender ? { nativeRender } : {}) }) })));
  fastify.get(`${base}/:figureId/source`, route(async req => ({ source: await getFigureSource(req.params.id, req.params.figureId) })));
}
