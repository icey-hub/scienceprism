import { PaperAnnotationError, paperAnnotationService } from '../services/paperAnnotations.js';

export function registerPaperAnnotationRoutes(app, { service = paperAnnotationService } = {}) {
  const base = '/api/projects/:id/papers/:paperId/annotations';
  function route(operation) {
    return async (req, reply) => {
      try { return reply.send({ ok: true, ...await operation(req) }); }
      catch (error) {
        const known = error instanceof PaperAnnotationError || error?.code === 'ANNOTATION_CONFLICT';
        return reply.code(known ? error.statusCode : 500).send({ ok: false, error: {
          code: known ? error.code : 'ANNOTATION_ERROR',
          message: known ? error.message : 'Annotation operation failed.'
        } });
      }
    };
  }
  app.get(base, route(req => service.list(req.params.id, req.params.paperId)));
  app.post(base, route(req => service.create(req.params.id, req.params.paperId, req.body)));
  app.patch(`${base}/:annotationId`, route(req => service.update(req.params.id, req.params.paperId, req.params.annotationId, req.body)));
  app.delete(`${base}/:annotationId`, route(req => service.remove(req.params.id, req.params.paperId, req.params.annotationId, req.body)));
}
