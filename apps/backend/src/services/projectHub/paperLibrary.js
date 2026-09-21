import { randomUUID } from 'node:crypto';
import { getEvidence, upsertEvidence } from '../evidenceLedger/index.js';
import { createTask } from './taskCenter.js';
import { clone, readHubJson, withHubLock, writeHubJson } from './repository.js';

const FILE = 'paper-library.json';
const STATUSES = new Set(['unread', 'reading', 'read', 'archived']);
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

function uniqueStrings(value) {
  return [...new Set((Array.isArray(value) ? value : []).map(text).filter(Boolean))];
}

function normalizedUrl(value) {
  const url = text(value);
  if (!url) return '';
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    parsed.search = '';
    return parsed.toString().replace(/\/$/, '').toLowerCase();
  } catch {
    return url.toLowerCase().replace(/\/$/, '');
  }
}

function normalizedArxiv(value) {
  const input = text(value).replace(/^https?:\/\/[^/]+\/(?:abs|pdf)\//i, '').replace(/\.pdf$/i, '');
  return input ? input.replace(/v\d+$/i, '').toLowerCase() : '';
}

function normalizedDoi(value) {
  return text(value).replace(/^https?:\/\/doi\.org\//i, '').replace(/^doi:/i, '').toLowerCase();
}

function paperKey(input) {
  const arxivId = normalizedArxiv(input.arxivId || input.metadata?.arxivId);
  if (arxivId) return `arxiv:${arxivId}`;
  const doi = normalizedDoi(input.doi || input.metadata?.doi);
  if (doi) return `doi:${doi}`;
  const url = normalizedUrl(input.url || input.source?.url);
  if (url) return `url:${url}`;
  const title = text(input.title).toLowerCase().replace(/\s+/g, ' ');
  return title ? `title:${title}:${input.year || ''}` : '';
}

function bibtexFor(paper) {
  if (text(paper.bibtex)) return paper.bibtex;
  const firstAuthor = text(paper.authors?.[0]).split(/\s+/).filter(Boolean).pop() || 'paper';
  const firstWord = text(paper.title).toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 24) || 'paper';
  const key = `${firstAuthor.toLowerCase().replace(/[^a-z0-9]+/g, '')}${paper.year || ''}${firstWord}`;
  const authors = uniqueStrings(paper.authors).join(' and ');
  return `@article{${key},\n  title={${text(paper.title)}},\n  author={${authors}},\n  year={${paper.year || ''}},\n  journal={${text(paper.venue) || 'Preprint'}},\n  url={${text(paper.url)}}\n}`;
}

function sourceCheckFor(paper, previous) {
  const issues = [];
  if (!text(paper.title)) issues.push('missing-title');
  if (!uniqueStrings(paper.authors).length) issues.push('missing-authors');
  if (!text(paper.url) && !text(paper.doi) && !text(paper.arxivId)) issues.push('missing-source-location');
  return {
    status: issues.length ? 'needs-review' : 'checked',
    checkedAt: now(),
    provider: text(paper.source) || previous?.provider || 'metadata',
    issues
  };
}

function normalizeAnnotation(annotation, previous) {
  const at = now();
  return {
    id: text(annotation?.id) || `annotation-${randomUUID()}`,
    text: text(annotation?.text),
    quote: text(annotation?.quote),
    page: Number.isFinite(Number(annotation?.page)) ? Number(annotation.page) : null,
    createdAt: previous?.createdAt || at,
    updatedAt: at
  };
}

function normalizePaper(input, { existing } = {}) {
  const at = now();
  const previous = existing || {};
  const source = input.source && typeof input.source === 'object'
    ? { ...input.source }
    : { provider: text(input.source) || previous.source?.provider || null, url: text(input.url) || previous.source?.url || null };
  const merged = {
    ...previous,
    ...input,
    id: previous.id || text(input.id) || `paper-${randomUUID()}`,
    title: text(input.title) || text(previous.title) || 'Untitled paper',
    authors: uniqueStrings(input.authors ?? previous.authors),
    abstract: text(input.abstract ?? previous.abstract),
    url: text(input.url ?? previous.url),
    doi: normalizedDoi(input.doi ?? previous.doi),
    arxivId: normalizedArxiv(input.arxivId ?? previous.arxivId),
    venue: text(input.venue ?? previous.venue),
    year: Number.isFinite(Number(input.year ?? previous.year)) ? Number(input.year ?? previous.year) : null,
    source,
    sourceRecords: [...new Map([
      ...(previous.sourceRecords || []),
      ...(Array.isArray(input.sourceRecords) ? input.sourceRecords : []),
      ...((text(input.source) || previous.source?.provider || input.arxivId || input.doi) ? [{ provider: text(input.source) || previous.source?.provider || null, id: input.arxivId || input.doi || input.url || null, retrievedAt: at }] : [])
    ].map((record) => [`${record.provider || ''}:${record.id || ''}`, record])).values()],
    evidenceId: text(input.evidenceId ?? previous.evidenceId) || null,
    tags: uniqueStrings(input.tags ?? previous.tags),
    favorite: input.favorite === undefined ? Boolean(previous.favorite) : Boolean(input.favorite),
    readingStatus: STATUSES.has(input.readingStatus) ? input.readingStatus : (STATUSES.has(previous.readingStatus) ? previous.readingStatus : 'unread'),
    notes: text(input.notes ?? previous.notes),
    annotations: Array.isArray(input.annotations)
      ? input.annotations.map((annotation, index) => normalizeAnnotation(annotation, previous.annotations?.[index]))
      : (previous.annotations || []),
    bibtex: text(input.bibtex ?? previous.bibtex) || bibtexFor({ ...previous, ...input }),
    sourceCheck: input.sourceCheck || previous.sourceCheck || sourceCheckFor({ ...previous, ...input }, previous.sourceCheck),
    importedAt: previous.importedAt || at,
    createdAt: previous.createdAt || at,
    updatedAt: at
  };
  merged.canonicalKey = paperKey(merged);
  if (input.runSourceCheck) merged.sourceCheck = sourceCheckFor(merged, previous.sourceCheck);
  return merged;
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

export async function importPaper(projectId, input, { actor = 'human' } = {}) {
  if (!input || typeof input !== 'object') throw new Error('Paper must be an object.');
  const result = await withHubLock(projectId, async () => {
    const library = await readLibrary(projectId);
    const candidate = normalizePaper(input, {});
    const existingIndex = library.papers.findIndex((paper) => paper.canonicalKey === candidate.canonicalKey);
    const existing = existingIndex >= 0 ? library.papers[existingIndex] : undefined;
    const paper = normalizePaper({ ...candidate, ...input }, { existing });
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
    const paper = normalizePaper({ ...patch, id: paperId }, { existing: library.papers[index] });
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
