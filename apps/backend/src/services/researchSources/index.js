import { arxivSourceAdapter } from './arxivAdapter.js';
import { assertSourceAdapter, normalizeSourceCandidate, ResearchSourceError, searchWithAdapter } from './sourceAdapter.js';

const adapters = new Map([[arxivSourceAdapter.id, arxivSourceAdapter]]);

/**
 * Intentionally unused today, and deliberately kept: the roadmap commits to a
 * Source Adapter Seam for future OpenAlex / Semantic Scholar / Crossref
 * adapters. It is the only way to add a source without editing the map above.
 */
export function registerResearchSourceAdapter(adapter) {
  const valid = assertSourceAdapter(adapter);
  adapters.set(valid.id, valid);
  return valid;
}

export function getResearchSourceAdapter(id = 'arxiv') {
  return adapters.get(String(id).trim().toLowerCase()) || null;
}

export function listResearchSourceAdapters() {
  return [...adapters.values()].map(({ id, label, priority }) => ({ id, label, priority: priority ?? 0 }));
}

export async function searchResearchSources({ queries = [], sources = ['arxiv'], maxResults = 12, signal } = {}) {
  const normalizedQueries = [...new Set((Array.isArray(queries) ? queries : [queries]).map((query) => String(query || '').trim()).filter(Boolean))];
  const normalizedSources = [...new Set((Array.isArray(sources) ? sources : [sources]).map((source) => String(source || '').trim().toLowerCase()).filter(Boolean))];
  if (!normalizedQueries.length) throw new ResearchSourceError('At least one search query is required.', { code: 'MISSING_QUERY' });
  if (!normalizedSources.length) throw new ResearchSourceError('At least one research source is required.', { code: 'MISSING_SOURCE' });

  const batches = [];
  const failures = [];
  for (const sourceId of normalizedSources) {
    const adapter = getResearchSourceAdapter(sourceId);
    if (!adapter) {
      failures.push({ source: sourceId, code: 'SOURCE_NOT_CONFIGURED', message: `No Source Adapter is registered for ${sourceId}.` });
      continue;
    }
    for (const query of normalizedQueries) {
      try {
        batches.push(await searchWithAdapter(adapter, { query, maxResults, signal }));
      } catch (error) {
        failures.push({ source: sourceId, query, code: error.code || 'SOURCE_ERROR', message: error.message, retryable: error.retryable === true });
      }
    }
  }
  return { batches, failures, sources: normalizedSources, queries: normalizedQueries };
}

export { assertSourceAdapter, normalizeSourceCandidate, ResearchSourceError, searchWithAdapter };
