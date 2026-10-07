import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';

await fs.mkdir(new URL('../../../.cache/', import.meta.url), { recursive: true });
const dataDir = await fs.mkdtemp(fileURLToPath(new URL('../../../.cache/patch-application-', import.meta.url)));
process.env.SCIENCEPRISM_DATA_DIR = dataDir;
const runtime = await import('../src/services/harnessRuntime/index.js');
const { registerHarnessRunRoutes } = await import('../src/routes/harnessRuns.js');
const { registerProjectRoutes } = await import('../src/routes/projects.js');
const { readHarnessRuns, writeHarnessRuns, withHarnessRunLock } = await import('../src/services/harnessRuntime/repository.js');
const { getOrCreateDoc, flushDocNow } = await import('../src/services/collab/docStore.js');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

async function project(id, files = { 'main.tex': 'old\n' }) {
  const root = path.join(dataDir, id);
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, 'project.json'), '{}');
  for (const [name, content] of Object.entries(files)) await fs.writeFile(path.join(root, name), content);
  return root;
}

async function propose(id, patches) {
  const result = await runtime.runHarnessRequest({ projectId: id, adapter: 'fake', capabilities: ['project.read', 'patch.propose'], fakePatches: patches });
  assert.equal(result.ok, true);
  await runtime.decideHarnessRun(id, result.runId, { decision: 'accept' });
  return result.runId;
}

test('all selected files are version checked before any proposal is written', async () => {
  const id = 'stale-multifile';
  const root = await project(id, { 'main.tex': 'old\n', 'second.tex': 'second\n' });
  const runId = await propose(id, [{ path: 'main.tex', content: 'new\n' }, { path: 'second.tex', content: 'revised\n' }]);
  const run = await runtime.getHarnessRun(id, runId);
  assert.deepEqual(run.patches[0].baseVersion, { exists: true, sha256: sha256('old\n') });
  await fs.writeFile(path.join(root, 'second.tex'), 'human update\n');
  await assert.rejects(() => runtime.applyHarnessRunPatches(id, runId), (error) => {
    assert.equal(error.code, 'PATCH_VERSION_CONFLICT');
    assert.equal(error.statusCode, 409);
    assert.equal(error.details.conflicts[0].path, 'second.tex');
    return true;
  });
  assert.equal(await fs.readFile(path.join(root, 'main.tex'), 'utf8'), 'old\n');
  assert.equal(await fs.readFile(path.join(root, 'second.tex'), 'utf8'), 'human update\n');
});

test('creation and deletion proposals preserve newer files, including an empty file', async () => {
  const id = 'create-delete';
  const root = await project(id);
  const runId = await propose(id, [{ path: 'new.tex', content: '' }, { path: 'main.tex', deleted: true, content: '' }]);
  await fs.writeFile(path.join(root, 'new.tex'), '');
  await assert.rejects(() => runtime.applyHarnessRunPatches(id, runId), { code: 'PATCH_VERSION_CONFLICT' });
  assert.equal(await fs.readFile(path.join(root, 'main.tex'), 'utf8'), 'old\n');
  await fs.writeFile(path.join(root, 'main.tex'), 'human');
  await assert.rejects(() => runtime.applyHarnessRunPatches(id, runId, { paths: ['main.tex'] }), { code: 'PATCH_VERSION_CONFLICT' });
  assert.equal(await fs.readFile(path.join(root, 'main.tex'), 'utf8'), 'human');
});

test('duplicate application returns the recorded result without rewriting newer content', async () => {
  const id = 'idempotent';
  const root = await project(id);
  const runId = await propose(id, [{ path: 'main.tex', content: 'new\n' }]);
  await runtime.applyHarnessRunPatches(id, runId);
  await fs.writeFile(path.join(root, 'main.tex'), 'later human edit');
  const repeated = await runtime.applyHarnessRunPatches(id, runId);
  assert.deepEqual(repeated.applied, []);
  assert.deepEqual(repeated.alreadyApplied, ['main.tex']);
  assert.equal(await fs.readFile(path.join(root, 'main.tex'), 'utf8'), 'later human edit');
  assert.equal(repeated.run.events.filter((event) => event.type === 'patches.applied').length, 1);
});

test('unknown or empty path selections are rejected without writing any files', async () => {
  const id = 'invalid-selection';
  const root = await project(id);
  const runId = await propose(id, [{ path: 'main.tex', content: 'new\n' }]);
  for (const paths of [[], ['main.tex', 'missing.tex'], 'main.tex']) {
    await assert.rejects(() => runtime.applyHarnessRunPatches(id, runId, { paths }), { code: 'INVALID_PATCH_PATHS' });
  }
  assert.equal(await fs.readFile(path.join(root, 'main.tex'), 'utf8'), 'old\n');
});

test('failure at the second file restores the first file and permits a safe retry', async (t) => {
  const id = 'write-failure';
  const root = await project(id, { 'main.tex': 'old\n', 'second.tex': 'second\n' });
  const runId = await propose(id, [{ path: 'main.tex', content: 'new\n' }, { path: 'second.tex', content: 'revised\n' }]);
  const rename = fs.rename;
  let fail = true;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (to === path.join(root, 'second.tex') && fail) {
      fail = false;
      throw Object.assign(new Error('injected second-file failure'), { code: 'EIO' });
    }
    return rename(from, to);
  });
  await assert.rejects(() => runtime.applyHarnessRunPatches(id, runId), { code: 'PATCH_APPLICATION_FAILED' });
  assert.equal(await fs.readFile(path.join(root, 'main.tex'), 'utf8'), 'old\n');
  assert.equal(await fs.readFile(path.join(root, 'second.tex'), 'utf8'), 'second\n');
  const failed = await runtime.getHarnessRun(id, runId);
  assert.deepEqual(failed.appliedPatches, []);
  assert.equal(failed.patchApplication.status, 'rolled_back');
  assert.equal(failed.events.filter((event) => event.type === 'patches.applied').length, 0);
  const retried = await runtime.applyHarnessRunPatches(id, runId);
  assert.deepEqual(retried.applied, ['main.tex', 'second.tex']);
});

test('partial acceptance and rejection persist exact path decisions', async () => {
  const id = 'partial-decision';
  const root = await project(id, { 'main.tex': 'old\n', 'second.tex': 'second\n' });
  const result = await runtime.runHarnessRequest({ projectId: id, adapter: 'fake', fakePatches: [{ path: 'main.tex', content: 'new\n' }, { path: 'second.tex', content: 'revised\n' }] });
  await runtime.decideHarnessRun(id, result.runId, { decision: 'accept', paths: ['main.tex'] });
  await runtime.decideHarnessRun(id, result.runId, { decision: 'reject', paths: ['second.tex'] });
  await assert.rejects(() => runtime.applyHarnessRunPatches(id, result.runId), { code: 'PATCH_APPLICATION_REQUIRES_ACCEPTANCE' });
  const applied = await runtime.applyHarnessRunPatches(id, result.runId, { paths: ['main.tex'] });
  assert.deepEqual(applied.applied, ['main.tex']);
  assert.equal(applied.run.patchDecisions['second.tex'].status, 'rejected');
  assert.equal(await fs.readFile(path.join(root, 'second.tex'), 'utf8'), 'second\n');
});

test('an interrupted journal restores originals before retrying application', async () => {
  const id = 'interrupted';
  const root = await project(id, { 'main.tex': 'old\n', 'second.tex': 'second\n' });
  const runId = await propose(id, [{ path: 'main.tex', content: 'new\n' }, { path: 'second.tex', content: 'revised\n' }]);
  const document = await readHarnessRuns(root, id);
  const run = document.runs.find((item) => item.id === runId);
  run.patchApplication = { id: 'interrupted-application', status: 'applying', paths: run.patches.map((patch) => patch.path), entries: run.patches.map((patch) => ({
    path: patch.path, before: { ...patch.baseVersion, content: patch.original }, after: { exists: true, sha256: sha256(patch.content), content: patch.content }
  })) };
  await writeHarnessRuns(root, document);
  await fs.writeFile(path.join(root, 'main.tex'), 'new\n');
  const applied = await runtime.applyHarnessRunPatches(id, runId);
  assert.deepEqual(applied.applied, ['main.tex', 'second.tex']);
  assert.equal(applied.run.patchApplication.status, 'applied');
  assert.equal(await fs.readFile(path.join(root, 'second.tex'), 'utf8'), 'revised\n');
});

test('rollback keeps edits made after the transaction began', async (t) => {
  const id = 'rollback-new-edit';
  const root = await project(id, { 'main.tex': 'old\n', 'second.tex': 'second\n' });
  const runId = await propose(id, [{ path: 'main.tex', content: 'new\n' }, { path: 'second.tex', content: 'revised\n' }]);
  const rename = fs.rename;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (to === path.join(root, 'second.tex')) {
      await fs.writeFile(path.join(root, 'main.tex'), 'newer human content');
      throw new Error('injected write failure');
    }
    return rename(from, to);
  });
  await assert.rejects(() => runtime.applyHarnessRunPatches(id, runId), { code: 'PATCH_RECOVERY_REQUIRED' });
  assert.equal(await fs.readFile(path.join(root, 'main.tex'), 'utf8'), 'newer human content');
  const failed = await runtime.getHarnessRun(id, runId);
  assert.equal(failed.patchApplication.status, 'recovery_required');
  assert.equal(failed.patchApplication.entries[0].before.content, 'old\n');
  await assert.rejects(() => runtime.applyHarnessRunPatches(id, runId), { code: 'PATCH_RECOVERY_REQUIRED' });
});

test('empty creation and deletion succeed with distinct existence baselines', async () => {
  const id = 'empty-create-delete';
  const root = await project(id);
  const runId = await propose(id, [{ path: 'empty.tex', content: '' }, { path: 'main.tex', content: '', deleted: true }]);
  await runtime.applyHarnessRunPatches(id, runId);
  assert.equal(await fs.readFile(path.join(root, 'empty.tex'), 'utf8'), '');
  await assert.rejects(() => fs.stat(path.join(root, 'main.tex')), { code: 'ENOENT' });
});

test('live collaborative edits block application and successful changes survive a later flush', async (t) => {
  const id = 'collab-application';
  const root = await project(id);
  const runId = await propose(id, [{ path: 'main.tex', content: 'new\n' }]);
  const doc = await getOrCreateDoc({ key: `${id}:main.tex`, absPath: path.join(root, 'main.tex') });
  t.after(() => { clearTimeout(doc.flushTimer); doc.awareness.destroy(); doc.ydoc.destroy(); });
  doc.text.insert(0, 'unsaved ');
  await assert.rejects(() => runtime.applyHarnessRunPatches(id, runId), { code: 'PATCH_VERSION_CONFLICT' });
  assert.equal(await fs.readFile(path.join(root, 'main.tex'), 'utf8'), 'old\n');
  doc.text.delete(0, 'unsaved '.length);
  await runtime.applyHarnessRunPatches(id, runId);
  assert.equal(doc.text.toString(), 'new\n');
  await flushDocNow(`${id}:main.tex`);
  assert.equal(await fs.readFile(path.join(root, 'main.tex'), 'utf8'), 'new\n');
});

test('collaborative flush refuses a newer disk version and keeps the live draft', async (t) => {
  const id = 'collab-external-change';
  const root = await project(id);
  const key = `${id}:main.tex`;
  const doc = await getOrCreateDoc({ key, absPath: path.join(root, 'main.tex') });
  t.after(() => { clearTimeout(doc.flushTimer); doc.awareness.destroy(); doc.ydoc.destroy(); });
  doc.text.insert(0, 'draft ');
  await fs.writeFile(doc.absPath, 'external edit\n');
  await assert.rejects(() => flushDocNow(key), { code: 'DOCUMENT_VERSION_CONFLICT' });
  assert.equal(doc.text.toString(), 'draft old\n');
  assert.equal(await fs.readFile(doc.absPath, 'utf8'), 'external edit\n');
});

test('ordinary saves synchronize clean open documents and reject unsaved collaborative edits', async (t) => {
  const id = 'save-live-document';
  const root = await project(id);
  const key = `${id}:main.tex`;
  const doc = await getOrCreateDoc({ key, absPath: path.join(root, 'main.tex') });
  const app = Fastify();
  registerProjectRoutes(app);
  t.after(async () => { clearTimeout(doc.flushTimer); doc.awareness.destroy(); doc.ydoc.destroy(); await app.close(); });
  const url = `/api/projects/${id}/file`;
  const saved = await app.inject({ method: 'PUT', url, payload: { path: 'main.tex', content: 'new saved content\n' } });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(doc.text.toString(), 'new saved content\n');
  await flushDocNow(key);
  assert.equal(await fs.readFile(doc.absPath, 'utf8'), 'new saved content\n');
  doc.text.insert(0, 'unsaved ');
  const conflict = await app.inject({ method: 'PUT', url, payload: { path: 'main.tex', content: 'overwrite draft', expectedVersion: saved.json().version } });
  assert.equal(conflict.statusCode, 409, conflict.body);
  assert.equal(doc.text.toString(), 'unsaved new saved content\n');
  assert.equal(await fs.readFile(doc.absPath, 'utf8'), 'new saved content\n');
});

test('HTTP Run and save contracts expose versions, precise decisions and idempotency', async (t) => {
  const id = 'http-contract';
  await project(id);
  const app = Fastify();
  registerProjectRoutes(app);
  registerHarnessRunRoutes(app);
  t.after(() => app.close());
  const fileUrl = `/api/projects/${id}/file`;
  const base = `/api/projects/${id}/harness-runs`;
  const read = await app.inject({ method: 'GET', url: `${fileUrl}?path=main.tex` });
  assert.equal(read.statusCode, 200);
  const version = read.json().version;
  assert.deepEqual(version, { exists: true, sha256: sha256('old\n') });
  const created = await app.inject({ method: 'POST', url: base, payload: { adapter: 'fake', fakePatches: [{ path: 'main.tex', content: 'new\n' }] } });
  assert.equal(created.statusCode, 201, created.body);
  const runId = created.json().run.id;
  await runtime.startHarnessRun(id, runId, { wait: true });
  const list = (await app.inject({ method: 'GET', url: base })).json();
  assert.equal(list.runs[0].id, runId);
  const accepted = await app.inject({ method: 'POST', url: `${base}/${runId}/decision`, payload: { decision: 'accept', paths: ['main.tex'] } });
  assert.equal(accepted.json().run.patchDecisions['main.tex'].status, 'accepted');
  const applied = await app.inject({ method: 'POST', url: `${base}/${runId}/apply`, payload: { paths: ['main.tex'] } });
  assert.equal(applied.statusCode, 200, applied.body);
  const repeated = await app.inject({ method: 'POST', url: `${base}/${runId}/apply` });
  assert.deepEqual(repeated.json().alreadyApplied, ['main.tex']);
  const staleSave = await app.inject({ method: 'PUT', url: fileUrl, payload: { path: 'main.tex', content: 'stale draft', expectedVersion: version } });
  assert.equal(staleSave.statusCode, 409);
  assert.equal((await app.inject({ method: 'GET', url: `${fileUrl}?path=main.tex` })).json().content, 'new\n');
  let release;
  let entered;
  const locked = new Promise((resolve) => { entered = resolve; });
  const held = withHarnessRunLock(id, () => { entered(); return new Promise((resolve) => { release = resolve; }); });
  await locked;
  const save = app.inject({ method: 'PUT', url: fileUrl, payload: { path: 'main.tex', content: 'later edit' } });
  release();
  await held;
  assert.equal((await save).statusCode, 200);
});

test('editor task creation rejects a saved-document mismatch before persisting a Run', async () => {
  const id = 'stale-document';
  await project(id);
  await assert.rejects(() => runtime.createHarnessRun(id, {
    adapter: 'fake', source: 'editor', activePath: 'main.tex',
    document: { path: 'main.tex', sha256: sha256('unsaved draft') }
  }), { code: 'DOCUMENT_VERSION_CONFLICT' });
  assert.deepEqual(await runtime.listHarnessRuns(id), []);
});
