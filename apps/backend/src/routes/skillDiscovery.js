import { createSkillDiscoveryService } from '../services/skillDiscovery/index.js';

export function registerSkillDiscoveryRoutes(app, { service = createSkillDiscoveryService() } = {}) {
  const base = '/api/projects/:id/skill-discovery';
  const fail = (reply, error) => reply.code(error.code === 'ENOENT' ? 404 : error.statusCode || 500).send({ ok: false,
    error: { code: error.code === 'ENOENT' ? 'PROJECT_NOT_FOUND' : error.code || 'SKILL_DISCOVERY_FAILED',
      message: error.statusCode ? error.message : '无法读取此项目的 Skill 候选目录。' } });
  app.get(`${base}/catalogs`, async (req, reply) => {
    try { return { ok: true, ...await service.catalogs(req.params.id) }; }
    catch (error) { return fail(reply, error); }
  });
  app.post(base, { bodyLimit: 8192 }, async (req, reply) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    const close = () => { if (!reply.raw.writableEnded) abort(); };
    req.raw.once('aborted', abort); reply.raw.once('close', close);
    try { return { ok: true, ...await service.discover(req.params.id, req.body ?? {}, { signal: controller.signal }) }; }
    catch (error) { return fail(reply, error); }
    finally { req.raw.removeListener('aborted', abort); reply.raw.removeListener('close', close); }
  });
}
