import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { createArxivLookup, parseArxiv } from '../src/services/researchSources/arxivLookup.js';
import { createArxivClient } from '../src/services/researchSources/arxivClient.js';
import { ResearchSourceError } from '../src/services/researchSources/sourceAdapter.js';

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'scienceprism-arxiv-lookup-'));
process.env.SCIENCEPRISM_DATA_DIR = dataDir;
const { importPaper } = await import('../src/services/projectHub/paperLibrary.js');
const { registerProjectHubRoutes } = await import('../src/routes/projectHub.js');
const entry = { id: 'http://arxiv.org/abs/1706.03762v1', title: 'Attention Is All You Need', author: [{ name: 'An Author' }], published: '2017-06-12T17:57:34Z', updated: '2017-06-12T17:57:34Z', summary: 'An abstract.' };

async function snapshot(directory) {
  const files = {};
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, item.name);
    files[item.name] = item.isDirectory() ? await snapshot(filename) : await readFile(filename, 'utf8');
  }
  return files;
}

test('arXiv identifiers accept modern and legacy versions and reject arbitrary locations', async () => {
  for (const value of ['1706.03762v1', ' https://arxiv.org/abs/1706.03762v1 ', 'https://arxiv.org/pdf/1706.03762v1.pdf']) {
    assert.deepEqual(parseArxiv(value), { arxivId: '1706.03762', version: 'v1', identifier: '1706.03762v1' });
  }
  assert.equal(parseArxiv('https://export.arxiv.org/abs/hep-th/9901001v2').identifier, 'hep-th/9901001v2');
  assert.equal(parseArxiv('math.GT/0309136v1').identifier, 'math.gt/0309136v1');
  assert.equal(parseArxiv('0704.0001').version, null);
  let calls = 0;
  const lookup = createArxivLookup({ query: async () => { calls++; return [entry]; } });
  for (const value of [null, {}, '', '1706.03762v0', '1706.03762v01', '1706.03762v-1', '1706.03762,1706.03763', '1706.03762\n', '\ud800', 'https://evil.test/abs/1706.03762', 'https://arxiv.org.evil.test/abs/1706.03762', 'https://user@arxiv.org/abs/1706.03762', 'https://arxiv.org:123/abs/1706.03762', 'https://arxiv.org/abs/1706.03762?q=1', 'https://arxiv.org/abs/1706.03762#x', 'https://arxiv.org/api/query', 'https://arxiv.org/abs/%31%37%30%36.03762']) {
    await assert.rejects(() => lookup(value), { code: 'INVALID_ARXIV_ID', statusCode: 400 });
  }
  assert.equal(calls, 0);
});

test('lookup retains exact provider record, requested and returned versions without scientific approval', async () => {
  const signal = new AbortController().signal;
  const lookup = createArxivLookup({ now: () => 1_800_000_000_000, query: async (parameters, options) => {
    assert.equal(options.signal, signal);
    assert.deepEqual(parameters, { id_list: '1706.03762v1', start: 0, max_results: 1 });
    return [entry];
  } });
  const result = await lookup('https://arxiv.org/abs/1706.03762v1', { signal });
  assert.deepEqual(result.record, entry);
  assert.equal(result.requestedVersion, 'v1');
  assert.equal(result.externalVersion, 'v1');
  assert.equal(result.candidate.sourceRecords[0].id, '1706.03762v1');
  assert.equal(result.candidate.sourceRecords[0].externalVersion, 'v1');
  assert.equal(result.candidate.sourceRecords[0].retrievedAt, result.retrievedAt);
  assert.equal(result.candidate.year, 2017);
  assert.equal(result.candidate.peerReviewed, null);
  assert.equal(result.checks.source.scientificStatus, 'unverified');
  assert.equal(result.writesPerformed, false);
  assert.equal(result.requiresDecision, true);
});

test('unversioned and legacy queries accept the returned version and preserve incomplete fields', async () => {
  for (const id of ['1706.03762', 'hep-th/9901001', 'math.GT/0309136']) {
    const record = { id: `http://arxiv.org/abs/${id}v3`, title: '', author: [], published: '' };
    const result = await createArxivLookup({ query: async () => [record] })(id);
    assert.equal(result.requestedVersion, null);
    assert.equal(result.externalVersion, 'v3');
    assert.equal(result.identifier, id.toLowerCase());
    assert.equal(result.candidate.url, `https://arxiv.org/abs/${id.toLowerCase()}v3`);
    assert.deepEqual(result.checks.fields, { status: 'incomplete', issues: ['missing-title', 'missing-authors', 'missing-year'] });
  }
});

test('missing identity, wrong paper, wrong version and extra results cannot pass source matching', async () => {
  for (const id of [undefined, 'http://arxiv.org/abs/1706.03763v1', 'http://arxiv.org/abs/1706.03762v2', 'http://arxiv.org/abs/1706.03762', 'https://evil.test/abs/1706.03762v1']) {
    await assert.rejects(() => createArxivLookup({ query: async () => [{ ...entry, id }] })('1706.03762v1'), { code: 'SOURCE_IDENTITY_MISMATCH', statusCode: 502 });
  }
  await assert.rejects(() => createArxivLookup({ query: async () => [entry, entry] })('1706.03762'), { code: 'SOURCE_IDENTITY_MISMATCH' });
  await assert.rejects(() => createArxivLookup({ query: async () => [] })('1706.03762'), { code: 'SOURCE_NOT_FOUND', statusCode: 404 });
  await assert.rejects(() => createArxivLookup({ query: async () => null })('1706.03762'), { code: 'SOURCE_INVALID_RESPONSE', statusCode: 502 });
});

test('shared transport failures retain stable HTTP error codes', async () => {
  for (const [code, statusCode] of Object.entries({ SOURCE_RATE_LIMITED: 429, SOURCE_BUSY: 503, SOURCE_TIMEOUT: 504, SOURCE_CANCELLED: 499, SOURCE_INVALID_RESPONSE: 502, SOURCE_HTTP_ERROR: 502 })) {
    await assert.rejects(() => createArxivLookup({ query: async () => { throw new ResearchSourceError('Provider failure', { code }); } })('1706.03762'), { code, statusCode });
  }
});

test('real HTTP reports legacy version conflicts, rejects ambiguous input and leaves all project data unchanged', async (t) => {
  const id = 'arxiv-readonly';
  await mkdir(path.join(dataDir, id));
  await writeFile(path.join(dataDir, id, 'project.json'), JSON.stringify({ id, name: 'Read-only lookup' }));
  const imported = await importPaper(id, { arxivId: '1706.03762v1', source: 'arxiv', title: 'Human correction', notes: 'Keep notes', favorite: true, tags: ['human'], annotations: [{ text: 'Keep annotation' }] });
  const before = await snapshot(path.join(dataDir, id));
  let providerCalls = 0;
  const query = createArxivClient({ intervalMs: 0, fetchImpl: async (url, options) => {
    providerCalls++;
    assert.equal(new URL(url).origin, 'https://export.arxiv.org');
    assert.equal(new URL(url).searchParams.get('id_list'), '1706.03762v2');
    assert.equal(options.redirect, 'error');
    return new Response('<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>http://arxiv.org/abs/1706.03762v2</id><title>External &amp; title</title><author><name>Author</name></author><published>2017-06-12T17:57:34Z</published></entry></feed>');
  } });
  const app = Fastify();
  t.after(() => app.close());
  registerProjectHubRoutes(app, { arxivLookup: createArxivLookup({ query }) });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const url = `http://127.0.0.1:${app.server.address().port}/api/projects/${id}/papers/source-lookup`;
  const call = (body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const response = await call({ arxivId: '1706.03762v2' });
  assert.equal(response.status, 200);
  const { lookup } = await response.json();
  assert.equal(lookup.candidate.title, 'External & title');
  assert.equal(lookup.matches[0].paperId, imported.paper.id);
  assert.match(lookup.matches[0].revision, /^[a-f0-9]{64}$/);
  assert.ok(lookup.matches[0].conflicts.some((conflict) => conflict.field === 'title' && conflict.local === 'Human correction'));
  assert.deepEqual(lookup.matches[0].conflicts.find((conflict) => conflict.field === 'externalVersion'), { field: 'externalVersion', local: ['v1'], external: 'v2' });
  for (const payload of [{}, { doi: '10.1000/x', arxivId: '1706.03762' }, { doi: '', arxivId: '1706.03762' }, { arxivId: null }, { arxivId: 'https://example.test' }]) {
    assert.equal((await call(payload)).status, 400);
  }
  assert.equal(providerCalls, 1);
  assert.equal(lookup.writesPerformed, false);
  assert.deepEqual(await snapshot(path.join(dataDir, id)), before);
});
