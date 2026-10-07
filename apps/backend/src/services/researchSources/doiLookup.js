// Provider contract: https://www.crossref.org/documentation/retrieve-metadata/rest-api/tips-for-using-the-crossref-rest-api/
export class PaperSourceLookupError extends Error {
  constructor(code, message, statusCode = 502, retryAfter = null) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
    this.retryAfter = retryAfter;
  }
}

export function parseDoi(value) {
  if (typeof value !== 'string' || value.length > 2048 || !value.isWellFormed() || /[\u0000-\u001f\u007f]/.test(value)) throw new PaperSourceLookupError('INVALID_DOI', 'A DOI or doi.org URL is required.', 400);
  let doi = value.trim().replace(/^doi:\s*/i, '');
  if (/^https?:\/\//i.test(doi)) {
    try {
      const url = new URL(doi);
      if (!['doi.org', 'dx.doi.org'].includes(url.hostname) || url.username || url.password || url.port || url.search || url.hash) throw new Error();
      doi = decodeURIComponent(url.pathname.slice(1));
    } catch { throw new PaperSourceLookupError('INVALID_DOI', 'Use a DOI or a doi.org URL without query parameters.', 400); }
  }
  if (!/^10\.\d{4,9}\/[^\s\u0000-\u001f\u007f]+$/i.test(doi)) throw new PaperSourceLookupError('INVALID_DOI', 'Invalid DOI identifier.', 400);
  return doi.toLowerCase();
}

const text = (value) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
const firstText = (value) => Array.isArray(value) ? text(value[0]) : '';

async function readRecord(response) {
  const maxBytes = 1024 * 1024;
  const reader = response.body?.getReader();
  if (!reader) throw new PaperSourceLookupError('SOURCE_INVALID_RESPONSE', 'Crossref returned an empty response.');
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) throw new PaperSourceLookupError('SOURCE_RESPONSE_TOO_LARGE', 'Crossref metadata exceeds 1 MiB.');
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new PaperSourceLookupError('SOURCE_INVALID_RESPONSE', 'Crossref returned invalid JSON.'); }
  } finally { await reader.cancel().catch(() => {}); }
}

function retrySeconds(value, now) {
  if (!value) return 60;
  const seconds = /^\d+$/.test(value) ? Number(value) : Math.ceil((Date.parse(value) - now) / 1000);
  return Number.isFinite(seconds) ? Math.max(1, seconds) : 60;
}

// One active request and conservative local pacing. No queued automatic retries.
// This gate is per backend process; deployments sharing an IP must coordinate their quota.
export function createDoiLookup({ fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 15_000, intervalMs = 1000 } = {}) {
  let active = false;
  let nextAllowedAt = 0;
  return async function lookupDoi(value, { signal } = {}) {
    const identifier = parseDoi(value);
    if (signal?.aborted) throw new PaperSourceLookupError('SOURCE_CANCELLED', 'Source lookup cancelled.', 499);
    if (active || now() < nextAllowedAt) {
      throw new PaperSourceLookupError('SOURCE_RATE_LIMITED', 'Wait before querying Crossref again.', 429, Math.max(1, Math.ceil((nextAllowedAt - now()) / 1000)));
    }
    active = true;
    nextAllowedAt = now() + intervalMs;
    const endpoint = `https://api.crossref.org/works/${encodeURIComponent(identifier)}`;
    const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    try {
      const response = await fetchImpl(endpoint, { redirect: 'error', headers: { Accept: 'application/json', 'User-Agent': 'SciencePrism/1.0 (bibliographic lookup)' }, signal: requestSignal });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 404) throw new PaperSourceLookupError('SOURCE_NOT_FOUND', 'No record found in Crossref; this does not establish that the DOI is invalid.', 404);
        if (response.status === 429) {
          const retryAfter = retrySeconds(response.headers.get('retry-after'), now());
          nextAllowedAt = Math.max(nextAllowedAt, now() + retryAfter * 1000);
          throw new PaperSourceLookupError('SOURCE_RATE_LIMITED', 'Crossref rate limit reached. Retry later.', 429, retryAfter);
        }
        throw new PaperSourceLookupError('SOURCE_HTTP_ERROR', `Crossref request failed (HTTP ${response.status}).`);
      }
      const result = await readRecord(response);
      const record = result?.message;
      if (result?.status !== 'ok' || !record || typeof record !== 'object' || Array.isArray(record)) throw new PaperSourceLookupError('SOURCE_INVALID_RESPONSE', 'Crossref returned an invalid work record.');
      let returnedDoi;
      try { returnedDoi = parseDoi(record.DOI); } catch { /* Report provider data as a provider error. */ }
      if (returnedDoi !== identifier) throw new PaperSourceLookupError('SOURCE_IDENTITY_MISMATCH', 'Crossref returned a different or missing DOI.');
      const retrievedAt = new Date(now()).toISOString();
      const year = record.issued?.['date-parts']?.[0]?.[0];
      const candidate = {
        title: firstText(record.title),
        authors: (Array.isArray(record.author) ? record.author : []).map((author) => text(author?.name) || [text(author?.given), text(author?.family)].filter(Boolean).join(' ')).filter(Boolean),
        year: Number.isInteger(year) && year > 0 ? year : null,
        doi: identifier, url: `https://doi.org/${identifier}`, venue: firstText(record['container-title']),
        source: 'crossref', publicationType: text(record.type) || null, peerReviewed: null,
        sourceRecords: [{ provider: 'crossref', id: identifier, retrievedAt, url: endpoint, externalVersion: text(record.indexed?.['date-time']) || null }]
      };
      const issues = [];
      if (!candidate.title) issues.push('missing-title');
      if (!candidate.authors.length) issues.push('missing-authors');
      if (!candidate.year) issues.push('missing-year');
      return { provider: 'crossref', identifier, retrievedAt, candidate, record, checks: {
        fields: { status: issues.length ? 'incomplete' : 'complete', issues },
        source: { status: 'identifier-matched', scope: 'provider-metadata', scientificStatus: 'unverified' }
      }, requiresDecision: true, writesPerformed: false };
    } catch (error) {
      if (error instanceof PaperSourceLookupError) throw error;
      if (signal?.aborted) throw new PaperSourceLookupError('SOURCE_CANCELLED', 'Source lookup cancelled.', 499);
      if (requestSignal.aborted || error?.name === 'TimeoutError') throw new PaperSourceLookupError('SOURCE_TIMEOUT', 'Crossref lookup timed out.', 504);
      throw new PaperSourceLookupError('SOURCE_REQUEST_FAILED', 'Crossref is unavailable. Try again later.');
    } finally { active = false; }
  };
}

export const lookupDoi = createDoiLookup();
