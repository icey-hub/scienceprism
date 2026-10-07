import { randomUUID } from 'node:crypto';

const STATUSES = new Set(['unread', 'reading', 'read', 'archived']);
const now = () => new Date().toISOString();

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

export function paperKey(input) {
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

export function sourceCheckFor(paper, previous) {
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

export function normalizePaper(input, { existing } = {}) {
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
