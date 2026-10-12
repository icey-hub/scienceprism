import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Fastify from 'fastify';

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'paper-search-'));
process.env.SCIENCEPRISM_DATA_DIR = dataDir;
const { searchProjectPapers, loadPaperSearches, normalizeSearchInput } = await import('../src/services/paperSearch.js');
const { registerPaperSearchRoutes } = await import('../src/routes/paperSearch.js');
async function project(id) {
  await mkdir(path.join(dataDir, id), { recursive: true });
  await writeFile(path.join(dataDir, id, 'project.json'), JSON.stringify({ id, name: 'Empty research project' }));
}
const candidate = index => ({ id: `paper-${index}`, title: `Paper ${index}`, source: 'arxiv', sourceRecord: { provider: 'arxiv', id: `paper-${index}` } });

test('empty project searches without manuscripts, stores history and pages with a lookahead', async () => {
  await project('empty'); await project('other');
  let observed;
  const search = async input => { observed = input; return { batches: [{ candidates: Array.from({ length: 3 }, (_, i) => candidate(i)) }], failures: [] }; };
  const session = await searchProjectPapers('empty', { query: '  retrieval  ', pageSize: 2, offset: 4 }, { search });
  assert.equal(observed.queries[0], 'retrieval');
  assert.equal(observed.offset, 4); assert.equal(observed.maxResults, 3);
  assert.equal(session.candidates.length, 2); assert.equal(session.nextOffset, 6);
  assert.equal(session.status, 'completed');
  assert.deepEqual((await loadPaperSearches('empty')).sessions[0], session);
  assert.equal((await loadPaperSearches('other')).sessions.length, 0);
  await assert.rejects(readFile(path.join(dataDir, 'empty', 'main.tex')), { code: 'ENOENT' });
});

test('failed providers remain distinguishable from an empty successful result', async () => {
  await project('failures');
  const failure = { source: 'arxiv', code: 'SOURCE_TIMEOUT', message: 'Timed out', retryable: true };
  const session = await searchProjectPapers('failures', { query: 'retrieval' }, { search: async () => ({ batches: [], failures: [failure] }) });
  assert.equal(session.status, 'failed'); assert.deepEqual(session.failures, [failure]);
  const partial = await searchProjectPapers('failures', { query: 'retrieval' }, { search: async () => ({ batches: [{ candidates: [candidate(1)] }], failures: [failure] }) });
  assert.equal(partial.status, 'partial'); assert.equal(partial.candidates.length, 1);
});

test('cancelled search does not persist late provider results', async () => {
  await project('cancel');
  const controller = new AbortController();
  await assert.rejects(searchProjectPapers('cancel', { query: 'retrieval' }, { signal: controller.signal, search: async () => {
    controller.abort(); return { batches: [{ candidates: [candidate(1)] }], failures: [] };
  } }), { name: 'AbortError' });
  assert.deepEqual((await loadPaperSearches('cancel')).sessions, []);
});

test('invalid input and unknown projects never contact providers', async () => {
  for (const input of [null, [], {}, { query: 'x', sources: ['missing'] }, { query: 'x', pageSize: 0 }, { query: 'x', offset: -1 }]) {
    assert.throws(() => normalizeSearchInput(input), { code: 'INVALID_SEARCH' });
  }
  let calls = 0;
  await assert.rejects(searchProjectPapers('missing', { query: 'x' }, { search: async () => { calls++; } }));
  assert.equal(calls, 0);
});

test('HTTP search returns actionable validation and persistent project-scoped sessions', async t => {
  await project('http');
  const app = Fastify(); t.after(() => app.close());
  registerPaperSearchRoutes(app, { search: async () => ({ batches: [{ candidates: [candidate(1)] }], failures: [] }) });
  const invalid = await app.inject({ method: 'POST', url: '/api/projects/http/paper-search', payload: { query: '' } });
  assert.equal(invalid.statusCode, 400); assert.equal(invalid.json().error.code, 'INVALID_SEARCH');
  const result = await app.inject({ method: 'POST', url: '/api/projects/http/paper-search', payload: { query: 'retrieval' } });
  assert.equal(result.statusCode, 200); assert.equal(result.json().session.candidates.length, 1);
  const history = await app.inject('/api/projects/http/paper-search');
  assert.equal(history.json().sessions[0].id, result.json().session.id);
  assert.equal(history.json().projectName, 'Empty research project');
  assert.equal((await app.inject('/api/projects/missing/paper-search')).statusCode, 404);
});

test('batch filtering keeps pagination based on fetched records and does not call missing metadata a match', async () => {
  await project('filters');
  const session = await searchProjectPapers('filters', { query: 'x', pageSize: 2, filters: { yearFrom: 2024, openAccessOnly: true } }, { search: async () => ({
    batches: [{ source: 'arxiv', candidates: [{ ...candidate(1), year: 2024, isOpenAccess: true }, { ...candidate(2), year: null }, { ...candidate(3), year: 2025, isOpenAccess: true }] }], failures: []
  }) });
  assert.equal(session.candidates.length, 1); assert.equal(session.nextOffset, 2);
  assert.equal(session.sourceResults[0].filterMode, 'batch'); assert.equal(session.sourceResults[0].total, null);
  for (const filters of [{ yearFrom: 2025, yearTo: 2020 }, { yearFrom: '2024' }, { hidden: true }, { publicationType: 'unknown' }]) assert.throws(() => normalizeSearchInput({ query: 'x', filters }), { code: 'INVALID_SEARCH' });
});
