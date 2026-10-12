import { loadPaperSearches, searchProjectPapers } from '../services/paperSearch.js';

export function registerPaperSearchRoutes(app, { search } = {}) {
  const base = '/api/projects/:id/paper-search';
  const fail = (reply, error) => reply.code(error.statusCode || (error.code === 'ENOENT' ? 404 : 500)).send({
    ok: false, error: { code: error.code || 'SEARCH_ERROR', message: error.statusCode ? error.message : '无法读取或检索此项目的论文。' }
  });
  app.get(base, async (req, reply) => {
    try { return { ok: true, ...await loadPaperSearches(req.params.id) }; }
    catch (error) { return fail(reply, error); }
  });
  app.post(base, async (req, reply) => {
    const abort = new AbortController();
    const disconnect = () => { if (!reply.raw.writableEnded) abort.abort(); };
    reply.raw.on('close', disconnect);
    try { return { ok: true, session: await searchProjectPapers(req.params.id, req.body, { search, signal: abort.signal }) }; }
    catch (error) { if (abort.signal.aborted) return; return fail(reply, error); }
    finally { reply.raw.off('close', disconnect); }
  });
}
