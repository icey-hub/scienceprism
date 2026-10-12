import { createHash, randomUUID } from 'node:crypto';
import { normalizePaper, paperKey, sourceCheckFor } from './paperNormalization.js';
import { getEvidence, upsertEvidence } from '../evidenceLedger/index.js';
import { createTask } from './taskCenter.js';
import { clone, readHubJson, withHubLock, writeHubJson } from './repository.js';
import { findMatchingPapers, mergeSourceRecords } from '../researchSources/candidateIdentity.js';

const FILE = 'paper-library.json';
const MAX_PAPERS = 5_000;

function now() {
  return new Date().toISOString();
}

function emptyLibrary(projectId) {
  return { schemaVersion: 1, projectId, version: 1, papers: [], updatedAt: now() };
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

async function readLibrary(projectId) {
  return readHubJson(projectId, FILE, () => emptyLibrary(projectId));
}

export async function listPapers(projectId, { query, tag, readingStatus, favorite, limit = 500 } = {}) {
  const library = await readLibrary(projectId);
  const normalizedQuery = text(query).toLowerCase();
  const papers = library.papers.filter((paper) => {
    if (tag && !paper.tags.includes(tag)) return false;
    if (readingStatus && paper.readingStatus !== readingStatus) return false;
    if (favorite !== undefined && Boolean(favorite) !== Boolean(paper.favorite)) return false;
    if (normalizedQuery && !`${paper.title} ${paper.authors.join(' ')} ${paper.abstract} ${paper.notes}`.toLowerCase().includes(normalizedQuery)) return false;
    return true;
  });
  return clone(papers.slice(0, Math.min(MAX_PAPERS, Math.max(1, Number(limit) || 500))));
}

export async function getPaper(projectId, paperId) {
  const paper = (await readLibrary(projectId)).papers.find((item) => item.id === paperId);
  if (!paper) throw new Error('Paper not found.');
  return clone(paper);
}

async function ensurePaperEvidence(projectId, paper, actor) {
  if (paper.evidenceId) {
    try {
      await getEvidence(projectId, paper.evidenceId);
      return paper.evidenceId;
    } catch {
      // Recreate a missing project-local Evidence record below.
    }
  }
  const result = await upsertEvidence(projectId, {
    id: paper.evidenceId || `paper:${paper.id}`,
    kind: 'paper',
    title: paper.title,
    summary: paper.abstract,
    source: paper.source,
    sourceUrl: paper.url,
    verificationStatus: paper.sourceCheck?.status === 'checked' ? 'pending' : 'pending',
    version: paper.arxivId || paper.doi || paper.updatedAt,
    metadata: { paperId: paper.id, authors: paper.authors, venue: paper.venue, year: paper.year }
  }, { actor });
  return result.entry.id;
}

export function paperRevision(paper) {
  return paper ? createHash('sha256').update(JSON.stringify(paper)).digest('hex') : null;
}

export function paperAnnotationsRevision(annotations) {
  return createHash('sha256').update(JSON.stringify(annotations || [])).digest('hex');
}

function assertAnnotationsRevision(annotations, expectedRevision) {
  if (expectedRevision !== paperAnnotationsRevision(annotations)) {
    const error = new Error('批注已经变化，请刷新后重试；你的笔记尚未被覆盖。');
    error.code = 'ANNOTATION_CONFLICT';
    error.statusCode = 409;
    throw error;
  }
}

export async function mutatePaperAnnotations(projectId, paperId, expectedRevision, change) {
  return withHubLock(projectId, async () => {
    const library = await readLibrary(projectId);
    const paper = library.papers.find(item => item.id === paperId);
    if (!paper) { const error = new Error('Paper not found.'); error.statusCode = 404; throw error; }
    assertAnnotationsRevision(paper.annotations, expectedRevision);
    paper.annotations = await change(clone(paper.annotations || []));
    paper.updatedAt = now();
    library.version += 1;
    library.updatedAt = now();
    await writeHubJson(projectId, FILE, library);
    return { paper: clone(paper), libraryVersion: library.version };
  });
}

export class PaperImportConflictError extends Error {
  constructor() {
    super('The library record changed after preview. Preview again before importing.');
    this.code = 'IMPORT_PREVIEW_STALE';
    this.statusCode = 409;
  }
}

export class PaperIdentityConflictError extends PaperImportConflictError {
  constructor() {
    super();
    this.message = 'The incoming identifiers match multiple library records. Review those records before importing.';
    this.code = 'PAPER_IDENTITY_AMBIGUOUS';
  }
}

export async function importPaper(projectId, input, { actor = 'human', confirmation } = {}) {
  if (!input || typeof input !== 'object') throw new Error('Paper must be an object.');
  const result = await withHubLock(projectId, async () => {
    const library = await readLibrary(projectId);
    const candidate = normalizePaper(input, {});
    if (confirmation?.sourceIdentity) {
      const { field, value } = confirmation.sourceIdentity;
      const identityKey = paperKey({ [field]: value });
      const matches = library.papers.filter((paper) => paper[field] && paperKey({ [field]: paper[field] }) === identityKey);
      const expected = confirmation.sourceMatches;
      if (matches.length !== expected.length || matches.some((paper) => !expected.some((match) => match.paperId === paper.id && match.revision === paperRevision(paper)))) throw new PaperImportConflictError();
    }
    const matches = findMatchingPapers(library.papers, candidate);
    if (!confirmation?.paperId && matches.length > 1) throw new PaperIdentityConflictError();
    const existingIndex = library.papers.findIndex(paper => paper.id === (confirmation?.paperId || matches[0]?.id));
    const existing = existingIndex >= 0 ? library.papers[existingIndex] : undefined;
    let selectedInput = input;
    if (confirmation) {
      if (paperRevision(existing) !== confirmation.expectedRevision) throw new PaperImportConflictError();
      if (confirmation.action === 'keep') return { paper: clone(existing), duplicate: Boolean(existing), libraryVersion: library.version, skipped: true };
      if ((confirmation.action === 'create') === Boolean(existing)) throw new PaperImportConflictError();
      if (existing) {
        selectedInput = Object.fromEntries(confirmation.fields.map((field) => [field, input[field]]));
        selectedInput.sourceRecords = input.sourceRecords;
      }
    }
    // Acquiring metadata cannot erase human reading work. Explicit preview
    // decisions can replace selected bibliographic fields, including BibTeX.
    if (existing && !confirmation) {
      if (Array.isArray(selectedInput.annotations) && paperAnnotationsRevision(selectedInput.annotations) !== paperAnnotationsRevision(existing.annotations)) {
        assertAnnotationsRevision(existing.annotations, selectedInput.expectedAnnotationsRevision);
      }
      selectedInput = { ...selectedInput };
      for (const field of ['notes', 'annotations', 'bibtex', 'citationKey', 'tags', 'favorite', 'readingStatus', 'expectedAnnotationsRevision']) delete selectedInput[field];
    }
    const paper = normalizePaper(existing ? selectedInput : { ...candidate, ...selectedInput }, { existing });
    if (!existing && library.papers.some(item => item.id === paper.id)) paper.id = `paper-${randomUUID()}`;
    paper.sourceRecords = mergeSourceRecords(existing?.sourceRecords || [], candidate.sourceRecords || [], input.sourceRecords || []);
    paper.searchSessionIds = [...new Set([...(existing?.searchSessionIds || []), ...(Array.isArray(input.searchSessionIds) ? input.searchSessionIds.filter(value => typeof value === 'string') : []), ...paper.sourceRecords.map(record => record.searchSessionId).filter(Boolean)])];
    // Provider review receipts can only enter through server-owned confirmation.
    // Raw imports and ordinary edits retain existing receipts, never mint them.
    if (existing?.sourceReviews) paper.sourceReviews = clone(existing.sourceReviews);
    else delete paper.sourceReviews;
    if (confirmation?.sourceReview) paper.sourceReviews = [...(paper.sourceReviews || []), clone(confirmation.sourceReview)];
    if (confirmation && findMatchingPapers(library.papers.filter(item => item.id !== paper.id), paper).length) throw new PaperImportConflictError();
    paper.evidenceId = await ensurePaperEvidence(projectId, paper, actor);
    if (existingIndex >= 0) {
      library.papers[existingIndex] = paper;
    } else {
      library.papers.unshift(paper);
      if (library.papers.length > MAX_PAPERS) library.papers.length = MAX_PAPERS;
    }
    library.version += 1;
    library.updatedAt = now();
    await writeHubJson(projectId, FILE, library);
    return { paper: clone(paper), duplicate: Boolean(existing), libraryVersion: library.version };
  });
  if (result.skipped) return result;
  await createTask(projectId, {
    kind: 'paper-import',
    title: `Import paper: ${result.paper.title}`,
    status: 'completed',
    progress: 100,
    metadata: { paperId: result.paper.id, duplicate: result.duplicate, evidenceId: result.paper.evidenceId },
    log: [result.duplicate ? 'Duplicate paper merged into the existing library record.' : 'Paper imported into the project library.', 'Evidence reference ensured.']
  });
  return result;
}

export async function updatePaper(projectId, paperId, patch, { actor = 'human' } = {}) {
  return withHubLock(projectId, async () => {
    const library = await readLibrary(projectId);
    const index = library.papers.findIndex((paper) => paper.id === paperId);
    if (index < 0) throw new Error('Paper not found.');
    if (Object.hasOwn(patch, 'annotations')) assertAnnotationsRevision(library.papers[index].annotations, patch.expectedAnnotationsRevision);
    const paper = normalizePaper({ ...patch, id: paperId }, { existing: library.papers[index] });
    paper.sourceRecords = mergeSourceRecords(library.papers[index].sourceRecords || [], paper.sourceRecords || []);
    if (library.papers[index].sourceReviews) paper.sourceReviews = clone(library.papers[index].sourceReviews);
    else delete paper.sourceReviews;
    if (patch.runSourceCheck) paper.sourceCheck = sourceCheckFor(paper, library.papers[index].sourceCheck);
    paper.evidenceId = await ensurePaperEvidence(projectId, paper, actor);
    library.papers[index] = paper;
    library.version += 1;
    library.updatedAt = now();
    await writeHubJson(projectId, FILE, library);
    return { paper: clone(paper), libraryVersion: library.version };
  });
}

export async function deletePaper(projectId, paperId) {
  return withHubLock(projectId, async () => {
    const library = await readLibrary(projectId);
    const before = library.papers.length;
    library.papers = library.papers.filter((paper) => paper.id !== paperId);
    if (before === library.papers.length) throw new Error('Paper not found.');
    library.version += 1;
    library.updatedAt = now();
    await writeHubJson(projectId, FILE, library);
    return { paperId, libraryVersion: library.version };
  });
}

export async function checkPaperSource(projectId, paperId) {
  const paper = await getPaper(projectId, paperId);
  return updatePaper(projectId, paperId, { runSourceCheck: true }, { actor: 'system' });
}

export async function getPaperLibrarySummary(projectId) {
  const papers = await listPapers(projectId, { limit: MAX_PAPERS });
  return {
    count: papers.length,
    unread: papers.filter((paper) => paper.readingStatus === 'unread').length,
    reading: papers.filter((paper) => paper.readingStatus === 'reading').length,
    read: papers.filter((paper) => paper.readingStatus === 'read').length,
    favorites: papers.filter((paper) => paper.favorite).length,
    needsSourceReview: papers.filter((paper) => paper.sourceCheck?.status === 'needs-review').length,
    tags: [...new Set(papers.flatMap((paper) => paper.tags))].sort(),
    recent: papers.slice(0, 5)
  };
}

export { FILE as PAPER_LIBRARY_FILE, paperKey, sourceCheckFor };
