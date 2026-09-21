import { randomUUID } from 'node:crypto';

export class ResearchSourceError extends Error {
  constructor(message, { code = 'SOURCE_ERROR', source, retryable = false } = {}) {
    super(message);
    this.name = 'ResearchSourceError';
    this.code = code;
    this.source = source;
    this.retryable = retryable;
  }
}

function asText(value) {
  return value === undefined || value === null ? '' : String(value).replace(/\s+/g, ' ').trim();
}

/**
 * The Source Adapter Interface keeps provider transport and response shapes
 * behind one research search Seam. Adapters return candidates, never quality
 * decisions or workflow approvals.
 */
export function assertSourceAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object' || !asText(adapter.id) || typeof adapter.search !== 'function') {
    throw new TypeError('A Source Adapter must provide an id and search({ query, maxResults, signal }).');
  }
  return adapter;
}

export function normalizeSourceCandidate(candidate, { source, retrievedAt = new Date().toISOString() } = {}) {
  const input = candidate && typeof candidate === 'object' ? candidate : {};
  const sourceId = asText(input.source || input.provider || source);
  const id = asText(input.id || input.paperId || input.doi || input.url) || `candidate-${randomUUID()}`;
  return {
    ...input,
    id,
    source: sourceId || null,
    retrievedAt: asText(input.retrievedAt) || retrievedAt,
    sourceRecord: input.sourceRecord && typeof input.sourceRecord === 'object'
      ? input.sourceRecord
      : { provider: sourceId || null, id }
  };
}

export async function searchWithAdapter(adapterInput, { query, maxResults = 20, signal } = {}) {
  const adapter = assertSourceAdapter(adapterInput);
  const normalizedQuery = asText(query);
  if (!normalizedQuery) throw new ResearchSourceError('A search query is required.', { code: 'MISSING_QUERY', source: adapter.id });
  const startedAt = new Date().toISOString();
  try {
    const result = await adapter.search({ query: normalizedQuery, maxResults, signal });
    const candidates = Array.isArray(result) ? result : result?.candidates;
    if (!Array.isArray(candidates)) {
      throw new ResearchSourceError(`Source Adapter ${adapter.id} returned an invalid result.`, { code: 'INVALID_SOURCE_RESULT', source: adapter.id });
    }
    return {
      source: adapter.id,
      query: normalizedQuery,
      retrievedAt: startedAt,
      candidates: candidates.map((candidate) => normalizeSourceCandidate(candidate, { source: adapter.id, retrievedAt: startedAt }))
    };
  } catch (error) {
    if (error instanceof ResearchSourceError) throw error;
    throw new ResearchSourceError(`Source Adapter ${adapter.id} failed: ${error.message || error}`, {
      code: error?.name === 'AbortError' ? 'SOURCE_TIMEOUT' : 'SOURCE_REQUEST_FAILED',
      source: adapter.id,
      retryable: true
    });
  }
}
