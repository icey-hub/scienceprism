import { translationService, TranslationError } from '../services/translation/index.js';

// Authentication/project authorization comes from the same /api/projects/:id
// preHandler as the library. The service checks that the project still exists.
export function registerTranslationRoutes(app, { service = translationService } = {}) {
  const base = '/api/projects/:id';
  function fail(reply, error) {
    const known = error instanceof TranslationError;
    if (known && error.retryAfter) reply.header('Retry-After', String(error.retryAfter));
    return reply.code(known ? error.statusCode : 500).send({ ok: false, error: {
      code: known ? error.code : 'TRANSLATION_ERROR',
      message: known ? error.message : 'Translation is unavailable.',
      ...(known && error.retryAfter ? { retryAfter: error.retryAfter } : {})
    } });
  }
  app.get(`${base}/translation/providers`, async (req, reply) => {
    try { return { ok: true, ...await service.listProviders(req.params.id) }; }
    catch (error) { return fail(reply, error); }
  });
  app.get(`${base}/translation/settings`, async (req, reply) => {
    try { return { ok: true, ...await service.getSettings(req.params.id) }; }
    catch (error) { return fail(reply, error); }
  });
  app.patch(`${base}/translation/settings`, { bodyLimit: 8 * 1024 }, async (req, reply) => {
    try { return { ok: true, ...await service.updateSettings(req.params.id, req.body) }; }
    catch (error) { return fail(reply, error); }
  });
  app.get(`${base}/translation/usage`, async (req, reply) => {
    try { return { ok: true, ...await service.getUsage(req.params.id) }; }
    catch (error) { return fail(reply, error); }
  });
  app.delete(`${base}/translation/cache`, async (req, reply) => {
    try { return { ok: true, ...await service.clearCache(req.params.id) }; }
    catch (error) { return fail(reply, error); }
  });
  app.post(`${base}/translations`, { bodyLimit: 32 * 1024 }, async (req, reply) => {
    const controller = new AbortController();
    const disconnect = () => { if (!reply.raw.writableEnded) controller.abort(); };
    reply.raw.on('close', disconnect);
    try { return { ok: true, translation: await service.translate(req.params.id, req.body, { signal: controller.signal }) }; }
    catch (error) { if (controller.signal.aborted) return; return fail(reply, error); }
    finally { reply.raw.off('close', disconnect); }
  });
}
