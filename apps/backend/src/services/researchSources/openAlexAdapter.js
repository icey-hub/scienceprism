import { getEnv } from '../../config/constants.js';
import { ResearchSourceError, checkSourceRequest, isSourcePolicyFailure } from './sourceAdapter.js';

const error = (code, message, retryable = false) => new ResearchSourceError(message, { code, source: 'openalex', retryable });
const text = value => typeof value === 'string' ? value.trim() : '';
function abstractFrom(index) {
  if (!index || typeof index !== 'object' || Array.isArray(index)) return '';
  const words = [];
  for (const [word, positions] of Object.entries(index)) {
    if (!Array.isArray(positions)) continue;
    for (const position of positions) if (Number.isInteger(position) && position >= 0 && position < 10000) words[position] = word;
  }
  return words.join(' ').slice(0, 60000);
}
export function normalizeOpenAlexWork(work) {
  const venue = work.primary_location?.source;
  const doi = text(work.doi).replace(/^https?:\/\/doi\.org\//i, '').toLowerCase();
  const location = work.best_oa_location;
  const publicationType = work.type === 'preprint' ? 'preprint'
    : work.type === 'article' && venue?.type === 'journal' ? 'journal'
      : work.type === 'article' && venue?.type === 'conference' ? 'conference' : text(work.type) || null;
  return {
    id: text(work.id), title: text(work.title) || text(work.display_name), doi,
    authors: (work.authorships || []).map(item => text(item.author?.display_name)).filter(Boolean),
    year: Number.isInteger(work.publication_year) ? work.publication_year : null,
    abstract: abstractFrom(work.abstract_inverted_index),
    url: doi ? `https://doi.org/${doi}` : text(work.primary_location?.landing_page_url) || text(work.id),
    venue: text(venue?.display_name), issns: [...new Set([...(venue?.issn || []), venue?.issn_l].filter(value => typeof value === 'string' && value))],
    publicationType, providerType: text(work.type), peerReviewed: null,
    isOpenAccess: typeof work.open_access?.is_oa === 'boolean' ? work.open_access.is_oa : null,
    oaPdfUrl: location?.is_oa === true ? text(location.pdf_url) : '',
    oaVersion: text(location?.version), oaLicense: text(location?.license),
    source: 'openalex', metadataSource: 'openalex', metadataUpdatedAt: text(work.updated_date),
    sourceRecord: { provider: 'openalex', id: text(work.id), externalVersion: text(work.updated_date) || null,
      metadata: { doi, type: text(work.type), publicationYear: work.publication_year ?? null, venue: text(venue?.display_name), oaLocation: location || null } }
  };
}

async function readJson(response) {
  const reader = response.body?.getReader();
  if (!reader) throw error('SOURCE_INVALID_RESPONSE', 'OpenAlex 返回空响应。');
  const chunks = []; let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.byteLength;
      if (bytes > 8 * 1024 * 1024) throw error('SOURCE_RESPONSE_TOO_LARGE', 'OpenAlex 响应超过 8 MiB。');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  let result;
  try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw error('SOURCE_INVALID_RESPONSE', 'OpenAlex 返回无效 JSON。'); }
  if (!Array.isArray(result.results) || !Number.isSafeInteger(result.meta?.count) || result.meta.count < 0
    || result.results.some(work => !work || typeof work.id !== 'string' || !/^https:\/\/openalex.org\/W\d+$/.test(work.id))) throw error('SOURCE_INVALID_RESPONSE', 'OpenAlex 返回无效论文列表。');
  return result;
}

/** Offset windows use fixed 100-record upstream pages, including a lookahead across boundaries. */
export function createOpenAlexAdapter({ fetchImpl = (...args) => globalThis.fetch(...args), timeoutMs = 20000, now = Date.now, apiKey = () => getEnv('OPENALEX_API_KEY') } = {}) {
  let cooldownUntil = 0;
  return Object.freeze({
    id: 'openalex', label: 'OpenAlex', priority: 20, filterMode: 'server',
    async search({ query, maxResults = 20, offset = 0, filters = {}, signal, beforeRequest } = {}) {
      if (now() < cooldownUntil) throw error('SOURCE_RATE_LIMITED', 'OpenAlex 正处于限流冷却，请稍后重试。', true);
      const limit = Math.min(50, Math.max(1, Math.floor(Number(maxResults) || 20)));
      if (!Number.isInteger(offset) || offset < 0 || offset > 5000) throw error('SOURCE_INVALID_QUERY', 'OpenAlex 检索偏移需在 0–5000 内。');
      const deadline = AbortSignal.timeout(timeoutMs);
      const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
      const rules = [];
      if (filters.yearFrom) rules.push(`from_publication_date:${filters.yearFrom}-01-01`);
      if (filters.yearTo) rules.push(`to_publication_date:${filters.yearTo}-12-31`);
      if (filters.publicationType === 'journal') rules.push('type:article', 'primary_location.source.type:journal');
      else if (filters.publicationType === 'conference') rules.push('type:article', 'primary_location.source.type:conference');
      else if (filters.publicationType === 'preprint') rules.push('type:preprint');
      if (filters.openAccessOnly) rules.push('open_access.is_oa:true');
      const items = []; let total = null;
      const firstPage = Math.floor(offset / 100) + 1;
      const lastPage = Math.floor((offset + limit - 1) / 100) + 1;
      try {
        for (let page = firstPage; page <= lastPage; page++) {
          requestSignal.throwIfAborted();
          const url = new URL('https://api.openalex.org/works');
          url.searchParams.set('search', query); url.searchParams.set('page', String(page)); url.searchParams.set('per_page', '100');
          url.searchParams.set('select', 'id,title,doi,authorships,publication_year,type,primary_location,best_oa_location,open_access,abstract_inverted_index,updated_date');
          if (rules.length) url.searchParams.set('filter', rules.join(','));
          await checkSourceRequest(beforeRequest, { source: 'openalex', url: url.toString() });
          requestSignal.throwIfAborted();
          const key = apiKey();
          const response = await fetchImpl(url.toString(), { redirect: 'error', signal: requestSignal,
            headers: { Accept: 'application/json', 'User-Agent': 'SciencePrism/1.0 (paper search)', ...(key ? { Authorization: `Bearer ${key}` } : {}) } });
          if (!response.ok) {
            await response.body?.cancel();
            if (response.status === 429) {
              const value = response.headers.get('retry-after');
              const seconds = /^\d+$/.test(value || '') ? Number(value) : (Date.parse(value) - now()) / 1000;
              cooldownUntil = now() + (Number.isFinite(seconds) ? Math.min(86400, Math.max(1, seconds)) : 60) * 1000;
              throw error('SOURCE_RATE_LIMITED', 'OpenAlex 免费访问额度或速率受限，请稍后重试。', true);
            }
            throw error('SOURCE_HTTP_ERROR', `OpenAlex 请求失败（HTTP ${response.status}）。`, response.status >= 500);
          }
          const result = await readJson(response); total = result.meta.count; items.push(...result.results);
          if (result.results.length < 100) break;
        }
        requestSignal.throwIfAborted();
        return { candidates: items.slice(offset % 100, offset % 100 + limit).map(normalizeOpenAlexWork), total, filterMode: 'server' };
      } catch (cause) {
        if (isSourcePolicyFailure(cause)) throw cause;
        if (signal?.aborted) throw error('SOURCE_CANCELLED', 'OpenAlex 检索已取消。');
        if (deadline.aborted) throw error('SOURCE_TIMEOUT', 'OpenAlex 检索超时。', true);
        if (cause instanceof ResearchSourceError) throw cause;
        throw error('SOURCE_REQUEST_FAILED', 'OpenAlex 当前无法访问。', true);
      }
    }
  });
}
export const openAlexSourceAdapter = createOpenAlexAdapter();
