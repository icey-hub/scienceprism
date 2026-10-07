import { setTimeout as delay } from 'node:timers/promises';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { ResearchSourceError } from './sourceAdapter.js';

function sourceError(code, message, retryable = false) {
  return new ResearchSourceError(message, { code, source: 'arxiv', retryable });
}

async function readFeed(response) {
  const reader = response.body?.getReader();
  if (!reader) throw sourceError('SOURCE_INVALID_RESPONSE', 'arXiv returned an empty response.');
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 2 * 1024 * 1024) throw sourceError('SOURCE_RESPONSE_TOO_LARGE', 'arXiv response exceeds 2 MiB.');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const xml = Buffer.concat(chunks).toString('utf8');
  if (/<!DOCTYPE/i.test(xml) || XMLValidator.validate(xml) !== true) throw sourceError('SOURCE_INVALID_RESPONSE', 'arXiv returned invalid Atom XML.');
  const data = new XMLParser({ ignoreAttributes: false, parseTagValue: false }).parse(xml);
  if (!data?.feed || data.feed['@_xmlns'] !== 'http://www.w3.org/2005/Atom') throw sourceError('SOURCE_INVALID_RESPONSE', 'arXiv returned no Atom feed.');
  const entries = Array.isArray(data.feed.entry) ? data.feed.entry : data.feed.entry ? [data.feed.entry] : [];
  if (entries.some((entry) => /^https?:\/\/arxiv\.org\/api\/errors(?:#|$)/.test(String(entry.id)))) {
    throw sourceError('SOURCE_QUERY_ERROR', 'arXiv rejected the query. Check its identifiers and search syntax.');
  }
  if (entries.some((entry) => typeof entry.id !== 'string' || typeof entry.title !== 'string')) throw sourceError('SOURCE_INVALID_RESPONSE', 'arXiv returned an invalid entry.');
  return entries;
}

// https://info.arxiv.org/help/api/tou.html#rate-limits
// All legacy API consumers in this backend share one connection and 3s pacing.
// Multiple backend processes must coordinate their shared upstream quota separately.
export function createArxivClient({ fetchImpl = (...args) => globalThis.fetch(...args), intervalMs = 3000, timeoutMs = 30_000, maxPending = 32, now = Date.now } = {}) {
  let tail = Promise.resolve();
  let pending = 0;
  let nextStart = 0;
  let cooldownUntil = 0;
  return async function queryArxiv(parameters, { signal } = {}) {
    if (pending >= maxPending) throw sourceError('SOURCE_BUSY', 'arXiv request queue is full. Try again later.', true);
    const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    const abortError = () => sourceError(signal?.aborted ? 'SOURCE_CANCELLED' : 'SOURCE_TIMEOUT', signal?.aborted ? 'arXiv query cancelled.' : 'arXiv query timed out.', !signal?.aborted);
    if (requestSignal.aborted) throw abortError();
    const url = new URL('https://export.arxiv.org/api/query');
    for (const [key, value] of Object.entries(parameters)) {
      if (!['search_query', 'id_list', 'start', 'max_results'].includes(key) || !['string', 'number'].includes(typeof value)) throw sourceError('SOURCE_INVALID_QUERY', 'Invalid arXiv query parameters.');
      url.searchParams.set(key, String(value));
    }
    let onAbort;
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(abortError());
      requestSignal.addEventListener('abort', onAbort, { once: true });
    });
    pending++;
    const operation = tail.then(async () => {
      try {
        requestSignal.throwIfAborted();
        if (now() < cooldownUntil) throw sourceError('SOURCE_RATE_LIMITED', 'arXiv rate limit cooldown is active. Retry later.', true);
        while (nextStart > now()) await delay(nextStart - now(), undefined, { signal: requestSignal });
        requestSignal.throwIfAborted();
        nextStart = now() + intervalMs;
        const response = await fetchImpl(url.toString(), { redirect: 'error', headers: { Accept: 'application/atom+xml', 'User-Agent': 'SciencePrism/1.0 (bibliographic lookup)' }, signal: requestSignal });
        if (!response.ok) {
          await response.body?.cancel();
          if (response.status === 429) {
            const value = response.headers.get('retry-after') || '';
            const seconds = /^\d+$/.test(value) ? Number(value) : (Date.parse(value) - now()) / 1000;
            cooldownUntil = now() + (Number.isFinite(seconds) ? Math.max(3, seconds) : 60) * 1000;
            throw sourceError('SOURCE_RATE_LIMITED', 'arXiv rate limit reached. Retry later.', true);
          }
          throw sourceError('SOURCE_HTTP_ERROR', `arXiv request failed: ${response.status}`, response.status >= 500);
        }
        return await readFeed(response);
      } catch (error) {
        if (requestSignal.aborted) throw abortError();
        if (error instanceof ResearchSourceError) throw error;
        throw sourceError('SOURCE_REQUEST_FAILED', 'arXiv is unavailable. Try again later.', true);
      } finally { pending--; }
    });
    // Even a cancelled caller cannot release an active upstream connection early.
    tail = operation.catch(() => {});
    try { return await Promise.race([operation, aborted]); }
    finally { requestSignal.removeEventListener('abort', onAbort); }
  };
}

export const queryArxiv = createArxivClient();
