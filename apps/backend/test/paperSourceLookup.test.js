import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { createDoiLookup, parseDoi } from '../src/services/researchSources/doiLookup.js';

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'scienceprism-source-lookup-'));
process.env.SCIENCEPRISM_DATA_DIR = dataDir;
const { importPaper } = await import('../src/services/projectHub/paperLibrary.js');
const { registerProjectHubRoutes } = await import('../src/routes/projectHub.js');
const doi = '10.1000/example';
const record = { DOI: doi, title: ['External study'], author: [{ given: 'Jane', family: 'Doe' }], issued: { 'date-parts': [[2024]] }, 'container-title': ['Journal'], type: 'journal-article', indexed: { 'date-time': '2025-01-01T00:00:00Z' } };
const response = (message = record) => Response.json({ status: 'ok', message });

async function project(id) {
  await mkdir(path.join(dataDir, id));
  await writeFile(path.join(dataDir, id, 'project.json'), JSON.stringify({ id, name: 'Lookup test' }));
}
async function snapshot(directory) {
  const files = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    files[entry.name] = entry.isDirectory() ? await snapshot(filename) : await readFile(filename, 'utf8');
  }
  return files;
}

test('DOI input rejects arbitrary hosts and query/credential injection before fetching', async () => {
  assert.equal(parseDoi(' DOI:10.1000/EXAMPLE '), doi);
  assert.equal(parseDoi('https://doi.org/10.1000%2FEXAMPLE'), doi);
  let calls = 0;
  const lookup = createDoiLookup({ fetchImpl: async () => { calls++; return response(); } });
  for (const value of [null, {}, '10.1/x', '10.1000/a\nb', '\ud800', 'https://127.0.0.1/10.1000/a', 'https://doi.org.evil.test/10.1000/a', 'https://user@doi.org/10.1000/a', 'https://doi.org/10.1000/a?x=1', 'https://doi.org/%broken']) {
    await assert.rejects(() => lookup(value), { code: 'INVALID_DOI', statusCode: 400 });
  }
  assert.equal(calls, 0);
});

test('lookup encodes one identifier and preserves provider metadata without claiming review', async () => {
  const lookup = createDoiLookup({ now: () => 1_800_000_000_000, fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.crossref.org/works/10.1000%2Fexample');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    assert.match(options.headers['User-Agent'], /SciencePrism/);
    return response();
  } });
  const result = await lookup(doi);
  assert.deepEqual(result.record, record);
  assert.deepEqual(result.candidate.authors, ['Jane Doe']);
  assert.equal(result.candidate.year, 2024);
  assert.equal(result.candidate.sourceRecords[0].externalVersion, record.indexed['date-time']);
  assert.equal(result.checks.source.status, 'identifier-matched');
  assert.equal(result.checks.source.scientificStatus, 'unverified');
  assert.equal(result.candidate.peerReviewed, null);
  assert.equal(result.writesPerformed, false);
});

test('wrong DOI, missing identity and malformed metadata never become a match', async () => {
  for (const message of [{ ...record, DOI: '10.1000/wrong' }, { title: ['No DOI'] }]) {
    await assert.rejects(() => createDoiLookup({ fetchImpl: async () => response(message) })(doi), { code: 'SOURCE_IDENTITY_MISMATCH' });
  }
  for (const payload of ['not json', '{"status":"ok","message":null}']) {
    await assert.rejects(() => createDoiLookup({ fetchImpl: async () => new Response(payload) })(doi), { code: 'SOURCE_INVALID_RESPONSE' });
  }
  const incomplete = await createDoiLookup({ fetchImpl: async () => response({ DOI: doi }) })(doi);
  assert.equal(incomplete.checks.fields.status, 'incomplete');
  assert.equal(incomplete.candidate.year, null);
});

test('404, provider errors, redirects and response limits have distinct failures', async () => {
  for (const [status, code] of [[404, 'SOURCE_NOT_FOUND'], [500, 'SOURCE_HTTP_ERROR'], [302, 'SOURCE_HTTP_ERROR']]) {
    await assert.rejects(() => createDoiLookup({ fetchImpl: async () => new Response('', { status }) })(doi), { code });
  }
  await assert.rejects(() => createDoiLookup({ fetchImpl: async () => new Response('a'.repeat(1024 * 1024 + 1)) })(doi), { code: 'SOURCE_RESPONSE_TOO_LARGE' });
  await assert.rejects(() => createDoiLookup({ fetchImpl: async () => { throw new TypeError('fetch failed'); } })(doi), { code: 'SOURCE_REQUEST_FAILED' });
});

test('429 cooldown obeys seconds and HTTP-date Retry-After without automatic retry', async () => {
  for (const header of ['5', new Date(1_800_000_005_000).toUTCString()]) {
    let clock = 1_800_000_000_000;
    let calls = 0;
    const lookup = createDoiLookup({ now: () => clock, fetchImpl: async () => { calls++; return calls === 1 ? new Response('', { status: 429, headers: { 'retry-after': header } }) : response(); } });
    await assert.rejects(() => lookup(doi), { code: 'SOURCE_RATE_LIMITED', retryAfter: 5 });
    clock += 4000;
    await assert.rejects(() => lookup(doi), { code: 'SOURCE_RATE_LIMITED', retryAfter: 1 });
    assert.equal(calls, 1);
    clock += 1000;
    assert.equal((await lookup(doi)).identifier, doi);
  }
});

test('concurrent calls and local pacing do not create a provider request queue', async () => {
  let release;
  let clock = 10000;
  const lookup = createDoiLookup({ now: () => clock, fetchImpl: () => new Promise((resolve) => { release = resolve; }) });
  const pending = lookup(doi);
  await assert.rejects(() => lookup(doi), { code: 'SOURCE_RATE_LIMITED' });
  release(response());
  await pending;
  await assert.rejects(() => lookup(doi), { code: 'SOURCE_RATE_LIMITED' });
});

test('timeout and cancellation abort the transport and release its slot', async () => {
  const lookup = createDoiLookup({ timeoutMs: 10, intervalMs: 0, fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) });
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await assert.rejects(() => lookup(doi), { code: 'SOURCE_TIMEOUT', statusCode: 504 });
    const controller = new AbortController();
    const pending = lookup(doi, { signal: controller.signal });
    controller.abort();
    await assert.rejects(() => pending, { code: 'SOURCE_CANCELLED' });
  } finally { clearInterval(keepAlive); }
});

test('real HTTP source lookup reports conflicts without touching library, tasks or Evidence', async (t) => {
  const id = 'readonly-http';
  await project(id);
  await importPaper(id, { doi, title: 'Human corrected title', authors: ['Human'], year: 2023, notes: 'Keep these notes', tags: ['reviewed'], favorite: true });
  const before = await snapshot(path.join(dataDir, id));
  const app = Fastify();
  t.after(() => app.close());
  registerProjectHubRoutes(app, { doiLookup: createDoiLookup({ fetchImpl: async () => response() }) });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const url = `http://127.0.0.1:${app.server.address().port}/api/projects/${id}/papers/source-lookup`;
  const call = (payload) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const result = await call({ doi });
  assert.equal(result.status, 200);
  const body = await result.json();
  assert.equal(body.lookup.matches.length, 1);
  assert.match(body.lookup.matches[0].revision, /^[a-f0-9]{64}$/);
  assert.ok(body.lookup.matches[0].conflicts.some((item) => item.field === 'title' && item.local === 'Human corrected title'));
  assert.equal(body.lookup.writesPerformed, false);
  const limited = await call({ doi });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) >= 1);
  assert.equal((await limited.json()).error.code, 'SOURCE_RATE_LIMITED');
  const invalid = await call({ doi: 'https://example.test' });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, 'INVALID_DOI');
  assert.deepEqual(await snapshot(path.join(dataDir, id)), before);
});
