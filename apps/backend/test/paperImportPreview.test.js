import assert from 'node:assert/strict';
import { mkdir, writeFile, readdir, readFile, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Fastify from 'fastify';

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'scienceprism-import-preview-'));
process.env.SCIENCEPRISM_DATA_DIR = dataDir;
const { confirmPaperImport, previewPaperImport, PaperImportPreviewError } = await import('../src/services/projectHub/paperImportPreview.js');
const { importPaper, listPapers, updatePaper } = await import('../src/services/projectHub/paperLibrary.js');
const { registerProjectHubRoutes } = await import('../src/routes/projectHub.js');

async function createProject(projectId) {
  const root = path.join(dataDir, projectId);
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'project.json'), JSON.stringify({ id: projectId, name: 'Preview test' }));
}

const bibtex = `@article{trace2024,
  title = {Traceable {Evidence} Retrieval},
  author = {Doe, Jane and Smith, John},
  year = {2024},
  doi = {10.1000/TRACE},
  url = {https://example.test/trace}
}
@misc{arxiv2024,
  title = {Versioned arXiv Study},
  author = {Researcher, Ada},
  year = {2024},
  eprint = {2401.01234v2},
  archivePrefix = {arXiv}
}`;

test('BibTeX preview parses entries without writing library, tasks, or Evidence', async () => {
  const projectId = 'preview-read-only';
  await createProject(projectId);
  const preview = await previewPaperImport(projectId, { text: bibtex });
  assert.equal(preview.count, 2);
  assert.equal(preview.writesPerformed, false);
  assert.equal(preview.originalText, bibtex);
  assert.equal(preview.items[0].candidate.canonicalKey, 'doi:10.1000/trace');
  assert.equal(preview.items[0].candidate.citationKey, 'trace2024');
  assert.equal(preview.items[0].checks.fields.status, 'complete');
  assert.equal(preview.items[0].checks.source.status, 'unverified');
  assert.equal(preview.items[1].candidate.arxivId, '2401.01234');
  assert.equal(preview.items[1].candidate.sourceRecords[0].externalVersion, '2401.01234v2');
  assert.equal((await listPapers(projectId)).length, 0);
  assert.deepEqual(await readdir(path.join(dataDir, projectId)), ['project.json']);
});

test('preview reports project and batch duplicates with explicit conflicts', async () => {
  const projectId = 'preview-conflicts';
  await createProject(projectId);
  await importPaper(projectId, { title: 'Traceable Evidence Retrieval', authors: ['Jane Doe'], doi: '10.1000/trace', year: 2024, url: 'https://example.test/trace' });
  const preview = await previewPaperImport(projectId, { text: `${bibtex}\n@article{again,title={Changed},author={Doe, Jane},year={2024},doi={10.1000/trace}}` });
  assert.equal(preview.items[0].duplicates[0].scope, 'project');
  assert.ok(preview.items[0].conflicts.some((conflict) => conflict.field === 'authors'));
  assert.ok(preview.items[2].duplicates.some((duplicate) => duplicate.scope === 'project'));
  assert.ok(preview.items[2].duplicates.some((duplicate) => duplicate.scope === 'batch' && duplicate.index === 0));
  assert.ok(preview.items[2].conflicts.some((conflict) => conflict.field === 'title'));
  assert.equal(preview.items[2].requiresDecision, true);
});

test('preview rejects invalid, unsupported, and oversized input', async () => {
  await createProject('preview-errors');
  await assert.rejects(() => previewPaperImport('preview-errors', { format: 'ris', text: 'TY  - JOUR' }), (error) => error.code === 'UNSUPPORTED_IMPORT_FORMAT');
  await assert.rejects(() => previewPaperImport('preview-errors', { text: '@article{broken,title={Missing close}' }), (error) => error.code === 'INVALID_BIBTEX');
  await assert.rejects(() => previewPaperImport('preview-errors', { text: 'x'.repeat(100 * 1024 + 1) }), (error) => error instanceof PaperImportPreviewError && error.code === 'IMPORT_TOO_LARGE');
  const tooMany = Array.from({ length: 201 }, (_, index) => `@article{k${index},title={T${index}},author={Doe, Jane},year={2024}}`).join('\\n');
  await assert.rejects(() => previewPaperImport('preview-errors', { text: tooMany }), (error) => error.code === 'TOO_MANY_ENTRIES');
});

test('preview expands macros and keeps citation labels and versioned BibTeX round-trippable', async () => {
  await createProject('preview-macros');
  const text = '@string{prefix="A "}\n@misc{same,title=prefix # {Nested {Title}},author={{Research Group}},archivePrefix={arXiv},eprint={2401.01234v2}}\n@misc{same,title={Another Title}}';
  const preview = await previewPaperImport('preview-macros', { text });
  assert.equal(preview.items[0].candidate.title, 'A Nested Title');
  assert.deepEqual(preview.items[0].candidate.authors, ['Research Group']);
  assert.deepEqual(preview.items[1].warnings, ['duplicate-citation-key']);
  const again = await previewPaperImport('preview-macros', { text: preview.items[0].candidate.bibtex });
  for (const key of ['title', 'authors', 'arxivId', 'citationKey', 'bibtex']) assert.deepEqual(again.items[0].candidate[key], preview.items[0].candidate[key]);
});

function decision(preview, index, action, fields = []) {
  return { text: preview.originalText, inputDigest: preview.inputDigest, index, expectedRevision: preview.items[index].expectedRevision, action, fields };
}

async function snapshot(projectId) {
  const root = path.join(dataDir, projectId);
  const files = (await readdir(root, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile());
  return Promise.all(files.map(async (entry) => [path.relative(root, path.join(entry.parentPath, entry.name)), await readFile(path.join(entry.parentPath, entry.name), 'utf8')]));
}

test('confirmation creates once, keeps without writes, and merges only chosen fields', async () => {
  const id = 'confirm-fields';
  await createProject(id);
  const preview = await previewPaperImport(id, { text: bibtex });
  const created = await confirmPaperImport(id, decision(preview, 0, 'create'));
  await updatePaper(id, created.paper.id, { notes: 'Human notes', favorite: true, title: 'Human title', tags: ['keep'], annotations: [{ text: 'My annotation' }] });
  const next = await previewPaperImport(id, { text: bibtex });
  const before = await snapshot(id);
  assert.equal((await confirmPaperImport(id, decision(next, 0, 'keep'))).skipped, true);
  assert.deepEqual(await snapshot(id), before);
  const merged = await confirmPaperImport(id, decision(next, 0, 'merge', ['title']));
  assert.equal(merged.paper.title, 'Traceable Evidence Retrieval');
  assert.equal(merged.paper.notes, 'Human notes');
  assert.equal(merged.paper.favorite, true);
  assert.deepEqual(merged.paper.tags, ['keep']);
  assert.equal(merged.paper.annotations[0].text, 'My annotation');
  assert.equal(merged.paper.id, created.paper.id);
  assert.equal(merged.paper.evidenceId, created.paper.evidenceId);
  assert.equal((await listPapers(id)).length, 1);
});

test('stale, invalid and replayed confirmations have no persistent side effects', async () => {
  const id = 'confirm-stale';
  await createProject(id);
  const preview = await previewPaperImport(id, { text: bibtex });
  const created = await confirmPaperImport(id, decision(preview, 0, 'create'));
  const current = await previewPaperImport(id, { text: bibtex });
  await updatePaper(id, created.paper.id, { notes: 'Changed after preview' });
  const before = await snapshot(id);
  for (const request of [decision(preview, 0, 'create'), decision(current, 0, 'merge', ['title'])]) {
    await assert.rejects(() => confirmPaperImport(id, request), { code: 'IMPORT_PREVIEW_STALE' });
  }
  for (const request of [
    { ...decision(current, 0, 'merge', ['title']), text: bibtex + '\n% changed' },
    decision(current, 0, 'merge', ['notes']),
    decision(current, 0, 'merge', []),
    { ...decision(current, 0, 'create'), expectedRevision: undefined },
    { ...decision(current, 0, 'create'), index: 500 }
  ]) await assert.rejects(() => confirmPaperImport(id, request), { code: 'INVALID_IMPORT_DECISION' });
  assert.deepEqual(await snapshot(id), before);
});

test('concurrent confirmations and batch duplicates cannot overwrite an unseen record', async () => {
  const id = 'confirm-concurrent';
  await createProject(id);
  const preview = await previewPaperImport(id, { text: bibtex + '\n@article{copy,title={Different},doi={10.1000/trace}}' });
  const request = decision(preview, 0, 'create');
  const results = await Promise.allSettled([confirmPaperImport(id, request), confirmPaperImport(id, request)]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'IMPORT_PREVIEW_STALE');
  const before = await snapshot(id);
  await assert.rejects(() => confirmPaperImport(id, decision(preview, 2, 'create')), { code: 'IMPORT_PREVIEW_STALE' });
  assert.deepEqual(await snapshot(id), before);
});

test('HTTP preview route preserves read-only and structured errors', async (t) => {
  const projectId = 'preview-route';
  await createProject(projectId);
  const app = Fastify();
  t.after(() => app.close());
  registerProjectHubRoutes(app);
  const response = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/papers/import-preview`, payload: { text: '@article{route,title={Route paper},author={Doe, Jane},year={2024},doi={10.1/route}}' } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().preview.writesPerformed, false);
  const invalid = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/papers/import-preview`, payload: { format: 'ris', text: 'TY  - JOUR' } });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().error.code, 'UNSUPPORTED_IMPORT_FORMAT');
  const payload = decision(response.json().preview, 0, 'create');
  const confirmed = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/papers/import-confirm`, payload });
  assert.equal(confirmed.statusCode, 200);
  assert.ok(confirmed.json().result.paper.evidenceId);
  const replay = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/papers/import-confirm`, payload });
  assert.equal(replay.statusCode, 409);
  assert.equal(replay.json().error.code, 'IMPORT_PREVIEW_STALE');
});
