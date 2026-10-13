import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createArxivClient } from '../src/services/researchSources/arxivClient.js';
import { HarnessRuntimeError } from '../src/services/harnessRuntime/errors.js';

const cache = fileURLToPath(new URL('../../../.cache/research-workbench-v2/search-policy/', import.meta.url));
await mkdir(cache, { recursive: true });
const data = await mkdtemp(path.join(cache, 'test-'));
process.env.SCIENCEPRISM_DATA_DIR = data;
const { createOpenAlexAdapter } = await import('../src/services/researchSources/openAlexAdapter.js');
const { searchProjectPapers, loadPaperSearches } = await import('../src/services/paperSearch.js');
const { registerResearchSourceAdapter } = await import('../src/services/researchSources/index.js');
const work = n => ({ id: `https://openalex.org/W${n}`, title: `Paper ${n}`, publication_year: 2024 });
const denied = () => new HarnessRuntimeError(403, 'CAPABILITY_DENIED', 'Search was revoked.');
test.after(() => rm(data, { recursive: true, force: true }));
async function project(id) {
  await mkdir(path.join(data, id));
  await writeFile(path.join(data, id, 'project.json'), JSON.stringify({ id, name: id }));
}

test('arXiv rechecks authorization after its request queue, before any fetch', async () => {
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  let fetches = 0, allowed = true;
  const query = createArxivClient({ intervalMs: 0, fetchImpl: async () => {
    fetches++;
    return new Response(new ReadableStream({ start(controller) {
      release = () => { controller.enqueue(new TextEncoder().encode('<feed xmlns="http://www.w3.org/2005/Atom"></feed>')); controller.close(); };
      entered();
    } }));
  } });
  const first = query({ search_query: 'first' });
  await ready;
  const reason = denied();
  const second = query({ search_query: 'second' }, { beforeRequest: async request => {
    assert.equal(request.source, 'arxiv');
    assert.equal(new URL(request.url).origin, 'https://export.arxiv.org');
    if (!allowed) throw reason;
  } });
  allowed = false; release();
  await first;
  await assert.rejects(second, error => error === reason);
  assert.equal(fetches, 1);
});

test('OpenAlex checks every upstream page and authorization errors survive service wrappers', async () => {
  await project('revoked-pages');
  let fetches = 0, checks = 0;
  const reason = denied();
  registerResearchSourceAdapter(createOpenAlexAdapter({ apiKey: () => '', fetchImpl: async () => {
    fetches++;
    return Response.json({ meta: { count: 210 }, results: Array.from({ length: 100 }, (_, i) => work(i)) });
  } }));
  await assert.rejects(searchProjectPapers('revoked-pages', { query: 'study', sources: ['openalex'], offset: 90, pageSize: 20 }, {
    beforeRequest: async request => {
      checks++;
      assert.equal(request.source, 'openalex');
      assert.equal(new URL(request.url).pathname, '/works');
      if (checks === 2) throw reason;
    }
  }), error => error === reason);
  assert.equal(checks, 2); assert.equal(fetches, 1);
  assert.deepEqual((await loadPaperSearches('revoked-pages')).sessions, []);
});

test('policy revocation just before history write leaves no saved search session', async () => {
  await project('revoked-persist');
  const reason = denied(); let persistenceChecks = 0;
  await assert.rejects(searchProjectPapers('revoked-persist', { query: 'study' }, {
    search: async () => ({ batches: [{ source: 'arxiv', candidates: [{ id: 'one', title: 'Study' }] }], failures: [] }),
    beforePersist: async () => { persistenceChecks++; throw reason; }
  }), error => error === reason);
  assert.equal(persistenceChecks, 1);
  assert.deepEqual((await loadPaperSearches('revoked-persist')).sessions, []);
});

test('authorized source requests save the same filtered provenance in shared history', async () => {
  await project('allowed');
  let requested = 0, persisted = 0;
  registerResearchSourceAdapter(createOpenAlexAdapter({ apiKey: () => '', fetchImpl: async () => Response.json({ meta: { count: 1 }, results: [work(1)] }) }));
  const session = await searchProjectPapers('allowed', { query: 'study', sources: ['openalex'], filters: { yearFrom: 2024 } }, {
    beforeRequest: async () => { requested++; }, beforePersist: async () => { persisted++; }
  });
  assert.equal(requested, 1); assert.equal(persisted, 1);
  assert.equal(session.status, 'completed'); assert.equal(session.candidates[0].year, 2024);
  assert.equal(session.candidates[0].sourceRecords[0].searchSessionId, session.id);
  assert.deepEqual((await loadPaperSearches('allowed')).sessions[0], session);
});
