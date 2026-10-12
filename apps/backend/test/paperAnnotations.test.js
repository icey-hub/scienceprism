import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test, { after } from 'node:test';
import Fastify from 'fastify';

const cacheRoot = path.resolve('.cache/research-workbench-v2/reader');
await fs.mkdir(cacheRoot, { recursive: true });
const dataDirectory = await fs.mkdtemp(path.join(cacheRoot, 'annotations-test-'));
process.env.SCIENCEPRISM_DATA_DIR = dataDirectory;
after(() => fs.rm(dataDirectory, { recursive: true, force: true }));
const { createPaperAnnotationService } = await import('../src/services/paperAnnotations.js');
const { registerPaperAnnotationRoutes } = await import('../src/routes/paperAnnotations.js');
const { getPaper, updatePaper, importPaper, mutatePaperAnnotations, paperAnnotationsRevision } = await import('../src/services/projectHub/paperLibrary.js');

const hash = 'a'.repeat(64);
const attachmentId = `attachment-${hash}`;
const anchor = { attachmentId, fileSha256: hash, page: 2, rects: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.04 }, { x: 0.1, y: 0.24, width: 0.2, height: 0.04 }], quote: 'The result is reproducible.' };
const translation = { sourceText: anchor.quote, translatedText: '这一结果可以复现。', providerId: 'bing-web', translatedAt: '2026-10-12T10:00:00.000Z', sourceLanguage: 'en', targetLanguage: 'zh-CN' };
const oldNote = { id: 'legacy-note', text: 'Human free note', quote: 'Old excerpt', page: 3, createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z' };
let sequence = 0;
async function fixture() {
  const id = `annotations-${++sequence}`;
  const root = path.join(dataDirectory, id);
  await fs.mkdir(path.join(root, '.scienceprism'), { recursive: true });
  await fs.writeFile(path.join(root, 'project.json'), JSON.stringify({ id, name: 'Annotation fixture' }));
  const paper = { id: 'paper-1', canonicalKey: 'doi:10.1234/fixture', title: 'Fixture paper', doi: '10.1234/fixture', authors: ['Test Author'], tags: ['keep'], notes: 'Independent human notes', annotations: [structuredClone(oldNote)], createdAt: oldNote.createdAt, updatedAt: oldNote.updatedAt };
  const libraryPath = path.join(root, '.scienceprism/paper-library.json');
  await fs.writeFile(libraryPath, JSON.stringify({ schemaVersion: 1, projectId: id, version: 1, papers: [paper] }));
  const attachmentIndexPath = path.join(root, '.scienceprism/paper-attachments.json');
  const index = { schemaVersion: 1, projectId: id, version: 1, attachments: [{ id: attachmentId, paperId: paper.id, sha256: hash, pageCount: 4 }, { id: 'other-paper-file', paperId: 'paper-2', sha256: hash, pageCount: 4 }], jobs: [] };
  await fs.writeFile(attachmentIndexPath, JSON.stringify(index));
  return { id, root, libraryPath, attachmentIndexPath, index, service: createPaperAnnotationService() };
}

test('legacy free notes remain unlocated, byte-preserved in storage and shared with paperLibrary', async () => {
  const { id, service, libraryPath } = await fixture();
  const before = await fs.readFile(libraryPath, 'utf8');
  const view = await service.list(id, 'paper-1');
  assert.equal(view.annotations[0].locationStatus, 'unlocated');
  assert.equal(view.annotations[0].anchor, null);
  assert.equal(view.annotations[0].text, oldNote.text);assert.equal(view.annotations[0].page, oldNote.page);
  assert.equal(await fs.readFile(libraryPath, 'utf8'), before, 'listing must not migrate data by writing');
  const added = await service.create(id, 'paper-1', { expectedRevision: view.revision, annotation: { text: 'New reader note', anchor, translation } });
  assert.deepEqual((await getPaper(id, 'paper-1')).annotations[0], oldNote);
  assert.equal(added.annotations.length, 2);assert.equal(added.annotations[1].locationStatus, 'anchored');
  assert.deepEqual(added.annotations[1].anchor, anchor);assert.deepEqual(added.annotations[1].translation, translation);
  assert.equal((await getPaper(id, 'paper-1')).notes, 'Independent human notes');
  assert.equal((await service.list(id, 'paper-1')).revision, added.revision);
});

test('CRUD preserves IDs and creation time, rejects stale saves and does not duplicate retry writes', async () => {
  const { id, service } = await fixture();
  const initial = await service.list(id, 'paper-1');
  const request = { expectedRevision: initial.revision, annotation: { text: 'First', anchor } };
  const created = await service.create(id, 'paper-1', request);
  await assert.rejects(service.create(id, 'paper-1', request), { code: 'ANNOTATION_CONFLICT' });
  const note = created.annotations[1];
  const edited = await service.update(id, 'paper-1', note.id, { expectedRevision: created.revision, patch: { text: 'Revised', translation } });
  assert.equal(edited.annotations[1].id, note.id);assert.equal(edited.annotations[1].createdAt, note.createdAt);
  assert.deepEqual(edited.annotations[1].anchor, anchor);
  await assert.rejects(service.remove(id, 'paper-1', note.id, { expectedRevision: created.revision }), { code: 'ANNOTATION_CONFLICT' });
  const removed = await service.remove(id, 'paper-1', note.id, { expectedRevision: edited.revision });
  assert.equal(removed.annotations.length, 1);assert.equal(removed.annotations[0].text, oldNote.text);
  await assert.rejects(service.update(id, 'paper-1', note.id, { expectedRevision: removed.revision, patch: { text: 'Gone' } }), { code: 'ANNOTATION_NOT_FOUND' });
});

test('concurrent annotation writers have one winner while unrelated human paper edits survive', async () => {
  const { id, service } = await fixture();
  const initial = await service.list(id, 'paper-1');
  await updatePaper(id, 'paper-1', { notes: 'Human just changed the notes', tags: ['new-human-tag'] });
  const requests = await Promise.allSettled(['A', 'B'].map(text => service.create(id, 'paper-1', { expectedRevision: initial.revision, annotation: { text } })));
  assert.equal(requests.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(requests.find(item => item.status === 'rejected').reason.code, 'ANNOTATION_CONFLICT');
  const paper = await getPaper(id, 'paper-1');
  assert.equal(paper.notes, 'Human just changed the notes');assert.deepEqual(paper.tags, ['new-human-tag']);assert.equal(paper.annotations.length, 2);
});

test('invalid coordinates, attachment versions, pages, translation identity and oversized text never write', async () => {
  const { id, service, libraryPath } = await fixture();
  const revision = (await service.list(id, 'paper-1')).revision;
  const before = await fs.readFile(libraryPath, 'utf8');
  const invalidAnchors = [
    { ...anchor, fileSha256: 'b'.repeat(64) }, { ...anchor, attachmentId: 'other-paper-file' }, { ...anchor, page: 5 }, { ...anchor, page: 0 },
    { ...anchor, rects: [] }, { ...anchor, rects: [{ x: -0.1, y: 0, width: 0.1, height: 0.1 }] },
    { ...anchor, rects: [{ x: 0.9, y: 0, width: 0.2, height: 0.1 }] }, { ...anchor, rects: [{ x: 0, y: 0, width: 0, height: 0.1 }] },
    { ...anchor, rects: [{ x: Number.NaN, y: 0, width: 0.1, height: 0.1 }] }, { ...anchor, rects: [{ x: 1.0000001, y: 0, width: 0.0000001, height: 0.1 }] }
  ];
  for (const invalidAnchor of invalidAnchors) await assert.rejects(service.create(id, 'paper-1', { expectedRevision: revision, annotation: { text: 'Invalid', anchor: invalidAnchor } }));
  for (const annotation of [{ text: '' }, { text: null }, { text: 'a'.repeat(10001) }, { text: '\ud800' }, { text: 'Invalid', anchor, translation: { ...translation, sourceText: 'Different selection' } }, { text: 'Invalid', extra: true }]) {
    await assert.rejects(service.create(id, 'paper-1', { expectedRevision: revision, annotation }));
  }
  await assert.rejects(service.create(id, 'paper-1', { annotation: { text: 'Missing revision' } }), { code: 'ANNOTATION_REVISION_REQUIRED' });
  assert.equal(await fs.readFile(libraryPath, 'utf8'), before);
});

test('old anchors are not silently moved to a new PDF and can be explicitly detached', async () => {
  const { id, service, attachmentIndexPath, index } = await fixture();
  const created = await service.create(id, 'paper-1', { expectedRevision: (await service.list(id, 'paper-1')).revision, annotation: { text: 'Keep this observation', anchor } });
  index.attachments[0].sha256 = 'b'.repeat(64);
  await fs.writeFile(attachmentIndexPath, JSON.stringify(index));
  const mismatched = await service.list(id, 'paper-1');
  assert.equal(mismatched.annotations[1].locationStatus, 'version-mismatch');assert.deepEqual(mismatched.annotations[1].anchor, anchor);
  index.attachments = [];
  await fs.writeFile(attachmentIndexPath, JSON.stringify(index));
  assert.equal((await service.list(id, 'paper-1')).annotations[1].locationStatus, 'attachment-missing');
  const detached = await service.update(id, 'paper-1', created.annotations[1].id, { expectedRevision: created.revision, patch: { anchor: null } });
  assert.equal(detached.annotations[1].locationStatus, 'unlocated');assert.equal(detached.annotations[1].text, 'Keep this observation');
});

test('legacy bulk writes require revision and preserve trusted anchors by annotation ID', async () => {
  const { id, service } = await fixture();
  const initial = await service.list(id, 'paper-1');
  const created = await service.create(id, 'paper-1', { expectedRevision: initial.revision, annotation: { text: 'Reader', anchor, translation } });
  const paper = await getPaper(id, 'paper-1');
  await assert.rejects(updatePaper(id, 'paper-1', { annotations: [] }), { code: 'ANNOTATION_CONFLICT' });
  await assert.rejects(importPaper(id, { ...paper, annotations: [] }), { code: 'ANNOTATION_CONFLICT' });
  const reordered = [...paper.annotations].reverse();
  reordered[0].anchor = { ...anchor, fileSha256: 'b'.repeat(64) };
  reordered[0].translation = { ...translation, providerId: 'untrusted-overwrite' };
  const updated = await updatePaper(id, 'paper-1', { annotations: reordered, expectedAnnotationsRevision: created.revision });
  assert.deepEqual(updated.paper.annotations[0].anchor, anchor);assert.deepEqual(updated.paper.annotations[0].translation, translation);
  assert.equal(updated.paper.annotations[0].createdAt, paper.annotations[1].createdAt);
  assert.equal(updated.paper.annotations[1].createdAt, oldNote.createdAt);
  assert.equal(Object.hasOwn(updated.paper, 'expectedAnnotationsRevision'), false);
  const next = (await service.list(id, 'paper-1')).revision;
  await updatePaper(id, 'paper-1', { annotations: [...updated.paper.annotations, { id: 'forged', text: 'Unlocated', anchor }], expectedAnnotationsRevision: next });
  assert.equal((await service.list(id, 'paper-1')).annotations.at(-1).locationStatus, 'unlocated');
});

test('mutation failures leave the only library store unchanged and cannot cross projects', async () => {
  const { id, service, libraryPath } = await fixture();
  const before = await fs.readFile(libraryPath, 'utf8');
  const revision = (await service.list(id, 'paper-1')).revision;
  await assert.rejects(mutatePaperAnnotations(id, 'paper-1', revision, () => { throw new Error('Validation failed'); }));
  assert.equal(await fs.readFile(libraryPath, 'utf8'), before);
  await assert.rejects(service.list('missing-project', 'paper-1'), { code: 'ANNOTATION_PAPER_NOT_FOUND' });
  assert.equal(revision, paperAnnotationsRevision((await getPaper(id, 'paper-1')).annotations));
});

test('annotation routes expose revisions, conflicts and the same CRUD state', async t => {
  const { id, service } = await fixture();
  const app = Fastify();registerPaperAnnotationRoutes(app, { service });t.after(() => app.close());
  const base = `/api/projects/${id}/papers/paper-1/annotations`;
  const listed = (await app.inject(base)).json();
  const missing = await app.inject({ method: 'POST', url: base, payload: { annotation: { text: 'No revision' } } });
  assert.equal(missing.statusCode, 428);
  const added = await app.inject({ method: 'POST', url: base, payload: { expectedRevision: listed.revision, annotation: { text: 'Route note', anchor } } });
  assert.equal(added.statusCode, 200, added.body);
  const stale = await app.inject({ method: 'POST', url: base, payload: { expectedRevision: listed.revision, annotation: { text: 'Stale' } } });
  assert.equal(stale.statusCode, 409);assert.equal(stale.json().error.code, 'ANNOTATION_CONFLICT');
  const state = added.json();const noteId = state.annotations.at(-1).id;
  const patched = await app.inject({ method: 'PATCH', url: `${base}/${noteId}`, payload: { expectedRevision: state.revision, patch: { text: 'Edited via route' } } });
  assert.equal(patched.statusCode, 200);
  const deleted = await app.inject({ method: 'DELETE', url: `${base}/${noteId}`, payload: { expectedRevision: patched.json().revision } });
  assert.equal(deleted.statusCode, 200);assert.equal(deleted.json().annotations.length, 1);
});
