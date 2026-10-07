import { queryArxiv } from './arxivClient.js';
import { PaperSourceLookupError } from './doiLookup.js';
import { ResearchSourceError } from './sourceAdapter.js';

const ID = /^(?:[a-z][a-z0-9-]+(?:\.[a-z0-9-]+)?\/\d{7}|\d{4}\.\d{4,5})(?:v[1-9]\d*)?$/i;

export function parseArxiv(value) {
  if (typeof value !== 'string' || value.length > 2048 || !value.isWellFormed() || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new PaperSourceLookupError('INVALID_ARXIV_ID', 'An arXiv identifier or arXiv abs/pdf URL is required.', 400);
  }
  let input = value.trim();
  if (/^https?:\/\//i.test(input)) {
    try {
      const url = new URL(input);
      if (!['arxiv.org', 'export.arxiv.org'].includes(url.hostname) || url.username || url.password || url.port || url.search || url.hash) throw new Error();
      const match = url.pathname.match(/^\/(abs|pdf)\/(.+?)(?:\.pdf)?$/i);
      if (!match) throw new Error();
      input = match[2];
    } catch {
      throw new PaperSourceLookupError('INVALID_ARXIV_ID', 'Use an arXiv identifier or an abs/pdf URL without query parameters.', 400);
    }
  }
  if (!ID.test(input)) throw new PaperSourceLookupError('INVALID_ARXIV_ID', 'Invalid arXiv identifier or version.', 400);
  const versionMatch = input.match(/(v[1-9]\d*)$/i);
  const version = versionMatch ? versionMatch[1].toLowerCase() : null;
  const baseId = (version ? input.slice(0, -version.length) : input).toLowerCase();
  return { arxivId: baseId, version, identifier: `${baseId}${version || ''}` };
}

const text = (value) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
const authorsOf = (entry) => (Array.isArray(entry.author) ? entry.author : entry.author ? [entry.author] : [])
  .map((author) => text(author?.name)).filter(Boolean);

function yearOf(entry) {
  const date = text(entry.published);
  const match = date.match(/^(\d{4})/);
  return match ? Number(match[1]) : null;
}

export function createArxivLookup({ query = queryArxiv, now = Date.now } = {}) {
  return async function lookup(value, { signal } = {}) {
    const parsed = parseArxiv(value);
    let entries;
    try {
      entries = await query({ id_list: parsed.identifier, start: 0, max_results: 1 }, { signal });
    } catch (error) {
      if (error instanceof PaperSourceLookupError) throw error;
      if (error instanceof ResearchSourceError) {
        const status = { SOURCE_RATE_LIMITED: 429, SOURCE_BUSY: 503, SOURCE_TIMEOUT: 504, SOURCE_CANCELLED: 499 }[error.code] || 502;
        throw new PaperSourceLookupError(error.code, error.message, status);
      }
      throw error;
    }
    if (!Array.isArray(entries)) throw new PaperSourceLookupError('SOURCE_INVALID_RESPONSE', 'arXiv returned an invalid result.');
    if (entries.length === 0) throw new PaperSourceLookupError('SOURCE_NOT_FOUND', 'No arXiv record found for this identifier.', 404);
    const entry = entries[0];
    let returned;
    try { returned = parseArxiv(entry?.id); } catch { /* Invalid provider identity is not an input error. */ }
    if (entries.length !== 1 || !returned?.version || returned.arxivId !== parsed.arxivId || (parsed.version && returned.version !== parsed.version)) {
      throw new PaperSourceLookupError('SOURCE_IDENTITY_MISMATCH', 'arXiv returned a different or missing identifier or version.');
    }
    const version = returned.version;
    const retrievedAt = new Date(now()).toISOString();
    const candidate = {
      title: text(entry.title), authors: authorsOf(entry), abstract: text(entry.summary),
      year: yearOf(entry), arxivId: parsed.arxivId, version, doi: null,
      url: `https://arxiv.org/abs/${parsed.arxivId}${version || ''}`, venue: 'arXiv', source: 'arxiv',
      publicationType: 'preprint', peerReviewed: null,
      sourceRecords: [{ provider: 'arxiv', id: returned.identifier, retrievedAt, url: `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(parsed.identifier)}`, externalVersion: version }]
    };
    const issues = [];
    if (!candidate.title) issues.push('missing-title');
    if (!candidate.authors.length) issues.push('missing-authors');
    if (!candidate.year) issues.push('missing-year');
    return { provider: 'arxiv', identifier: parsed.arxivId, requestedVersion: parsed.version, externalVersion: version, retrievedAt, candidate, record: entry,
      checks: { fields: { status: issues.length ? 'incomplete' : 'complete', issues }, source: { status: 'identifier-matched', scope: 'provider-metadata', scientificStatus: 'unverified' } },
      requiresDecision: true, writesPerformed: false };
  };
}

export const lookupArxiv = createArxivLookup();
