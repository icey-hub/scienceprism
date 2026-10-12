import { createSkillInstallationService } from '../services/skillInstallation/index.js';

export function registerSkillInstallationRoutes(app, { service = createSkillInstallationService() } = {}) {
  const base = '/api/projects/:id/skill-installations';
  const fail = (reply, error) => reply.code(error.code === 'ENOENT' ? 404 : error.statusCode || 500).send({ ok: false,
    error: { code: error.code === 'ENOENT' ? 'PROJECT_NOT_FOUND' : error.code || 'SKILL_INSTALLATION_FAILED',
      message: error.statusCode ? error.message : 'Skill 安装或完整性检查失败；请重新读取安装列表。' } });
  app.get(base, async (req, reply) => {
    try { return { ok: true, ...await service.list(req.params.id) }; }
    catch (error) { return fail(reply, error); }
  });
  app.post(base, { bodyLimit: 4096 }, async (req, reply) => {
    const controller = new AbortController(); const abort = () => controller.abort();
    const close = () => { if (!reply.raw.writableEnded) abort(); };
    req.raw.once('aborted', abort); reply.raw.once('close', close);
    try {
      const result = await service.install(req.params.id, req.body, { signal: controller.signal });
      return reply.code(result.duplicate ? 200 : 201).send({ ok: true, ...result });
    } catch (error) { return fail(reply, error); }
    finally { req.raw.removeListener('aborted', abort); reply.raw.removeListener('close', close); }
  });
  for (const [suffix, method] of [['update-preview', 'previewUpdate'], ['update', 'update'], ['rollback', 'rollback'], ['uninstall', 'uninstall']]) {
    app.post(`${base}/:name/${suffix}`, { bodyLimit: 4096 }, async (req, reply) => {
      const controller = new AbortController(); const abort = () => controller.abort();
      const close = () => { if (!reply.raw.writableEnded) abort(); };
      req.raw.once('aborted', abort); reply.raw.once('close', close);
      try { return { ok: true, ...await service[method](req.params.id, req.params.name, req.body, { signal: controller.signal }) }; }
      catch (error) { return fail(reply, error); }
      finally { req.raw.removeListener('aborted', abort); reply.raw.removeListener('close', close); }
    });
  }
  app.get(`${base}/:name/versions`, async (req, reply) => {
    try { return { ok: true, ...await service.versions(req.params.id, req.params.name) }; }
    catch (error) { return fail(reply, error); }
  });
  app.get(`${base}/:name/versions/:versionId/document`, async (req, reply) => {
    try { return { ok: true, ...await service.document(req.params.id, req.params.name, req.params.versionId, req.query.file) }; }
    catch (error) { return fail(reply, error); }
  });
}
