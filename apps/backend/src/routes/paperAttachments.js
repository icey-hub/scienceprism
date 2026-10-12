import { AttachmentError, MAX_PDF_BYTES, paperAttachmentService } from '../services/paperAttachments/index.js';

export function registerPaperAttachmentRoutes(app, { service = paperAttachmentService } = {}) {
  const base = '/api/projects/:id/papers/:paperId/attachments';
  const fail = (reply, error) => reply.code(error instanceof AttachmentError ? error.statusCode : error?.statusCode === 413 ? 413 : 500).send({ ok: false, error: {
    code: error instanceof AttachmentError ? error.code : error?.statusCode === 413 ? 'ATTACHMENT_TOO_LARGE' : 'ATTACHMENT_ERROR',
    message: error instanceof AttachmentError ? error.message : error?.statusCode === 413 ? 'The PDF exceeds the 32 MiB limit.' : 'PDF attachment operation failed.'
  } });
  const ids = req => [req.params.id, req.params.paperId];
  app.get(base, async (req, reply) => {
    try { return { ok: true, ...await service.list(...ids(req)) }; } catch (error) { return fail(reply, error); }
  });
  app.post(base, async (req, reply) => {
    try {
      const part = await req.file({ limits: { files: 1, fileSize: MAX_PDF_BYTES, fields: 0 } });
      if (!part) throw new AttachmentError('ATTACHMENT_FILE_REQUIRED', 'Choose a PDF file to import.');
      const bytes = await part.toBuffer();
      if (part.file.truncated) throw new AttachmentError('ATTACHMENT_TOO_LARGE', 'The PDF exceeds the 32 MiB limit.', 413);
      return { ok: true, ...await service.importPdf(...ids(req), { filename: part.filename, bytes }) };
    } catch (error) { return fail(reply, error); }
  });
  app.post(`${base}/download`, async (req, reply) => {
    try {
      const result = await service.startDownload(...ids(req), req.body ?? {});
      return reply.code(result.cached ? 200 : 202).send({ ok: true, ...result });
    } catch (error) { return fail(reply, error); }
  });
  app.get(`${base}/jobs/:jobId`, async (req, reply) => {
    try { return { ok: true, job: await service.getJob(...ids(req), req.params.jobId) }; } catch (error) { return fail(reply, error); }
  });
  app.post(`${base}/jobs/:jobId/cancel`, async (req, reply) => {
    try { return { ok: true, job: await service.cancelDownload(...ids(req), req.params.jobId) }; } catch (error) { return fail(reply, error); }
  });
  app.get(`${base}/:attachmentId/content`, async (req, reply) => {
    try {
      const { attachment, bytes } = await service.content(...ids(req), req.params.attachmentId);
      reply.header('Content-Type', 'application/pdf').header('Accept-Ranges', 'bytes').header('Cache-Control', 'private, no-cache')
        .header('X-Content-Type-Options', 'nosniff').header('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`)
        .header('ETag', `"${attachment.sha256}"`);
      if (req.headers.range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
        let start, end;
        if (match && (match[1] || match[2])) {
          start = match[1] ? Number(match[1]) : Math.max(0, bytes.length - Number(match[2]));
          end = match[1] ? (match[2] ? Math.min(Number(match[2]), bytes.length - 1) : bytes.length - 1) : bytes.length - 1;
        }
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= bytes.length) return reply.code(416).header('Content-Range', `bytes */${bytes.length}`).send();
        return reply.code(206).header('Content-Range', `bytes ${start}-${end}/${bytes.length}`).send(bytes.subarray(start, end + 1));
      }
      return reply.send(bytes);
    } catch (error) { return fail(reply, error); }
  });
}
