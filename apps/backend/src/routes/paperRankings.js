import { createPaperRankingsService } from '../services/paperRankings/index.js';
import { MAX_IMPORT_BYTES, PaperRankingError } from '../services/paperRankings/validation.js';

export function registerPaperRankingRoutes(app, { service = createPaperRankingsService() } = {}) {
  const base = '/api/projects/:id/paper-rankings';
  const fail = (reply, error) => reply.code(error.statusCode || 500).send({ ok: false,
    error: { code: error.code || 'RANKING_ERROR', message: error.statusCode ? error.message : '无法读取或修改此项目的分级目录。' } });
  app.get(base, async (req, reply) => {
    try { return { ok: true, ...await service.list(req.params.id) }; }
    catch (error) { return fail(reply, error); }
  });
  app.post(base, { bodyLimit: MAX_IMPORT_BYTES }, async (req, reply) => {
    try { const result = await service.importCatalog(req.params.id, req.body); return reply.code(result.duplicate ? 200 : 201).send({ ok: true, ...result }); }
    catch (error) { return fail(reply, error); }
  });
  app.get(`${base}/:catalogId`, async (req, reply) => {
    try {
      if (Object.keys(req.query).some(key => !['offset', 'limit'].includes(key))) throw new PaperRankingError('RANKING_INVALID_INPUT', '目录分页参数无效。');
      const pagination = {};
      for (const key of ['offset', 'limit']) if (req.query[key] !== undefined) {
        if (typeof req.query[key] !== 'string' || !/^\d{1,6}$/.test(req.query[key])) throw new PaperRankingError('RANKING_INVALID_INPUT', '目录分页参数无效。');
        pagination[key] = Number(req.query[key]);
      }
      return { ok: true, ...await service.get(req.params.id, req.params.catalogId, pagination) };
    } catch (error) { return fail(reply, error); }
  });
  app.post(`${base}/match`, { bodyLimit: 4 * 1024 * 1024 }, async (req, reply) => {
    try { return { ok: true, ...await service.match(req.params.id, req.body) }; }
    catch (error) { return fail(reply, error); }
  });
}
