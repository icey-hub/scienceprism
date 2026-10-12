import { randomUUID } from 'node:crypto';
import { getPaper } from '../projectHub/paperLibrary.js';
import { parseArxiv } from '../researchSources/arxivLookup.js';
import { AttachmentError, createPdfDownloader, parseDownloadUrl, SUPPORTED_PDF_HOSTS, MAX_PDF_BYTES } from './download.js';
import { createAttachmentRepository, attachmentFilename } from './repository.js';

export { AttachmentError, MAX_PDF_BYTES } from './download.js';

const terminal = job => ['completed', 'failed', 'cancelled'].includes(job.status);
const at = () => new Date().toISOString();

function sourceUrl(paper, input) {
  if (input?.url !== undefined) return parseDownloadUrl(input.url).toString();
  let oaError;
  if (paper.oaPdfUrl) {
    try { return parseDownloadUrl(paper.oaPdfUrl).toString(); } catch (error) { oaError = error; }
  }
  for (const value of [paper.url, paper.arxivId]) {
    try { return `https://arxiv.org/pdf/${parseArxiv(value).identifier}`; } catch { /* Try the next explicit identifier. */ }
  }
  if (oaError) throw oaError;
  throw new AttachmentError('ATTACHMENT_SOURCE_REQUIRED', 'Choose a supported open-access PDF URL or import a local file.', 422);
}

/** One owner for immutable PDF attachments and their cancellable acquisition jobs. */
export function createPaperAttachmentService({ repository = createAttachmentRepository(), lookupPaper = getPaper, download = createPdfDownloader(), now = Date.now } = {}) {
  const active = new Map();
  const activeKey = (projectId, jobId) => `${projectId}:${jobId}`;
  async function paperFor(projectId, paperId) {
    if (typeof paperId !== 'string' || !paperId || paperId.length > 200 || /[\\/\x00-\x1f]/.test(paperId)) throw new AttachmentError('ATTACHMENT_INVALID_PAPER', 'Choose a valid paper.', 400);
    try { return await lookupPaper(projectId, paperId); }
    catch { throw new AttachmentError('ATTACHMENT_PAPER_NOT_FOUND', 'This paper was not found in the project.', 404); }
  }
  function viewJob(projectId, job) {
    if (!terminal(job) && !active.has(activeKey(projectId, job.id))) {
      return { ...job, status: 'failed', interrupted: true, error: { code: 'ATTACHMENT_INTERRUPTED', message: 'The download process stopped. Start a new download to retry.' } };
    }
    return structuredClone(job);
  }
  async function updateJob(projectId, jobId, patch) {
    return repository.update(projectId, index => {
      const job = index.jobs.find(item => item.id === jobId);
      if (!job) throw new AttachmentError('ATTACHMENT_JOB_NOT_FOUND', 'Download job not found.', 404);
      Object.assign(job, patch, { updatedAt: at() });
      return job;
    });
  }
  async function savedJob(projectId, paperId, jobId) {
    const job = (await repository.read(projectId)).jobs.find(item => item.paperId === paperId && item.id === jobId);
    if (!job) throw new AttachmentError('ATTACHMENT_JOB_NOT_FOUND', 'Download job not found in this paper.', 404);
    return job;
  }
  async function execute(projectId, paperId, job, entry) {
    let lastProgress = 0;
    try {
      entry.controller.signal.throwIfAborted();
      await updateJob(projectId, job.id, { status: 'running', startedAt: at() });
      const result = await download(job.sourceUrl, { signal: entry.controller.signal, onProgress: async progress => {
        if (now() - lastProgress < 250 && progress.received !== progress.total) return;
        lastProgress = now();
        await updateJob(projectId, job.id, { receivedBytes: progress.received, totalBytes: progress.total });
      } });
      entry.controller.signal.throwIfAborted();
      // Recheck a deleted paper before publishing a file. Once atomic publication
      // begins, cancellation waits and returns the truthful completed state.
      await paperFor(projectId, paperId);
      entry.controller.signal.throwIfAborted();
      entry.phase = 'committing';
      const stored = await repository.store(projectId, paperId, result.bytes, { filename: job.filename, sourceUrl: job.sourceUrl, resolvedUrl: result.resolvedUrl });
      return await updateJob(projectId, job.id, { status: 'completed', attachmentId: stored.attachment.id, duplicate: stored.duplicate,
        receivedBytes: stored.attachment.byteLength, totalBytes: stored.attachment.byteLength, finishedAt: at(), error: null });
    } catch (cause) {
      const cancelled = entry.controller.signal.aborted;
      const error = cancelled ? { code: 'ATTACHMENT_CANCELLED', message: 'PDF download cancelled.' }
        : cause instanceof AttachmentError ? { code: cause.code, message: cause.message }
          : { code: 'ATTACHMENT_DOWNLOAD_FAILED', message: 'PDF acquisition failed. Retry or import a local PDF.' };
      return await updateJob(projectId, job.id, { status: cancelled ? 'cancelled' : 'failed', error, finishedAt: at() });
    }
  }

  return {
    async listJobs(projectId) {
      return (await repository.read(projectId)).jobs.map(job => viewJob(projectId, job));
    },
    async list(projectId, paperId) {
      await paperFor(projectId, paperId);
      const index = await repository.read(projectId);
      return { attachments: index.attachments.filter(item => item.paperId === paperId),
        jobs: index.jobs.filter(item => item.paperId === paperId).map(job => viewJob(projectId, job)),
        supportedDownloadHosts: [...SUPPORTED_PDF_HOSTS], maxPdfBytes: MAX_PDF_BYTES };
    },
    async importPdf(projectId, paperId, { filename, bytes }) {
      await paperFor(projectId, paperId);
      return repository.store(projectId, paperId, bytes, { filename: attachmentFilename(filename) });
    },
    async startDownload(projectId, paperId, body = {}) {
      const paper = await paperFor(projectId, paperId);
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AttachmentError('ATTACHMENT_INVALID_INPUT', 'A download request must be an object.');
      if (body.refresh !== undefined && typeof body.refresh !== 'boolean') throw new AttachmentError('ATTACHMENT_INVALID_INPUT', 'refresh must be a boolean.');
      const url = sourceUrl(paper, body);
      const filename = attachmentFilename(body.filename ?? 'paper.pdf');
      const entry = { controller: new AbortController(), promise: null, finish: null, phase: 'downloading' };
      entry.promise = new Promise(resolve => { entry.finish = resolve; });
      const result = await repository.update(projectId, index => {
        const previous = index.jobs.find(item => item.paperId === paperId && item.sourceUrl === url && active.has(activeKey(projectId, item.id)));
        if (previous) return { job: previous, existing: true };
        if ([...active.keys()].filter(key => key.startsWith(`${projectId}:`)).length >= 2) throw new AttachmentError('ATTACHMENT_DOWNLOAD_BUSY', 'This project already has two active downloads.', 429);
        const cached = !body.refresh && index.attachments.find(item => item.paperId === paperId && (item.sourceUrl === url || item.sourceUrls?.includes(url)));
        if (cached) return { attachment: cached, cached: true };
        const last = [...index.jobs].reverse().find(item => item.paperId === paperId && item.sourceUrl === url);
        const job = { id: `pdf-download-${randomUUID()}`, paperId, sourceUrl: url, filename, status: 'queued', receivedBytes: 0, totalBytes: null,
          attachmentId: null, retryOf: last?.id || null, createdAt: at(), updatedAt: at(), startedAt: null, finishedAt: null, error: null };
        index.jobs = index.jobs.filter(item => !terminal(item) || index.jobs.indexOf(item) >= index.jobs.length - 199);
        if (index.jobs.length >= 500) throw new AttachmentError('ATTACHMENT_JOB_LIMIT', 'Too many retained download jobs. Review existing jobs before starting more.', 409);
        index.jobs.push(job);
        active.set(activeKey(projectId, job.id), entry);
        return { job, existing: false };
      }).catch(error => {
        for (const [key, value] of active) if (value === entry) active.delete(key);
        entry.finish();
        throw error;
      });
      if (result.cached) {
        await repository.content(projectId, paperId, result.attachment.id);
        return result;
      }
      if (!result.existing) {
        execute(projectId, paperId, result.job, entry).catch(() => {
          // A storage failure leaves an interrupted persisted job. Do not emit an
          // unhandled rejection or falsely claim a successful download.
        }).finally(() => { active.delete(activeKey(projectId, result.job.id)); entry.finish(); });
      }
      return result;
    },
    async getJob(projectId, paperId, jobId) {
      await paperFor(projectId, paperId);
      return viewJob(projectId, await savedJob(projectId, paperId, jobId));
    },
    async cancelDownload(projectId, paperId, jobId) {
      await paperFor(projectId, paperId);
      const job = await savedJob(projectId, paperId, jobId);
      if (job.status === 'cancelled') return job;
      const entry = active.get(activeKey(projectId, jobId));
      if (!entry) throw new AttachmentError('ATTACHMENT_JOB_NOT_ACTIVE', 'This download is no longer active. A failed download can be retried.', 409);
      if (entry.phase !== 'committing') entry.controller.abort();
      await entry.promise;
      return viewJob(projectId, await savedJob(projectId, paperId, jobId));
    },
    async content(projectId, paperId, attachmentId) {
      await paperFor(projectId, paperId);
      return repository.content(projectId, paperId, attachmentId);
    }
  };
}

export const paperAttachmentService = createPaperAttachmentService();
