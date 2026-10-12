import assert from 'node:assert/strict';
import test from 'node:test';
import { after } from 'node:test';
import { mkdir, mkdtemp, readFile, writeFile, rm, symlink, open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeIssn, normalizeRankingCatalog, normalizeRankingFilter, assertCompatibleCatalogs, parseRankingCsv, MAX_CATALOG_RECORDS } from '../src/services/paperRankings/validation.js';
import { applyPaperRankings } from '../src/services/paperRankings/index.js';
import { createPaperRankingRepository } from '../src/services/paperRankings/repository.js';
import { createPaperRankingsService } from '../src/services/paperRankings/index.js';
import { registerPaperRankingRoutes } from '../src/routes/paperRankings.js';
import Fastify from 'fastify';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Synthetic classifications. These records do not claim any real journal ranking.
const catalogInput = overrides => ({ expectedVersion: 0, scheme: 'JCR', editionYear: 2024, label: 'Synthetic test catalog',
  provenance: { label: 'Test fixture, not published rankings' },
  records: [{ venue: 'Example Journal', issns: ['0317-8471'], subject: 'Computing', rank: 'Q1' }], ...overrides });

test('ranking import validates source, scheme, edition, ranks and ISSN checksum without bundled data', () => {
  assert.equal(normalizeIssn('ISSN 0317-8471'), '0317-8471');
  assert.equal(normalizeIssn('1092003x'), '1092-003X');
  assert.equal(normalizeIssn('0317-8472'), null);
  assert.equal(normalizeIssn('0317----8471'), null);
  const value = normalizeRankingCatalog(catalogInput());
  assert.equal(value.records[0].subject, 'Computing'); assert.equal(value.provenance.label, 'Test fixture, not published rankings');
  for (const input of [null, catalogInput({ scheme: 'fake' }), catalogInput({ editionYear: '2024' }), catalogInput({ expectedVersion: -1 }),
    catalogInput({ provenance: { label: 'x', url: 'file:///private/catalog' } }), catalogInput({ records: [{ venue: 'x', subject: 'x', rank: 'A' }] }),
    catalogInput({ records: [{ venue: 'x', subject: 'x', rank: 'Q1', issns: ['0317-8472'] }] })]) {
    assert.throws(() => normalizeRankingCatalog(input), { code: 'RANKING_INVALID_INPUT' });
  }
});

test('ranking filters keep unknown behavior explicit and avoid mixing schemes', () => {
  assert.deepEqual(normalizeRankingFilter(), { scheme: null, editionYear: null, subject: null, ranks: [], unknown: 'include' });
  assert.deepEqual(normalizeRankingFilter({ scheme: 'JCR', ranks: ['q1'] }).ranks, ['Q1']);
  for (const filter of [{ ranks: ['Q1'] }, { scheme: false }, { scheme: 'JCR', ranks: ['A'] }, { editionYear: '2024' }, { unknown: 'best' }]) {
    assert.throws(() => normalizeRankingFilter(filter), { code: 'RANKING_INVALID_INPUT' });
  }
});

const catalog = (id, overrides = {}) => ({ ...normalizeRankingCatalog(catalogInput(overrides)), id, importedAt: '2026-10-12T00:00:00.000Z' });
test('ISSN wins over name; exact venue fallback never overrides disagreeing ISSNs or guesses abbreviations', () => {
  const catalogs = [catalog('jcr')];
  const papers = [
    { id: 'issn', venue: 'Different source spelling', issns: ['03178471'] },
    { id: 'venue', venue: ' EXAMPLE   JOURNAL ' },
    { id: 'different-issn', venue: 'Example Journal', issns: ['1092-003X'] },
    { id: 'abbreviation', venue: 'Ex. Journal' }, { id: 'missing' }
  ];
  const before = JSON.stringify({ papers, catalogs }); const result = applyPaperRankings(papers, catalogs);
  assert.deepEqual(result.candidates.map(p => p.rankings.length), [1, 1, 0, 0, 0]);
  assert.equal(result.candidates[0].rankings[0].matchedBy, 'issn'); assert.equal(result.candidates[1].rankings[0].matchedBy, 'venue');
  assert.equal(result.coverage.matched, 2); assert.equal(result.coverage.ratio, 0.4);
  assert.equal(result.coverage.unmatchedPapers[2].reason, 'missing-venue');
  assert.equal(JSON.stringify({ papers, catalogs }), before);
});

test('all editions and subjects remain visible; filters must match one actual ranking row', () => {
  const catalogs = [catalog('older', { editionYear: 2023 }), catalog('newer', { records: [
    { venue: 'Example Journal', issns: ['0317-8471'], subject: 'Computing', rank: 'Q2' },
    { venue: 'Example Journal', issns: ['0317-8471'], subject: 'Medicine', rank: 'Q1' }
  ] }), catalog('ccf', { scheme: 'CCF', records: [{ venue: 'Example Conference', subject: 'AI', rank: 'A' }] })];
  const papers = [{ id: 'known', venue: 'Example Journal', year: 2020 }, { id: 'unknown', venue: 'Unknown Journal' }];
  assert.equal(applyPaperRankings(papers, catalogs).candidates[0].rankings.length, 3);
  const result = applyPaperRankings(papers, catalogs, { scheme: 'JCR', editionYear: 2024, subject: 'Computing', ranks: ['Q1'], unknown: 'exclude' });
  assert.equal(result.candidates.length, 0); assert.equal(result.coverage.matched, 1);
  assert.equal(applyPaperRankings(papers, catalogs, { scheme: 'JCR', editionYear: 2023, ranks: ['Q1'], unknown: 'exclude' }).candidates[0].id, 'known');
  assert.deepEqual(applyPaperRankings(papers, catalogs, { unknown: 'only' }).candidates.map(p => p.id), ['unknown']);
  assert.equal(applyPaperRankings(papers, []).coverage.unmatchedPapers[0].reason, 'no-catalog');
});

test('a shared venue name with distinct ISSN identities remains unknown without a paper ISSN', () => {
  const catalogs = [catalog('same-name', { records: [
    { venue: 'Shared Journal Name', issns: ['0317-8471'], subject: 'Computing', rank: 'Q1' },
    { venue: 'Shared Journal Name', issns: ['1092-003X'], subject: 'Computing', rank: 'Q2' }
  ] })];
  const ambiguous = applyPaperRankings([{ id: 'ambiguous', venue: 'Shared Journal Name' }], catalogs);
  assert.equal(ambiguous.candidates[0].rankings.length, 0);
  assert.equal(ambiguous.candidates[0].rankingIssues[0].code, 'ambiguous-venue');
  assert.equal(ambiguous.coverage.unmatched, 1);
  assert.equal(ambiguous.coverage.unmatchedPapers[0].reason, 'ambiguous-venue');
  const exact = applyPaperRankings([{ id: 'exact', venue: 'Shared Journal Name', issns: ['0317-8471'] }], catalogs);
  assert.deepEqual(exact.candidates[0].rankings.map(rank => rank.rank), ['Q1']);
});

test('conflicts block competing ranks while preserving other years, subjects and different ISSNs', () => {
  const original = catalog('a');
  const changed = catalog('b', { records: [{ venue: 'Renamed', issns: ['0317-8471'], subject: 'Computing', rank: 'Q2' }] });
  assert.throws(() => assertCompatibleCatalogs([original, changed]), { code: 'RANKING_CATALOG_CONFLICT' });
  assert.doesNotThrow(() => assertCompatibleCatalogs([original, { ...changed, editionYear: 2025 }]));
  assert.doesNotThrow(() => assertCompatibleCatalogs([original, { ...changed, records: [{ ...changed.records[0], subject: 'Medicine' }] }]));
  assert.doesNotThrow(() => assertCompatibleCatalogs([{ ...original, supersededBy: 'b' }, changed]));
  const venueOnly = catalog('c', { records: [{ venue: 'Example Journal', subject: 'Computing', rank: 'Q2' }] });
  assert.throws(() => assertCompatibleCatalogs([original, venueOnly]), { code: 'RANKING_CATALOG_CONFLICT' });
  assert.doesNotThrow(() => assertCompatibleCatalogs([original, { ...venueOnly, records: [{ ...venueOnly.records[0], issns: ['1092-003X'] }] }]));
});

test('CSV keeps quoted commas, escaped quotes and multiline fields; malformed imports fail', () => {
  const csv = '\uFEFFvenue,issns,subject,rank\r\n"Example, ""Journal""",0317-8471;1092-003X,"Computer\nScience",Q1\r\n';
  const records = parseRankingCsv(csv); assert.equal(records.length, 1);
  assert.equal(records[0].venue, 'Example, "Journal"'); assert.deepEqual(records[0].issns, ['0317-8471', '1092-003X']);
  assert.equal(normalizeRankingCatalog(catalogInput({ records })).records[0].subject, 'Computer Science');
  for (const value of ['venue,subject,rank\nx,x,Q1', 'venue,issns,subject,rank\n"oops', 'venue,issns,subject,rank\n"x"oops,,x,Q1', 'venue,issns,subject,rank']) {
    assert.throws(() => parseRankingCsv(value), { code: 'RANKING_INVALID_INPUT' });
  }
});

const cache = fileURLToPath(new URL('../../../.cache/', import.meta.url));
await mkdir(cache, { recursive: true });
const fixture = await mkdtemp(path.join(cache, 'paper-rankings-'));
after(() => rm(fixture, { recursive: true, force: true }));
async function project(id) { const root = path.join(fixture, id); await mkdir(root, { recursive: true }); await writeFile(path.join(root, 'project.json'), JSON.stringify({ id })); return root; }
const repository = createPaperRankingRepository({ resolveProject: async id => {
  if (typeof id !== 'string' || !/^[a-z-]+$/.test(id)) throw new Error('Invalid project');
  const root = path.join(fixture, id); await readFile(path.join(root, 'project.json')); return root;
} });

test('project store imports atomically, retries idempotently, and retains replacement history', async () => {
  const root = await project('storage'); await project('other');
  assert.equal((await repository.read('storage')).version, 0);
  const first = await repository.importCatalog('storage', catalogInput());
  assert.equal(first.version, 1); assert.equal(first.duplicate, false);
  assert.equal((await repository.importCatalog('storage', catalogInput())).duplicate, true);
  assert.equal((await repository.read('storage')).catalogs.length, 1);
  assert.equal((await repository.read('other')).catalogs.length, 0);
  const replacement = catalogInput({ expectedVersion: 1, replaceCatalogId: first.catalog.id, records: [{ venue: 'Example Journal', issns: ['0317-8471'], subject: 'Computing', rank: 'Q2' }] });
  const changed = await repository.importCatalog('storage', replacement); const saved = await repository.read('storage');
  assert.equal(saved.version, 2); assert.equal(saved.catalogs[0].supersededBy, changed.catalog.id); assert.equal(saved.catalogs[0].records[0].rank, 'Q1');
  assert.equal(applyPaperRankings([{ id: 'p', venue: 'Example Journal' }], saved.catalogs).candidates[0].rankings[0].rank, 'Q2');
  assert.equal((await repository.importCatalog('storage', replacement)).duplicate, true);
  const bytes = await readFile(path.join(root, '.scienceprism/paper-rankings.json'), 'utf8');
  await assert.rejects(repository.importCatalog('storage', catalogInput({ expectedVersion: 2, label: 'Conflicting source' })), { code: 'RANKING_CATALOG_CONFLICT' });
  assert.equal(await readFile(path.join(root, '.scienceprism/paper-rankings.json'), 'utf8'), bytes);
});

test('concurrent imports claim one version and reject stale or cross-project replacement', async () => {
  await project('race'); await project('isolated');
  const attempts = await Promise.allSettled([repository.importCatalog('race', catalogInput()), repository.importCatalog('race', catalogInput({ editionYear: 2025 }))]);
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(attempts.find(result => result.status === 'rejected').reason.code, 'RANKING_VERSION_CONFLICT');
  const id = (await repository.read('race')).catalogs[0].id;
  const saved = await repository.read('race');
  await assert.rejects(repository.importCatalog('race', catalogInput({ expectedVersion: saved.version, replaceCatalogId: id, editionYear: saved.catalogs[0].editionYear + 1 })), { code: 'RANKING_INVALID_REPLACEMENT' });
  await assert.rejects(repository.importCatalog('isolated', catalogInput({ replaceCatalogId: id })), { code: 'RANKING_CATALOG_NOT_FOUND' });
  await assert.rejects(repository.read('missing'), { statusCode: 404 });
  await assert.rejects(repository.read('../storage'), { statusCode: 400 });
});

test('unsafe symlinks and corrupted or oversized storage never get overwritten', async () => {
  const root = await project('linked'); const outside = await project('external');
  await symlink(outside, path.join(root, '.scienceprism'));
  await assert.rejects(repository.importCatalog('linked', catalogInput()), { code: 'RANKING_UNSAFE_PATH' });
  await assert.rejects(readFile(path.join(outside, 'paper-rankings.json')), { code: 'ENOENT' });
  const broken = await project('broken'); await mkdir(path.join(broken, '.scienceprism')); const target = path.join(broken, '.scienceprism/paper-rankings.json');
  await writeFile(target, '{broken');
  await assert.rejects(repository.importCatalog('broken', catalogInput()), { code: 'RANKING_STORAGE_INVALID' });
  assert.equal(await readFile(target, 'utf8'), '{broken');
  const handle = await open(target, 'w'); await handle.truncate(64 * 1024 * 1024 + 1); await handle.close();
  await assert.rejects(repository.read('broken'), { code: 'RANKING_STORAGE_INVALID' });
  const leaf = await project('leaf-link'); await mkdir(path.join(leaf, '.scienceprism'));
  await symlink(path.join(outside, 'project.json'), path.join(leaf, '.scienceprism/paper-rankings.json'));
  await assert.rejects(repository.read('leaf-link'), { code: 'RANKING_UNSAFE_PATH' });
});

test('bounded catalog records and stored checksums reject truncation or tampering', async () => {
  const sample = catalogInput().records[0];
  assert.throws(() => normalizeRankingCatalog(catalogInput({ records: Array(MAX_CATALOG_RECORDS + 1).fill(sample) })), { code: 'RANKING_INVALID_INPUT' });
  const root = await project('tampered'); await repository.importCatalog('tampered', catalogInput());
  const target = path.join(root, '.scienceprism/paper-rankings.json'); const index = JSON.parse(await readFile(target, 'utf8'));
  index.catalogs[0].records[0].rank = 'Q2'; const changed = JSON.stringify(index); await writeFile(target, changed);
  await assert.rejects(repository.read('tampered'), { code: 'RANKING_STORAGE_INVALID' });
  await assert.rejects(repository.importCatalog('tampered', catalogInput({ expectedVersion: 1 })), { code: 'RANKING_STORAGE_INVALID' });
  assert.equal(await readFile(target, 'utf8'), changed);
});

test('HTTP imports JSON/CSV, lists provenance, pages historical records and reports matching coverage', async t => {
  await project('http'); await project('http-other');
  const app = Fastify(); registerPaperRankingRoutes(app, { service: createPaperRankingsService({ repository }) }); t.after(() => app.close());
  const base = '/api/projects/http/paper-rankings';
  const empty = await app.inject(base); assert.equal(empty.statusCode, 200); assert.deepEqual(empty.json().catalogs, []);
  const imported = await app.inject({ method: 'POST', url: base, payload: catalogInput() });
  assert.equal(imported.statusCode, 201); const id = imported.json().catalog.id;
  assert.equal(imported.json().catalog.recordCount, 1); assert.equal(imported.json().catalog.records, undefined);
  assert.equal((await app.inject({ method: 'POST', url: base, payload: catalogInput() })).statusCode, 200);
  const page = await app.inject(`${base}/${id}?limit=1`); assert.equal(page.json().records[0].rank, 'Q1');
  assert.equal(page.json().catalog.provenance.label, 'Test fixture, not published rankings');
  assert.equal((await app.inject(`/api/projects/http-other/paper-rankings/${id}`)).statusCode, 404);
  const match = await app.inject({ method: 'POST', url: `${base}/match`, payload: { candidates: [{ id: 'yes', venue: 'Example Journal' }, { id: 'no' }], filters: { unknown: 'exclude' } } });
  assert.equal(match.statusCode, 200); assert.equal(match.json().candidates.length, 1); assert.equal(match.json().coverage.ratio, 0.5);
  const { records, ...metadata } = catalogInput({ scheme: 'CCF', expectedVersion: 1 });
  const csv = await app.inject({ method: 'POST', url: base, payload: { ...metadata, csv: 'venue,issns,subject,rank\nExample Conference,,AI,A' } });
  assert.equal(csv.statusCode, 201); assert.equal(csv.json().version, 2);
  for (const query of ['?limit=0', '?offset=1x', '?limit=2&limit=3', '?unknown=1']) assert.equal((await app.inject(`${base}/${id}${query}`)).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: `${base}/match`, payload: { candidates: [], filters: { ranks: ['Q1'] } } })).statusCode, 400);
  assert.equal((await app.inject('/api/projects/missing/paper-rankings')).statusCode, 404);
});

test('default HTTP service uses real project validation and persists only that project', async () => {
  const root = await project('real-default');
  const script = `import assert from 'node:assert/strict'; import Fastify from 'fastify';
    import {registerPaperRankingRoutes} from './apps/backend/src/routes/paperRankings.js';
    const app=Fastify(); registerPaperRankingRoutes(app);
    try {
      const created=await app.inject({method:'POST',url:'/api/projects/real-default/paper-rankings',payload:${JSON.stringify(catalogInput())}});
      assert.equal(created.statusCode,201,created.body);
      assert.equal((await app.inject('/api/projects/missing/paper-rankings')).statusCode,404);
      assert.equal((await app.inject('/api/projects/%2E%2E%2Fexternal/paper-rankings')).statusCode,400);
      console.log(JSON.stringify({status:created.statusCode,version:created.json().version}));
    } finally {await app.close();}`;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
    cwd: fileURLToPath(new URL('../../../', import.meta.url)), env: { ...process.env, SCIENCEPRISM_DATA_DIR: fixture }, timeout: 10000
  });
  assert.deepEqual(JSON.parse(stdout), { status: 201, version: 1 });
  assert.equal(JSON.parse(await readFile(path.join(root, '.scienceprism/paper-rankings.json'))).projectId, 'real-default');
});
