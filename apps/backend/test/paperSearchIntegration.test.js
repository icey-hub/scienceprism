import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test, { after } from 'node:test';

const cacheRoot = path.resolve('.cache/research-workbench-v2/reader');
await fs.mkdir(cacheRoot, { recursive: true });
const dataDirectory = await fs.mkdtemp(path.join(cacheRoot, 'paper-unification-test-'));
process.env.SCIENCEPRISM_DATA_DIR = dataDirectory;
after(() => fs.rm(dataDirectory, { recursive: true, force: true }));
const { createArxivSearchTool } = await import('../src/services/agentService.js');
const { registerResearchSourceAdapter, getResearchSourceAdapter } = await import('../src/services/researchSources/index.js');
const { loadPaperSearches, searchProjectPapers } = await import('../src/services/paperSearch.js');
const { mergeSourceCandidates, papersShareIdentity, sourceIdentityKeys } = await import('../src/services/researchSources/candidateIdentity.js');
const { normalizePaperCandidate } = await import('../src/services/researchResearch/qualityGate.js');
const { importPaper, getPaper, listPapers, updatePaper, paperAnnotationsRevision } = await import('../src/services/projectHub/paperLibrary.js');
const { previewPaperImport, confirmPaperImport } = await import('../src/services/projectHub/paperImportPreview.js');
const { initializeResearchWorkflow, approveResearchWorkflow, getResearchWorkflow } = await import('../src/services/researchWorkflow/index.js');
const { runUiAction, stageData } = await import('../src/services/researchWorkflow/application.js');

let sequence = 0;
async function project() {
  const id = `unification-${++sequence}`;
  await fs.mkdir(path.join(dataDirectory, id));
  await fs.writeFile(path.join(dataDirectory, id, 'project.json'), JSON.stringify({ id, name: 'Paper unification fixture' }));
  return id;
}
function adapter(t, search) {
  const previous = getResearchSourceAdapter('arxiv');
  registerResearchSourceAdapter({ id: 'arxiv', label: 'arXiv fixture', search });
  t.after(() => registerResearchSourceAdapter(previous));
}
const candidate = { id: '1706.03762v1', arxivId: '1706.03762v1', doi: '10.1234/trace', title: 'Evidence from fixtures', authors: ['Test Author'], abstract: 'Public fixture', year: 2024,
  source: 'arxiv', url: 'https://arxiv.org/abs/1706.03762v1', oaPdfUrl: 'https://arxiv.org/pdf/1706.03762v1', oaVersion: 'submittedVersion', oaLicense: 'CC-BY', isOpenAccess: true, issns: ['1234-5678'], publicationType: 'preprint' };
const policy = { granted: ['research.search'], networkAllowlist: ['export.arxiv.org'] };
const strategy = JSON.stringify({ stage: 'search_strategy', researchQuestion: 'Evidence', humanDirection: 'Evidence', queries: ['query two'], sources: ['arxiv'], rationale: 'Controlled fixture strategy' });
async function searchWorkflow(id) {
  const workflow = await initializeResearchWorkflow(id, { data: { researchQuestion: 'Evidence' } });
  await approveResearchWorkflow(id, { stageId: 'direction', expectedVersion: workflow.version });
}

test('agent arxiv_search uses the same persistent project search as the page and retains provenance', async t => {
  const id = await project();
  let calls = 0;
  adapter(t, async ({ maxResults, signal }) => { calls++;assert.ok(maxResults <= 11);assert.equal(signal, undefined);return [{ ...candidate }]; });
  const page = await searchProjectPapers(id, { query: 'page query', sources: ['arxiv'], pageSize: 5 });
  const tool = createArxivSearchTool({ projectId: id, capabilityPolicy: policy });
  const result = JSON.parse(await tool.invoke({ query: 'agent query', maxResults: 5 }));
  assert.equal(calls, 2);assert.equal(result.status, 'completed');
  const history = (await loadPaperSearches(id)).sessions;
  assert.deepEqual(new Set(history.map(session => session.id)), new Set([page.id, result.searchSessionId]));
  assert.ok(result.papers[0].searchSessionIds.includes(result.searchSessionId));
  assert.equal(result.papers[0].sourceRecords[0].searchSessionId, result.searchSessionId);
  const saved = await importPaper(id, result.papers[0]);
  assert.ok(saved.paper.searchSessionIds.includes(result.searchSessionId));
  assert.equal(saved.paper.sourceRecords.find(record => record.searchSessionId)?.searchSessionId, result.searchSessionId);
});

test('agent denied capability/host and real cancellation never persist a late session', async t => {
  const id = await project();let calls = 0, entered;
  const started = new Promise(resolve => { entered = resolve; });
  adapter(t, ({ signal }) => { calls++;entered();return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); });
  await assert.rejects(createArxivSearchTool({ projectId: id, capabilityPolicy: { granted: [] } }).invoke({ query: 'denied' }), { code: 'CAPABILITY_DENIED' });
  await assert.rejects(createArxivSearchTool({ projectId: id, capabilityPolicy: { granted: ['research.search'], networkAllowlist: [] } }).invoke({ query: 'denied' }), { code: 'NETWORK_DENIED' });
  assert.equal(calls, 0);
  const controller = new AbortController();
  const pending = createArxivSearchTool({ projectId: id, capabilityPolicy: policy, signal: controller.signal }).invoke({ query: 'cancelled' });
  await started;controller.abort();await assert.rejects(pending);
  assert.equal(calls, 1);assert.equal((await loadPaperSearches(id)).sessions.length, 0);
});

test('workflow multi-query search reuses sessions and carries source references through quality evaluation', async t => {
  const id = await project();await searchWorkflow(id);
  adapter(t, async ({ query }) => [{ ...candidate, id: query === 'query one' ? '1706.03762v1' : '1706.03762v2', arxivId: query === 'query one' ? '1706.03762v1' : '1706.03762v2' }]);
  const workflow = await runUiAction(id, { action: 'search', query: 'query one', adapter: 'fake', fakeResponse: strategy }, 'human');
  const data = stageData(workflow, 'search');
  assert.equal(data.searchSessionIds.length, 2);assert.equal(data.papers.length, 1);
  const history = (await loadPaperSearches(id)).sessions;
  assert.deepEqual(new Set(data.searchSessionIds), new Set(history.map(session => session.id)));
  const paper = data.papers[0];assert.equal(paper.sourceRecords.length, 2);assert.equal(paper.searchSessionIds.length, 2);
  const normalized = normalizePaperCandidate(paper);
  for (const key of ['doi', 'arxivId', 'oaPdfUrl', 'oaVersion', 'oaLicense', 'isOpenAccess', 'issns', 'sourceRecords', 'searchSessionIds']) assert.deepEqual(normalized[key], paper[key], key);
  const imported = await importPaper(id, paper);
  assert.equal(imported.paper.searchSessionIds.length, 2);
});

test('workflow cancellation stops active search without publishing a completed stage', async t => {
  const id = await project();await searchWorkflow(id);
  let entered;const started = new Promise(resolve => { entered = resolve; });
  adapter(t, ({ signal }) => { entered();return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); });
  const controller = new AbortController();
  const pending = runUiAction(id, { action: 'search', query: 'query one', adapter: 'fake', fakeResponse: strategy }, 'human', { signal: controller.signal });
  await started;controller.abort();await assert.rejects(pending);
  assert.equal((await loadPaperSearches(id)).sessions.length, 0);
  assert.equal(stageData(await getResearchWorkflow(id), 'search').lastRunAt, undefined);
});

test('identities merge exact DOI/arXiv versions but never merge conflicting identifiers or titles', () => {
  assert.equal(papersShareIdentity({ doi: 'https://doi.org/10.1234/A' }, { doi: 'doi:10.1234/a', arxivId: '1706.03762v2' }), true);
  assert.equal(papersShareIdentity({ arxivId: '1706.03762v1' }, { arxivId: 'https://arxiv.org/pdf/1706.03762v2.pdf' }), true);
  assert.equal(papersShareIdentity({ title: 'Same', year: 2024 }, { title: 'Same', year: 2024 }), false);
  assert.equal(sourceIdentityKeys({ title: 'Same' }).length, 0);
  const conflicting = [
    { ...candidate, doi: '10.1234/a', sourceRecords: [{ provider: 'arxiv', id: '1706.03762', externalVersion: 'v1' }] },
    { ...candidate, doi: '10.1234/b', sourceRecords: [{ provider: 'arxiv', id: '1706.03762', externalVersion: 'v2' }] }
  ];
  assert.equal(mergeSourceCandidates(conflicting).length, 2);
  const versions = mergeSourceCandidates(conflicting.map(paper => ({ ...paper, doi: '10.1234/a' })));
  assert.equal(versions.length, 1);assert.equal(versions[0].sourceRecords.length, 2);
});

test('library uses both identifiers, separates DOI conflicts, and preserves human fields and all source versions', async () => {
  const id = await project();
  const first = await importPaper(id, { doi: '10.1234/a', title: 'Human paper', source: 'crossref' });
  const edited = await updatePaper(id, first.paper.id, { notes: 'Keep notes', bibtex: '@article{human}', annotations: [{ id: 'human-note', text: 'Keep annotation' }], expectedAnnotationsRevision: paperAnnotationsRevision(first.paper.annotations) });
  const incoming = { ...candidate, doi: '10.1234/a', notes: '', bibtex: '@article{source}', sourceRecords: [{ provider: 'arxiv', id: '1706.03762', externalVersion: 'v1', searchSessionId: 'session-one' }] };
  const duplicate = await importPaper(id, incoming);
  assert.equal(duplicate.paper.id, first.paper.id);assert.equal(duplicate.duplicate, true);
  for (const key of ['notes', 'annotations', 'bibtex']) assert.deepEqual(duplicate.paper[key], edited.paper[key]);
  const version = await importPaper(id, { ...incoming, arxivId: '1706.03762v2', sourceRecords: [{ provider: 'arxiv', id: '1706.03762', externalVersion: 'v2', searchSessionId: 'session-two' }] });
  await updatePaper(id, first.paper.id, { notes: 'Later human note' });
  const records = (await getPaper(id, first.paper.id)).sourceRecords;
  assert.ok(records.some(record => record.externalVersion === 'v1'));assert.ok(records.some(record => record.externalVersion === 'v2'));
  assert.ok(version.paper.searchSessionIds.includes('session-one'));assert.ok(version.paper.searchSessionIds.includes('session-two'));
  const conflict = await importPaper(id, { ...incoming, doi: '10.1234/b' });
  assert.equal(conflict.duplicate, false);assert.notEqual(conflict.paper.id, first.paper.id);
  const titleOnlyA = await importPaper(id, { title: 'Same title' });
  const titleOnlyB = await importPaper(id, { title: 'Same title' });
  assert.notEqual(titleOnlyA.paper.id, titleOnlyB.paper.id);
  assert.equal((await importPaper(id, structuredClone(titleOnlyA.paper))).paper.id, titleOnlyA.paper.id, 'an explicit project record round trip keeps its local ID');
  assert.equal((await listPapers(id)).length, 4);
  const collisionId = await project();
  const collisionA = await importPaper(collisionId, { ...candidate, doi: '10.1234/a' });
  const collisionB = await importPaper(collisionId, { ...candidate, doi: '10.1234/b' });
  assert.notEqual(collisionA.paper.id, collisionB.paper.id, 'conflicting provider IDs must not create duplicate local IDs');
});

test('preview shares exact identity matching and prevents an ambiguous DOI/arXiv bridge', async () => {
  const id = await project();
  const original = await importPaper(id, { doi: '10.1234/bridge', title: 'Original', source: 'crossref' });
  const text = '@article{new,title={New},doi={10.1234/bridge},archivePrefix={arXiv},eprint={1706.03762v2}}';
  const preview = await previewPaperImport(id, { text });
  assert.equal(preview.items[0].duplicates[0].paperId, original.paper.id);
  const merged = await confirmPaperImport(id, { text, index: 0, inputDigest: preview.inputDigest, expectedRevision: preview.items[0].expectedRevision, action: 'merge', fields: ['arxivId'] });
  assert.equal(merged.paper.id, original.paper.id);
  const ambiguousId = await project();
  await importPaper(ambiguousId, { doi: '10.1234/bridge', title: 'DOI record' });
  await importPaper(ambiguousId, { arxivId: '1706.03762', title: 'arXiv record' });
  await assert.rejects(previewPaperImport(ambiguousId, { text }), { code: 'PAPER_IDENTITY_AMBIGUOUS' });
  await assert.rejects(importPaper(ambiguousId, { doi: '10.1234/bridge', arxivId: '1706.03762' }), { code: 'PAPER_IDENTITY_AMBIGUOUS' });
  assert.equal((await listPapers(ambiguousId)).length, 2);
});
