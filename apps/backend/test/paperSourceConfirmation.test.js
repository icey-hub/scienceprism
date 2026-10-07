import assert from 'node:assert/strict';
import { mkdir, writeFile, readdir, readFile, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Fastify from 'fastify';

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'scienceprism-source-confirm-'));
process.env.SCIENCEPRISM_DATA_DIR = dataDir;
const { createSourceConfirmations } = await import('../src/services/projectHub/paperSourceConfirmation.js');
const { lookupPaperSource } = await import('../src/services/projectHub/paperSourceLookup.js');
const { importPaper, listPapers, updatePaper, getPaper } = await import('../src/services/projectHub/paperLibrary.js');
const { getEvidence } = await import('../src/services/evidenceLedger/index.js');
const { registerProjectHubRoutes } = await import('../src/routes/projectHub.js');

async function project(id) {
  await mkdir(path.join(dataDir, id), { recursive: true });
  await writeFile(path.join(dataDir, id, 'project.json'), JSON.stringify({ id, name: id }));
}
async function snapshot(id) {
  const root = path.join(dataDir, id);
  const files = (await readdir(root, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile());
  return Promise.all(files.map(async (entry) => [path.relative(root, path.join(entry.parentPath, entry.name)), await readFile(path.join(entry.parentPath, entry.name), 'utf8')]));
}
function record(provider = 'crossref') {
  const arxiv = provider === 'arxiv';
  const identifier = arxiv ? '1706.03762' : '10.1000/trace';
  const retrievedAt = '2026-10-04T00:00:00.000Z';
  return {
    provider, identifier, retrievedAt, externalVersion: arxiv ? 'v7' : null,
    candidate: { title: 'Provider title', authors: ['A Researcher'], year: 2017, venue: arxiv ? 'arXiv' : 'Journal',
      url: arxiv ? `https://arxiv.org/abs/${identifier}v7` : `https://doi.org/${identifier}`,
      [arxiv ? 'arxivId' : 'doi']: identifier, source: provider,
      sourceRecords: [{ provider, id: arxiv ? `${identifier}v7` : identifier, retrievedAt, externalVersion: arxiv ? 'v7' : 'indexed-date' }] },
    record: { id: identifier, title: 'Provider title', unknownField: ['retained'] },
    checks: { source: { status: 'identifier-matched', scientificStatus: 'unverified' } }, matches: []
  };
}
async function preview(id, confirmations, provider = 'crossref') {
  return lookupPaperSource(id, provider === 'arxiv' ? { arxivId: '1706.03762' } : { doi: '10.1000/trace' }, { confirmations, lookup: async () => record(provider) });
}
const decide = (p, action = 'create', paperId = null, fields = []) => ({ previewToken: p.previewToken, action, paperId, fields });

test('confirmation saves the server snapshot once, including original record, version and pending Evidence', async () => {
  const id = 'source-snapshot'; await project(id);
  const confirmations = createSourceConfirmations();
  const before = await snapshot(id);
  const p = await preview(id, confirmations, 'arxiv');
  assert.deepEqual(await snapshot(id), before);
  p.candidate.title = 'Client mutation'; p.record.title = 'Forged';
  const saved = await confirmations.confirm(id, decide(p), { actor: 'reviewer' });
  assert.equal(saved.paper.title, 'Provider title');
  const review = saved.paper.sourceReviews[0];
  assert.equal(review.record.title, 'Provider title');
  assert.equal(review.externalVersion, 'v7');
  assert.equal(review.decision.actor, 'reviewer');
  assert.equal(review.checks.source.scientificStatus, 'unverified');
  assert.equal((await getEvidence(id, saved.paper.evidenceId)).verificationStatus, 'pending');
  assert.deepEqual((await getPaper(id, saved.paper.id)).sourceReviews, saved.paper.sourceReviews);
  const after = await snapshot(id);
  await assert.rejects(() => confirmations.confirm(id, decide(p)), { code: 'SOURCE_PREVIEW_EXPIRED' });
  assert.deepEqual(await snapshot(id), after);
});

test('selected fields merge into a dual-identity record and preserve human work and review receipts', async () => {
  const id = 'source-merge'; await project(id);
  const { paper: original } = await importPaper(id, { title: 'Human title', authors: ['Human Author'], doi: '10.1000/trace', arxivId: '1706.03762v1',
    notes: 'notes', tags: ['kept'], favorite: true, annotations: [{ text: 'annotation' }], bibtex: '@misc{human,title={Human title}}' });
  const confirmations = createSourceConfirmations();
  const p = await preview(id, confirmations);
  const { paper } = await confirmations.confirm(id, decide(p, 'merge', original.id, ['title']));
  assert.equal(paper.id, original.id); assert.equal(paper.evidenceId, original.evidenceId);
  assert.equal(paper.title, 'Provider title');
  for (const field of ['authors', 'notes', 'tags', 'favorite', 'annotations', 'bibtex', 'arxivId']) assert.deepEqual(paper[field], original[field]);
  assert.equal((await listPapers(id)).length, 1);
  const next = await preview(id, confirmations, 'arxiv');
  const reviewed = await confirmations.confirm(id, decide(next, 'merge', original.id));
  assert.equal(reviewed.paper.sourceReviews.length, 2);
  assert.equal(reviewed.paper.url, paper.url);
  const forged = [{ id: 'forged', checks: { source: { scientificStatus: 'verified' } } }];
  const edited = await updatePaper(id, original.id, { notes: 'edited', sourceReviews: forged });
  assert.deepEqual(edited.paper.sourceReviews, reviewed.paper.sourceReviews);
  const reimported = await importPaper(id, { arxivId: original.arxivId, sourceReviews: forged });
  assert.deepEqual(reimported.paper.sourceReviews, reviewed.paper.sourceReviews);
});

test('keep, invalid decisions and cross-project tokens never write', async () => {
  const id = 'source-invalid'; await project(id); await project('source-other');
  const confirmations = createSourceConfirmations();
  const p = await preview(id, confirmations);
  const before = await snapshot(id);
  for (const request of [
    { ...decide(p), candidate: { title: 'forged' } }, { ...decide(p), actor: 'forged' },
    decide(p, 'merge', 'unknown', ['title']), decide(p, 'create', null, ['notes']),
    decide(p, 'create', 'unknown'), decide(p, 'replace'), { ...decide(p), fields: ['title', 'title'] }
  ]) await assert.rejects(() => confirmations.confirm(id, request), { code: 'INVALID_SOURCE_DECISION' });
  await assert.rejects(() => confirmations.confirm('source-other', decide(p)), { code: 'SOURCE_PREVIEW_EXPIRED' });
  assert.equal((await confirmations.confirm(id, decide(p, 'keep'))).writesPerformed, false);
  assert.deepEqual(await snapshot(id), before);
  assert.deepEqual(await readdir(path.join(dataDir, 'source-other')), ['project.json']);
  const forged = await importPaper(id, { title: 'Raw', sourceReviews: [{ id: 'forged' }] });
  assert.equal(forged.paper.sourceReviews, undefined);
});

test('stale edits and newly introduced secondary-identity duplicates are rejected under the writer lock', async () => {
  const id = 'source-stale'; await project(id);
  const confirmations = createSourceConfirmations();
  const p = await preview(id, confirmations);
  const { paper } = await importPaper(id, { title: 'Concurrent import', doi: '10.1000/trace', arxivId: '1706.03762' });
  let before = await snapshot(id);
  await assert.rejects(() => confirmations.confirm(id, decide(p)), { code: 'IMPORT_PREVIEW_STALE' });
  assert.deepEqual(await snapshot(id), before);
  const next = await preview(id, confirmations);
  await updatePaper(id, paper.id, { notes: 'Concurrent notes' });
  before = await snapshot(id);
  await assert.rejects(() => confirmations.confirm(id, decide(next, 'merge', paper.id, ['title'])), { code: 'IMPORT_PREVIEW_STALE' });
  assert.deepEqual(await snapshot(id), before);
});

test('concurrent tokens cannot create duplicates and the same token has one in-flight writer', async () => {
  const id = 'source-concurrency'; await project(id);
  const confirmations = createSourceConfirmations();
  const p = await preview(id, confirmations), other = await preview(id, confirmations);
  const results = await Promise.allSettled([confirmations.confirm(id, decide(p)), confirmations.confirm(id, decide(p)), confirmations.confirm(id, decide(other))]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.deepEqual(new Set(results.filter((r) => r.status === 'rejected').map((r) => r.reason.code)), new Set(['SOURCE_CONFIRMATION_PENDING', 'IMPORT_PREVIEW_STALE']));
  assert.equal((await listPapers(id)).length, 1);
});

test('snapshot expiry, entry/byte eviction and restart require a fresh preview', async () => {
  let clock = 0;
  const confirmations = createSourceConfirmations({ now: () => clock, ttlMs: 100, maxEntries: 1 });
  const first = confirmations.remember('p', record());
  const second = confirmations.remember('p', record());
  await assert.rejects(() => confirmations.confirm('p', decide(first, 'keep')), { code: 'SOURCE_PREVIEW_EXPIRED' });
  clock = 100;
  await assert.rejects(() => confirmations.confirm('p', decide(second, 'keep')), { code: 'SOURCE_PREVIEW_EXPIRED' });
  const fresh = confirmations.remember('p', record());
  await assert.rejects(() => createSourceConfirmations().confirm('p', decide(fresh, 'keep')), { code: 'SOURCE_PREVIEW_EXPIRED' });
  assert.throws(() => createSourceConfirmations({ maxBytes: 10 }).remember('p', record()), { code: 'SOURCE_PREVIEW_TOO_LARGE' });
  const byteCache = createSourceConfirmations({ maxBytes: Buffer.byteLength(JSON.stringify(record())) + 1 });
  const evicted = byteCache.remember('p', record()); byteCache.remember('p', record());
  await assert.rejects(() => byteCache.confirm('p', decide(evicted, 'keep')), { code: 'SOURCE_PREVIEW_EXPIRED' });
});

test('failed pre-write save permits retry and pending entries cannot be evicted', async () => {
  let rejectSave;
  let calls = 0;
  const confirmations = createSourceConfirmations({ maxEntries: 1, save: async () => {
    if (++calls === 1) await new Promise((resolve, reject) => { rejectSave = reject; });
    return { paper: { id: 'saved' } };
  } });
  const p = confirmations.remember('p', record());
  const saving = confirmations.confirm('p', decide(p));
  assert.throws(() => confirmations.remember('p', record()), { code: 'SOURCE_PREVIEW_BUSY' });
  rejectSave(new Error('disk unavailable'));
  await assert.rejects(saving, /disk unavailable/);
  assert.equal((await confirmations.confirm('p', decide(p))).paper.id, 'saved');
});

test('real HTTP source preview/confirm route preserves server snapshot and structured errors', async (t) => {
  const id = 'source-http'; await project(id);
  let providerCalls = 0;
  const app = Fastify(); t.after(() => app.close());
  registerProjectHubRoutes(app, { confirmations: createSourceConfirmations(), doiLookup: async () => { providerCalls++; return record(); } });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  async function post(endpoint, body) {
    const response = await fetch(`${address}/api/projects/${id}/papers/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  const p = (await post('source-lookup', { doi: '10.1000/trace' })).body.lookup;
  assert.equal((await post('source-confirm', { ...decide(p), record: 'forged' })).status, 400);
  const saved = await post('source-confirm', decide(p));
  assert.equal(saved.status, 200); assert.equal(saved.body.result.paper.sourceReviews[0].record.title, 'Provider title');
  assert.equal(providerCalls, 1);
  const replay = await post('source-confirm', decide(p));
  assert.equal(replay.status, 409); assert.equal(replay.body.error.code, 'SOURCE_PREVIEW_EXPIRED');
});
