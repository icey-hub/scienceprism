import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { createArxivClient } from '../src/services/researchSources/arxivClient.js';
import { arxivSourceAdapter } from '../src/services/researchSources/arxivAdapter.js';
import { fetchArxivEntry } from '../src/services/arxivService.js';

const feed = (entries = '') => `<feed xmlns="http://www.w3.org/2005/Atom">${entries}</feed>`;
const entry = '<entry><id>http://arxiv.org/abs/2401.01234v2</id><title>Versioned study</title><summary>Study abstract.</summary><published>2024-01-02T00:00:00Z</published><author><name>A Researcher</name></author></entry>';
const ok = () => new Response(feed(entry));

test('shared search and single-entry consumers preserve shapes and start at least three seconds apart', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const starts = [];
  globalThis.fetch = async (url, options) => {
    starts.push({ at: performance.now(), url });
    assert.equal(options.redirect, 'error');
    assert.equal(new URL(url).origin, 'https://export.arxiv.org');
    return ok();
  };
  const [results, paper] = await Promise.all([
    arxivSourceAdapter.search({ query: 'study & id_list=evil', maxResults: 2 }),
    fetchArxivEntry('2401.01234v2')
  ]);
  assert.equal(results[0].arxivId, '2401.01234v2');
  assert.deepEqual(results[0].authors, ['A Researcher']);
  assert.equal(results[0].year, 2024);
  assert.equal(paper.year, '2024');
  assert.equal(paper.arxivId, '2401.01234v2');
  assert.equal(new URL(starts[0].url).searchParams.get('search_query'), 'all:study & id_list=evil');
  assert.equal(new URL(starts[0].url).searchParams.has('id_list'), false);
  assert.ok(starts[1].at - starts[0].at >= 2990, JSON.stringify(starts));
});

test('active response body holds the connection slot until fully consumed', async () => {
  let release;
  let started;
  const entered = new Promise((resolve) => { started = resolve; });
  let calls = 0;
  const query = createArxivClient({ intervalMs: 0, fetchImpl: async () => {
    calls++;
    if (calls > 1) return ok();
    return new Response(new ReadableStream({ start(controller) {
      release = () => { controller.enqueue(new TextEncoder().encode(feed(entry))); controller.close(); };
      started();
    } }));
  } });
  const first = query({ id_list: '2401.01234' });
  await entered;
  const second = query({ search_query: 'all:study' });
  await delay(10);
  assert.equal(calls, 1);
  release();
  await Promise.all([first, second]);
  assert.equal(calls, 2);
});

test('queued cancellation returns promptly, skips transport, and leaves following work runnable', async () => {
  let release;
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  let calls = 0;
  const query = createArxivClient({ intervalMs: 0, fetchImpl: async () => {
    calls++;
    if (calls === 1) { entered(); return new Promise((resolve) => { release = () => resolve(ok()); }); }
    return ok();
  } });
  const first = query({ id_list: '2401.01234' });
  await started;
  const controller = new AbortController();
  const cancelled = query({ id_list: '2401.01234' }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(() => cancelled, { code: 'SOURCE_CANCELLED', retryable: false });
  const third = query({ id_list: '2401.01234' });
  release();
  await Promise.all([first, third]);
  assert.equal(calls, 2);
});

test('timeout includes waiting and transport; bounded queue rejects overflow', async () => {
  const query = createArxivClient({ intervalMs: 0, timeoutMs: 20, maxPending: 2, fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) });
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const first = assert.rejects(() => query({ id_list: '1' }), { code: 'SOURCE_TIMEOUT', retryable: true });
    const second = assert.rejects(() => query({ id_list: '2' }), { code: 'SOURCE_TIMEOUT' });
    await assert.rejects(() => query({ id_list: '3' }), { code: 'SOURCE_BUSY' });
    await Promise.all([first, second]);
    await assert.rejects(() => query({ id_list: '4' }), { code: 'SOURCE_TIMEOUT' });
  } finally { clearInterval(keepAlive); }
});

test('429 cooldown honors Retry-After and never retries a failed request automatically', async () => {
  for (const header of ['5', new Date(1_800_000_005_000).toUTCString(), 'invalid']) {
    let clock = 1_800_000_000_000;
    let calls = 0;
    const query = createArxivClient({ now: () => clock, intervalMs: 0, fetchImpl: async () => ++calls === 1 ? new Response('', { status: 429, headers: { 'retry-after': header } }) : ok() });
    await assert.rejects(() => query({ id_list: '1' }), { code: 'SOURCE_RATE_LIMITED' });
    await assert.rejects(() => query({ id_list: '1' }), { code: 'SOURCE_RATE_LIMITED' });
    assert.equal(calls, 1);
    clock += header === 'invalid' ? 60_000 : 5000;
    assert.equal((await query({ id_list: '1' })).length, 1);
  }
});

test('empty feeds are valid; error entries, invalid XML, wrong format and oversized bodies fail', async () => {
  assert.deepEqual(await createArxivClient({ fetchImpl: async () => new Response(feed()) })({ id_list: '1' }), []);
  for (const [body, code] of [
    [feed('<entry><id>http://arxiv.org/api/errors#incorrect_id_format_for_1</id><title>Error</title></entry>'), 'SOURCE_QUERY_ERROR'],
    ['<feed><entry>', 'SOURCE_INVALID_RESPONSE'],
    ['<html>unavailable</html>', 'SOURCE_INVALID_RESPONSE'],
    ['<!DOCTYPE feed [<!ENTITY sample "text">]>' + feed(entry), 'SOURCE_INVALID_RESPONSE'],
    [feed('<entry><title>Missing identity</title></entry>'), 'SOURCE_INVALID_RESPONSE'],
    ['a'.repeat(2 * 1024 * 1024 + 1), 'SOURCE_RESPONSE_TOO_LARGE']
  ]) {
    await assert.rejects(() => createArxivClient({ fetchImpl: async () => new Response(body) })({ id_list: '1' }), { code });
  }
});

test('real HTTP transport reports upstream errors and preserves XML entities', async (t) => {
  let mode = 'ok';
  const server = createServer((_req, res) => {
    if (mode === 'fail') { res.writeHead(503); res.end('unavailable'); }
    else { res.writeHead(200, { 'Content-Type': 'application/atom+xml' }); res.end(feed(entry.replace('Versioned study', 'Study &amp; evidence'))); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const query = createArxivClient({ intervalMs: 0, fetchImpl: (_url, options) => fetch(`http://127.0.0.1:${server.address().port}`, options) });
  assert.equal((await query({ id_list: '1' }))[0].title, 'Study & evidence');
  mode = 'fail';
  await assert.rejects(() => query({ id_list: '1' }), { code: 'SOURCE_HTTP_ERROR', retryable: true });
  mode = 'ok';
  assert.equal((await query({ id_list: '1' })).length, 1);
});
