import { randomUUID } from 'node:crypto';
import { getPaper, mutatePaperAnnotations, paperAnnotationsRevision } from './projectHub/paperLibrary.js';
import { createAttachmentRepository } from './paperAttachments/repository.js';

const MAX_ANNOTATIONS = 2000;
const annotationFields = new Set(['text', 'anchor', 'translation']);
const now = () => new Date().toISOString();

export class PaperAnnotationError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = 'PaperAnnotationError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function invalid(message) { throw new PaperAnnotationError('ANNOTATION_INVALID_INPUT', message); }
function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function text(value, name, max, { required = false } = {}) {
  if (typeof value !== 'string' || !value.isWellFormed() || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value) || [...value].length > max || (required && !value.trim())) {
    invalid(`${name} must be valid text of at most ${max} characters.`);
  }
  return value;
}
function expectedRevision(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new PaperAnnotationError('ANNOTATION_REVISION_REQUIRED', 'Reload annotations and send their expectedRevision before saving.', 428);
  }
  return value;
}

/** Rectangles use the unrotated PDF page, top-left origin and normalized units. */
function normalizeAnchor(value, attachments) {
  if (value === null || value === undefined) return null;
  if (!object(value) || typeof value.attachmentId !== 'string' || value.attachmentId.length > 200
      || typeof value.fileSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.fileSha256)
      || !Number.isInteger(value.page) || value.page < 1 || !Array.isArray(value.rects) || !value.rects.length || value.rects.length > 128) invalid('Choose a PDF attachment, page and one to 128 normalized rectangles.');
  const attachment = attachments.find(item => item.id === value.attachmentId);
  if (!attachment) throw new PaperAnnotationError('ANNOTATION_ATTACHMENT_NOT_FOUND', 'The selected PDF attachment is not in this paper.', 404);
  if (attachment.sha256 !== value.fileSha256) throw new PaperAnnotationError('ANNOTATION_VERSION_MISMATCH', 'The selected PDF version changed. Select the text again.', 409);
  if (value.page > attachment.pageCount) invalid('The annotation page is outside the PDF.');
  const rects = value.rects.map(rect => {
    if (!object(rect) || !['x', 'y', 'width', 'height'].every(key => typeof rect[key] === 'number' && Number.isFinite(rect[key]))
        || rect.x < 0 || rect.y < 0 || rect.x > 1 || rect.y > 1 || rect.width <= 0 || rect.height <= 0 || rect.width > 1 || rect.height > 1
        || rect.x + rect.width > 1 + 1e-6 || rect.y + rect.height > 1 + 1e-6) invalid('Annotation rectangles must stay inside the normalized PDF page.');
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
  return { attachmentId: value.attachmentId, fileSha256: value.fileSha256, page: value.page, rects,
    quote: value.quote === undefined ? '' : text(value.quote, 'quote', 10000) };
}

function normalizeTranslation(value, anchor) {
  if (value === null || value === undefined) return null;
  if (!object(value)) invalid('translation must be an object or null.');
  const providerId = text(value.providerId, 'translation.providerId', 80, { required: true });
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(providerId)) invalid('translation.providerId is invalid.');
  const translatedAt = text(value.translatedAt, 'translation.translatedAt', 40, { required: true });
  if (!/^\d{4}-\d{2}-\d{2}T/.test(translatedAt) || !Number.isFinite(Date.parse(translatedAt))) invalid('translation.translatedAt must be an ISO date.');
  const sourceText = text(value.sourceText, 'translation.sourceText', 10000, { required: true });
  if (anchor?.quote && sourceText !== anchor.quote) invalid('The translation source must match the selected quote.');
  const translation = { providerId, translatedAt, sourceText, translatedText: text(value.translatedText, 'translation.translatedText', 32000, { required: true }) };
  for (const key of ['sourceLanguage', 'targetLanguage']) if (value[key] !== undefined) translation[key] = text(value[key], `translation.${key}`, 32, { required: true });
  return translation;
}

function locationStatus(annotation, attachments) {
  if (!annotation.anchor) return 'unlocated';
  const attachment = attachments.find(item => item.id === annotation.anchor.attachmentId);
  if (!attachment) return 'attachment-missing';
  return attachment.sha256 === annotation.anchor.fileSha256 ? 'anchored' : 'version-mismatch';
}

export function createPaperAnnotationService({ lookupPaper = getPaper, mutateAnnotations = mutatePaperAnnotations,
  attachments = createAttachmentRepository() } = {}) {
  async function paperFor(projectId, paperId) {
    try { return await lookupPaper(projectId, paperId); }
    catch { throw new PaperAnnotationError('ANNOTATION_PAPER_NOT_FOUND', 'This paper was not found in the project.', 404); }
  }
  async function paperAttachments(projectId, paperId) {
    return (await attachments.read(projectId)).attachments.filter(item => item.paperId === paperId);
  }
  function result(paper, files, extra = {}) {
    const annotations = paper.annotations || [];
    return { ...extra, annotations: annotations.map(annotation => ({ ...annotation, anchor: annotation.anchor || null,
      locationStatus: locationStatus(annotation, files) })), revision: paperAnnotationsRevision(annotations) };
  }
  async function change(projectId, paperId, revision, operation) {
    expectedRevision(revision);
    await paperFor(projectId, paperId);
    let files;
    let changed;
    try {
      changed = await mutateAnnotations(projectId, paperId, revision, async current => {
        files = await paperAttachments(projectId, paperId);
        return operation(current, files);
      });
    } catch (error) {
      if (error?.statusCode === 404 && !(error instanceof PaperAnnotationError)) throw new PaperAnnotationError('ANNOTATION_PAPER_NOT_FOUND', 'This paper was not found in the project.', 404);
      throw error;
    }
    return result(changed.paper, files, { libraryVersion: changed.libraryVersion });
  }
  function prepare(input, files, previous) {
    if (!object(input) || Object.keys(input).some(key => !annotationFields.has(key))) invalid('Annotation fields are text, anchor and translation.');
    if (previous && Object.keys(input).length === 0) invalid('Choose at least one annotation field to update.');
    const anchor = normalizeAnchor(input.anchor === undefined ? previous?.anchor : input.anchor, files);
    const note = text(input.text === undefined ? previous?.text ?? '' : input.text, 'text', 10000);
    if (!anchor && !note.trim()) invalid('A note needs text or a PDF selection.');
    const translation = normalizeTranslation(input.translation === undefined ? previous?.translation : input.translation, anchor);
    const stamp = now();
    return { ...previous, id: previous?.id || `annotation-${randomUUID()}`, text: note, anchor, translation,
      quote: anchor?.quote ?? previous?.quote ?? '', page: anchor?.page ?? previous?.page ?? null,
      createdAt: previous?.createdAt || stamp, updatedAt: stamp };
  }
  return {
    async list(projectId, paperId) {
      const paper = await paperFor(projectId, paperId);
      return result(paper, await paperAttachments(projectId, paperId));
    },
    async create(projectId, paperId, body) {
      if (!object(body)) invalid('Annotation request must be an object.');
      return change(projectId, paperId, body.expectedRevision, (current, files) => {
        if (current.length >= MAX_ANNOTATIONS) throw new PaperAnnotationError('ANNOTATION_LIMIT', 'This paper has reached the annotation limit.', 409);
        return [...current, prepare(body.annotation, files)];
      });
    },
    async update(projectId, paperId, annotationId, body) {
      if (!object(body)) invalid('Annotation request must be an object.');
      return change(projectId, paperId, body.expectedRevision, (current, files) => {
        const index = current.findIndex(item => item.id === annotationId);
        if (index < 0) throw new PaperAnnotationError('ANNOTATION_NOT_FOUND', 'Annotation not found in this paper.', 404);
        return current.map((item, position) => position === index ? prepare(body.patch, files, item) : item);
      });
    },
    async remove(projectId, paperId, annotationId, body) {
      if (!object(body)) invalid('Annotation request must be an object.');
      return change(projectId, paperId, body.expectedRevision, current => {
        if (!current.some(item => item.id === annotationId)) throw new PaperAnnotationError('ANNOTATION_NOT_FOUND', 'Annotation not found in this paper.', 404);
        return current.filter(item => item.id !== annotationId);
      });
    }
  };
}

export const paperAnnotationService = createPaperAnnotationService();
