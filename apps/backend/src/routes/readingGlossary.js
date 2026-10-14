import { ReadingGlossaryError, readingGlossaryService } from '../services/translation/glossary.js';
import { AttachmentError } from '../services/paperAttachments/download.js';
export function registerReadingGlossaryRoutes(app, { service = readingGlossaryService } = {}) {
  const base = '/api/projects/:id/reading-glossary';
  function actor(req) {
    if ((req.headers['x-scienceprism-actor'] || req.headers['x-openprism-actor']) !== 'human') throw new ReadingGlossaryError('GLOSSARY_HUMAN_INPUT_REQUIRED', '请由人工保存术语收藏。', 403);
    return { actor: 'human' };
  }
  function route(operation) {
    return async (req, reply) => {
      try { return { ok: true, ...await operation(req) }; }
      catch (error) {
        const known = error instanceof ReadingGlossaryError || error instanceof AttachmentError;
        if (!known) req.log?.error?.(error);
        return reply.code(known ? error.statusCode : 500).send({ ok: false, error: { code: known ? error.code : 'GLOSSARY_ERROR', message: known ? error.message : '术语操作失败；已有收藏未被覆盖。' } });
      }
    };
  }
  app.get(base, route(req => service.list(req.params.id)));
  app.post(base, { bodyLimit: 32 * 1024 }, route(req => service.create(req.params.id, req.body, actor(req))));
  app.patch(`${base}/:entryId`, { bodyLimit: 32 * 1024 }, route(req => service.update(req.params.id, req.params.entryId, req.body, actor(req))));
  app.delete(`${base}/:entryId`, { bodyLimit: 1024 }, route(req => service.remove(req.params.id, req.params.entryId, req.body, actor(req))));
}
