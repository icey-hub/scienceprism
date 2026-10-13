import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Fastify from 'fastify';
import { createCodePreparationService } from '../src/services/experimentRunner/codePreparations.js';
import { registerCodePreparationRoutes } from '../src/routes/codePreparations.js';
import { ExperimentRunnerError } from '../src/services/experimentRunner/errors.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const baseContent = 'print("base")\n', code = 'print("prepared")\n', relative = 'research/baseline.py';
const rejected = code => error => error instanceof ExperimentRunnerError && error.code === code && !error.message.includes('/private');
async function fixture(t, { newFile = false } = {}) {
  const cache = path.resolve('.cache/code-preparation-tests'); await fs.mkdir(cache, { recursive: true });
  const temporary = await fs.mkdtemp(path.join(cache, 'case-')), projectRoot = path.join(temporary, 'project');
  await fs.mkdir(path.join(projectRoot, 'research'), { recursive: true });
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  if (!newFile) await fs.writeFile(path.join(projectRoot, relative), baseContent);
  const patch = { path: relative, content: code, baseVersion: { exists: !newFile, sha256: newFile ? null : hash(baseContent) } };
  const parent = { id: 'parent-run', projectId: 'code-project', status: 'completed', adapter: 'deepseek', attempt: 2, patches: [structuredClone(patch)],
    events: [{ type: 'runtime/delegation', phase: 'completed', runtime: 'codex', parentRunId: 'parent-run', childRunId: 'child-run', attempt: 2 }] };
  const child = { id: 'child-run', projectId: parent.projectId, parentRunId: parent.id, parentAttempt: 2, status: 'completed', adapter: 'codex',
    kind: 'codex-worker', recovery: { phase: 'handed-off' }, workerStorage: { stopConfirmed: true }, workerResult: { ok: true }, patches: [structuredClone(patch)] };
  const options = { resolveProject: async id => { if (id !== parent.projectId) throw new Error('/private/foreign/project'); return projectRoot; },
    getRun: async (id, runId) => { if (id !== parent.projectId) throw new Error('/private/foreign/run'); const run = [parent, child].find(item => item.id === runId); if (!run) throw new Error('/private/run/missing'); return structuredClone(run); },
    listRuns: async (id, query) => { assert.equal(id, parent.projectId); assert.equal(query.parentRunId, parent.id); return [structuredClone(child)]; } };
  const service = createCodePreparationService(options), create = () => service.create(parent.projectId, { sourceRunId: parent.id, paths: [relative] });
  const store = path.join(temporary, '.scienceprism-code-preparations', hash(parent.projectId));
  async function workspace() {
    const root = path.join(temporary, `workspace-${Math.random().toString(16).slice(2)}`); await fs.mkdir(path.join(root, 'research'), { recursive: true });
    if (!newFile) await fs.writeFile(path.join(root, relative), baseContent); return root;
  }
  return { temporary, projectRoot, parent, child, options, service, create, store, workspace };
}

test('fixed Codex proposal deduplicates immutable owned read-only records and survives service recreation', async t => {
  const f = await fixture(t), first = await f.create(), second = await f.create();
  assert.equal(first.cached, false); assert.equal(second.cached, true); assert.equal(first.preparation.id, second.preparation.id);
  assert.deepEqual(first.preparation.source, { runId: f.parent.id, childRunIds: [f.child.id] });
  assert.equal(Object.hasOwn(first.preparation.files[0], 'content'), false); assert.equal(JSON.stringify(first).includes(f.projectRoot), false);
  const target = path.join(f.store, `${first.preparation.id}.json`), stat = await fs.lstat(target); assert.equal(stat.nlink, 1); assert.equal(stat.mode & 0o777, 0o400);
  const resumed = createCodePreparationService(f.options);
  assert.deepEqual(await resumed.get(f.parent.projectId, first.preparation.id), first.preparation);
  assert.deepEqual((await resumed.list(f.parent.projectId)).preparations, [first.preparation]);
  const verified = await resumed.verify(f.parent.projectId, first.preparation.id, first.preparation.sha256); assert.equal(verified.files[0].content, code);
  assert.equal(await fs.readFile(path.join(f.projectRoot, relative), 'utf8'), baseContent);
});

test('source request permits only canonical source code paths and rejects untrusted child IDs', async t => {
  const f = await fixture(t);
  for (const paths of [[], [relative, relative], ['../baseline.py'], ['./baseline.py'], ['research\\baseline.py'], ['.env/a.py'], ['research/data.csv']]) {
    await assert.rejects(f.service.create(f.parent.projectId, { sourceRunId: f.parent.id, paths }), error => error instanceof ExperimentRunnerError);
  }
  await assert.rejects(f.service.create(f.parent.projectId, { sourceRunId: f.parent.id, paths: [relative], workerRunId: f.child.id }), rejected('CODE_PREPARATION_INPUT_INVALID'));
  await assert.rejects(f.service.create('../foreign', { sourceRunId: f.parent.id, paths: [relative] }), rejected('CODE_PREPARATION_PROJECT_INVALID'));
  f.parent.patches[0].content = f.child.patches[0].content = 'x'.repeat(1024 * 1024 + 1);
  await assert.rejects(f.create(), rejected('CODE_PREPARATION_TOO_LARGE'));
});

test('parent must be a completed stopped DeepSeek producer for this exact project', async t => {
  const f = await fixture(t), original = structuredClone(f.parent);
  for (const patch of [{ status: 'running' }, { adapter: 'codex' }, { projectId: 'foreign' }, { cleanup: { modelSlotRetained: true } }, { attempt: 3 }]) {
    Object.assign(f.parent, structuredClone(original), patch);
    await assert.rejects(f.service.create(original.projectId, { sourceRunId: original.id, paths: [relative] }), error => error instanceof ExperimentRunnerError);
  }
});

test('fake or unstopped child identities cannot certify a parent code proposal', async t => {
  const f = await fixture(t), original = structuredClone(f.child);
  for (const patch of [{ parentRunId: 'foreign' }, { parentAttempt: 1 }, { kind: 'task' }, { adapter: 'deepseek' }, { status: 'failed' },
    { workerStorage: { stopConfirmed: false } }, { recovery: { phase: 'worker-completed' } }, { workerResult: { ok: false } }, { projectId: 'foreign' }]) {
    Object.assign(f.child, structuredClone(original), patch);
    await assert.rejects(f.create(), rejected('CODE_PREPARATION_HANDOFF_MISMATCH'));
  }
});

test('parent overwritten, deleted or duplicate patches fail matching against the actual Codex child', async t => {
  const f = await fixture(t), original = structuredClone(f.parent.patches);
  for (const patch of [{ content: 'print("overwritten")' }, { deleted: true }, { baseVersion: { exists: true, sha256: 'f'.repeat(64) } }]) {
    f.parent.patches = [{ ...original[0], ...patch }]; await assert.rejects(f.create(), error => error instanceof ExperimentRunnerError);
  }
  f.parent.patches = [original[0], original[0]]; await assert.rejects(f.create(), rejected('CODE_PREPARATION_PATCH_INVALID'));
});

test('selected files can be discovered through the actual parent ledger when delegation events were retained out', async t => {
  const f = await fixture(t); f.parent.events = [];
  assert.equal((await f.create()).preparation.source.childRunIds[0], f.child.id);
  f.options.listRuns = async () => [];
  await assert.rejects(createCodePreparationService(f.options).create(f.parent.projectId, { sourceRunId: f.parent.id, paths: [relative] }), rejected('CODE_PREPARATION_CHILD_REQUIRED'));
});

test('verify rejects changed parent contents, attempts, child stopping and source project baseline', async t => {
  const f = await fixture(t), { preparation } = await f.create();
  const verify = () => f.service.verify(f.parent.projectId, preparation.id, preparation.sha256);
  f.parent.patches[0].content = 'print("changed")'; await assert.rejects(verify(), rejected('CODE_PREPARATION_HANDOFF_MISMATCH'));
  f.parent.patches[0].content = code; f.parent.attempt++; await assert.rejects(verify(), rejected('CODE_PREPARATION_CHILD_CHANGED')); f.parent.attempt--;
  f.child.workerStorage.stopConfirmed = false; await assert.rejects(verify(), rejected('CODE_PREPARATION_CHILD_CHANGED')); f.child.workerStorage.stopConfirmed = true;
  await fs.writeFile(path.join(f.projectRoot, relative), 'new project code'); await assert.rejects(verify(), rejected('CODE_PREPARATION_BASE_CHANGED'));
  await assert.rejects(f.service.verify(f.parent.projectId, preparation.id, 'f'.repeat(64)), rejected('CODE_PREPARATION_VERSION_CHANGED'));
  await assert.rejects(f.service.get(f.parent.projectId, preparation.id), rejected('CODE_PREPARATION_BASE_CHANGED'));
});

test('private record byte tampering, symbolic and hard links cannot masquerade as an immutable code version', async t => {
  for (const kind of ['tamper', 'symbolic', 'hard']) {
    const f = await fixture(t), { preparation } = await f.create(), target = path.join(f.store, `${preparation.id}.json`), saved = path.join(f.temporary, 'preserved.json');
    if (kind === 'tamper') { const record = JSON.parse(await fs.readFile(target, 'utf8')); record.files[0].content = 'changed'; await fs.chmod(target, 0o600); await fs.writeFile(target, JSON.stringify(record)); await fs.chmod(target, 0o400); }
    else { await fs.rename(target, saved); if (kind === 'symbolic') await fs.symlink(saved, target); else await fs.link(saved, target); }
    await assert.rejects(f.service.verify(f.parent.projectId, preparation.id, preparation.sha256), error => error instanceof ExperimentRunnerError);
    if (kind !== 'tamper') assert.ok((await fs.readFile(saved, 'utf8')).includes(code.replaceAll('"', '\\"').trim()));
  }
});

test('project baseline and private control directories reject symbolic or hard linked files', async t => {
  const f = await fixture(t), target = path.join(f.projectRoot, relative), preserved = path.join(f.temporary, 'preserved.py');
  await fs.rename(target, preserved); await fs.symlink(preserved, target); await assert.rejects(f.create(), error => error instanceof ExperimentRunnerError);
  await fs.unlink(target); await fs.link(preserved, target); await assert.rejects(f.create(), rejected('CODE_PREPARATION_UNSAFE_STORAGE'));
  await fs.unlink(target); await fs.rename(preserved, target);
  const control = path.dirname(f.store), saved = `${control}-saved`; await fs.rename(control, saved); await fs.symlink(saved, control);
  await assert.rejects(f.create(), rejected('CODE_PREPARATION_UNSAFE_STORAGE'));
});

test('workspace overlays only selected base-matching files read-only without altering the original project', async t => {
  const f = await fixture(t), { preparation } = await f.create(), root = await f.workspace();
  await fs.writeFile(path.join(root, 'unselected.txt'), 'retain');
  const result = await f.service.prepareWorkspace(f.parent.projectId, preparation.id, preparation.sha256, root);
  assert.equal(result.files[0].verified, true); assert.equal(await fs.readFile(path.join(root, relative), 'utf8'), code);
  assert.equal((await fs.lstat(path.join(root, relative))).mode & 0o777, 0o400);
  assert.equal(await fs.readFile(path.join(root, 'unselected.txt'), 'utf8'), 'retain');
  assert.equal(await fs.readFile(path.join(f.projectRoot, relative), 'utf8'), baseContent);
});

test('new code files are created exclusively and workspace CAS mismatch cannot overwrite existing files', async t => {
  const f = await fixture(t, { newFile: true }), { preparation } = await f.create(), root = await f.workspace();
  await f.service.prepareWorkspace(f.parent.projectId, preparation.id, preparation.sha256, root);
  assert.equal(await fs.readFile(path.join(root, relative), 'utf8'), code);
  await assert.rejects(f.service.prepareWorkspace(f.parent.projectId, preparation.id, preparation.sha256, root), rejected('CODE_PREPARATION_OVERLAY_CONFLICT'));
  assert.equal(await fs.readFile(path.join(root, relative), 'utf8'), code);
});

test('spawn and stop checks reject mutated writable or linked prepared code instead of certifying it', async t => {
  const f = await fixture(t), { preparation } = await f.create();
  for (const kind of ['content', 'writable', 'hard']) {
    const root = await f.workspace(); await f.service.prepareWorkspace(f.parent.projectId, preparation.id, preparation.sha256, root);
    assert.equal((await f.service.assertWorkspace(f.parent.projectId, preparation.id, preparation.sha256, root)).files[0].verified, true);
    const target = path.join(root, relative);
    if (kind === 'content') { await fs.chmod(target, 0o600); await fs.writeFile(target, 'print("tampered")\n'); await fs.chmod(target, 0o400); }
    if (kind === 'writable') await fs.chmod(target, 0o600);
    if (kind === 'hard') await fs.link(target, path.join(root, 'alias.py'));
    await assert.rejects(f.service.assertWorkspace(f.parent.projectId, preparation.id, preparation.sha256, root), error => error instanceof ExperimentRunnerError);
  }
});

test('overlay rejects target links and directory swaps while preserving external target files', async t => {
  const f = await fixture(t), { preparation } = await f.create();
  for (const kind of ['symbolic', 'hard', 'parent']) {
    const root = await f.workspace(), preserved = path.join(root, 'preserved.py'), target = path.join(root, relative);
    await fs.rename(target, preserved);
    if (kind === 'symbolic') await fs.symlink(preserved, target);
    if (kind === 'hard') await fs.link(preserved, target);
    if (kind === 'parent') { await fs.rm(path.dirname(target), { recursive: true }); await fs.symlink(f.projectRoot, path.dirname(target)); }
    await assert.rejects(f.service.prepareWorkspace(f.parent.projectId, preparation.id, preparation.sha256, root), error => error instanceof ExperimentRunnerError);
    assert.equal(await fs.readFile(preserved, 'utf8'), baseContent);
  }
  assert.equal(await fs.readFile(path.join(f.projectRoot, relative), 'utf8'), baseContent);
});

test('abort and guard revocation prevent overlays, including changes made immediately before atomic publication', async t => {
  const f = await fixture(t), { preparation } = await f.create(), root = await f.workspace(), controller = new AbortController(); controller.abort();
  await assert.rejects(f.service.prepareWorkspace(f.parent.projectId, preparation.id, preparation.sha256, root, { signal: controller.signal }), rejected('CODE_PREPARATION_CANCELLED'));
  await assert.rejects(f.service.prepareWorkspace(f.parent.projectId, preparation.id, preparation.sha256, root, { beforeEffect: () => { throw new Error('/private/key'); } }), rejected('CODE_PREPARATION_AUTHORIZATION_REVOKED'));
  let changed = false;
  await assert.rejects(f.service.prepareWorkspace(f.parent.projectId, preparation.id, preparation.sha256, root, { beforeEffect: async () => {
    if (!changed && (await fs.readdir(path.join(root, 'research'))).some(name => name.startsWith('.code-'))) { changed = true; await fs.writeFile(path.join(root, relative), 'changed workspace'); }
  } }), rejected('CODE_PREPARATION_OVERLAY_CONFLICT'));
  assert.equal(changed, true); assert.equal(await fs.readFile(path.join(root, relative), 'utf8'), 'changed workspace');
  assert.equal((await fs.readdir(path.join(root, 'research'))).some(name => name.startsWith('.code-')), false);
});

test('actual HTTP list/create/get enforce strict bounded source selection and never expose code contents', async t => {
  const f = await fixture(t), app = Fastify(); registerCodePreparationRoutes(app, { service: f.service }); t.after(() => app.close());
  const base = `/api/projects/${f.parent.projectId}/code-preparations`;
  assert.deepEqual((await app.inject({ method: 'GET', url: base })).json().preparations, []);
  const created = await app.inject({ method: 'POST', url: base, payload: { sourceRunId: f.parent.id, paths: [relative] } });
  assert.equal(created.statusCode, 200); assert.equal(created.json().cached, false);
  const preparation = created.json().preparation;
  const got = await app.inject({ method: 'GET', url: `${base}/${preparation.id}` }); assert.equal(got.statusCode, 200);
  assert.equal(Object.hasOwn(got.json().preparation.files[0], 'content'), false);
  const rejectedInput = await app.inject({ method: 'POST', url: base, payload: { sourceRunId: f.parent.id, paths: [relative], workerRunId: f.child.id } }); assert.equal(rejectedInput.statusCode, 400);
});
