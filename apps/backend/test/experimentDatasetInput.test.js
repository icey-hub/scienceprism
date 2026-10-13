import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { resolveExperimentDataset, prepareExperimentDataset, assertExperimentDatasetInput } from '../src/services/experimentRunner/datasetInput.js';
import { ExperimentRunnerError } from '../src/services/experimentRunner/errors.js';

const bytes = Buffer.from('x,label\n1,a\n2,b\n'), sha256 = createHash('sha256').update(bytes).digest('hex');
const selected = { id: `dataset-${sha256}`, version: sha256, evidenceId: null };
const original = { id: selected.id, projectId: 'dataset-input', sha256, byteLength: bytes.length, filename: 'samples.csv',
  source: { kind: 'https', url: 'https://archive.ics.uci.edu/static/public/1/data.csv', revision: null },
  license: { label: 'CC BY 4.0', verified: false }, split: 'train' };
const service = {
  async get(projectId, id) { if (projectId !== original.projectId || id !== original.id) throw Object.assign(new Error('/private/domain/path'), { code: 'DATASET_NOT_FOUND' }); return structuredClone(original); },
  async content(projectId, id) { return { dataset: await this.get(projectId, id), bytes: Buffer.from(bytes) }; }
};
const rejectCode = code => error => error instanceof ExperimentRunnerError && error.code === code && !error.message.includes('/private');
async function workspace(t) {
  const base = path.resolve('.cache/experiment-dataset-input-tests'); await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'case-')); t.after(() => fs.rm(root, { recursive: true, force: true })); return root;
}
const bound = () => resolveExperimentDataset(original.projectId, selected, { service });

test('legacy notes remain unchanged while managed inputs require a fixed binding', async () => {
  const legacy = { id: 'dataset-eval', version: 'paper-v1' };
  assert.equal(await resolveExperimentDataset('legacy', legacy, { service }), legacy);
  assert.equal(await prepareExperimentDataset('legacy', 'not-used', legacy), null);
  assert.equal(await assertExperimentDatasetInput('not-used', legacy), null);
  await assert.rejects(prepareExperimentDataset(original.projectId, 'not-used', selected), rejectCode('EXPERIMENT_DATASET_BINDING_REQUIRED'));
  await assert.rejects(assertExperimentDatasetInput('not-used', selected), rejectCode('EXPERIMENT_DATASET_BINDING_REQUIRED'));
});

test('resolve pins actual project content and rejects invalid, stale and cross-project versions', async () => {
  const dataset = await bound();
  assert.deepEqual(dataset.input, { path: `data/${sha256}/samples.csv`, sha256, byteLength: bytes.length,
    filename: original.filename, source: original.source, license: original.license, split: original.split });
  for (const value of [{ id: 'dataset-local', version: 'v1', input: {} }, { ...selected, version: 'f'.repeat(64) }, { ...selected, version: null }]) {
    await assert.rejects(resolveExperimentDataset(original.projectId, value, { service }), rejectCode('EXPERIMENT_DATASET_VERSION_INVALID'));
  }
  await assert.rejects(resolveExperimentDataset('foreign-project', selected, { service }), rejectCode('EXPERIMENT_DATASET_NOT_FOUND'));
  await assert.rejects(resolveExperimentDataset(original.projectId, selected, { service: { get: async () => ({ ...original, projectId: 'foreign' }) } }), rejectCode('EXPERIMENT_DATASET_SOURCE_CHANGED'));
});

test('prepare actually copies fixed bytes as a standalone read-only file and verifies repeated reads', async t => {
  const root = await workspace(t), dataset = await bound(), guards = [];
  const result = await prepareExperimentDataset(original.projectId, root, dataset, { service, beforeEffect: () => guards.push('checked') });
  const target = path.join(root, dataset.input.path), stat = await fs.lstat(target);
  assert.equal(result.verified, true); assert.equal(result.path, dataset.input.path); assert.ok(guards.length >= 6);
  assert.equal(stat.mode & 0o777, 0o400); assert.equal(stat.nlink, 1);
  assert.deepEqual(await fs.readFile(target), bytes);
  assert.deepEqual(await assertExperimentDatasetInput(root, dataset), result);
  assert.equal(JSON.stringify(result).includes(root), false);
});

test('changed source bytes or metadata cannot be copied under the original manifest', async t => {
  const root = await workspace(t), dataset = await bound();
  for (const patch of [{ bytes: Buffer.from('changed') }, { dataset: { ...original, split: 'test' } }, { dataset: { ...original, projectId: 'other' } }, { dataset: { ...original, license: { label: 'different', verified: false } } }]) {
    await assert.rejects(prepareExperimentDataset(original.projectId, root, dataset, { service: { content: async () => ({ dataset: original, bytes, ...patch }) } }), rejectCode('EXPERIMENT_DATASET_SOURCE_CHANGED'));
  }
  assert.deepEqual(await fs.readdir(root), []);
});

test('forged private paths, executable filenames and altered fixed metadata are rejected', async t => {
  const root = await workspace(t), dataset = await bound();
  for (const patch of [{ path: '/private/domain/blob' }, { path: '../outside.csv' }, { sha256: 'f'.repeat(64) }, { filename: 'code.py' }, { byteLength: bytes.length + 1 }, { privatePath: '/private/domain/blob' }]) {
    await assert.rejects(prepareExperimentDataset(original.projectId, root, { ...dataset, input: { ...dataset.input, ...patch } }, { service }), error => error instanceof ExperimentRunnerError && !error.message.includes('/private'));
  }
  await assert.rejects(prepareExperimentDataset(original.projectId, root, { ...dataset, id: 'dataset-eval' }, { service }), rejectCode('EXPERIMENT_DATASET_VERSION_INVALID'));
  await assert.rejects(resolveExperimentDataset(original.projectId, selected, { service: { get: async () => ({ ...original, filename: '../samples.csv' }) } }), rejectCode('EXPERIMENT_DATASET_METADATA_INVALID'));
  assert.deepEqual(await fs.readdir(root), []);
});

test('symlinked workspace and each input directory are refused without touching their targets', async t => {
  const root = await workspace(t), dataset = await bound();
  const preserved = path.join(root, 'preserved'); await fs.mkdir(preserved); await fs.writeFile(path.join(preserved, 'note.txt'), 'preserve');
  const linked = path.join(root, 'linked'); await fs.symlink(preserved, linked);
  await assert.rejects(prepareExperimentDataset(original.projectId, linked, dataset, { service }), rejectCode('EXPERIMENT_DATASET_UNSAFE_PATH'));
  await fs.symlink(preserved, path.join(root, 'data'));
  await assert.rejects(prepareExperimentDataset(original.projectId, root, dataset, { service }), rejectCode('EXPERIMENT_DATASET_UNSAFE_PATH'));
  await fs.unlink(path.join(root, 'data')); await fs.mkdir(path.join(root, 'data')); await fs.symlink(preserved, path.join(root, 'data', sha256));
  await assert.rejects(prepareExperimentDataset(original.projectId, root, dataset, { service }), rejectCode('EXPERIMENT_DATASET_UNSAFE_PATH'));
  assert.deepEqual(await fs.readdir(preserved), ['note.txt']); assert.equal(await fs.readFile(path.join(preserved, 'note.txt'), 'utf8'), 'preserve');
});

test('existing ordinary, symbolic and hard-linked targets are never overwritten', async t => {
  const dataset = await bound();
  for (const kind of ['ordinary', 'symbolic', 'hard']) {
    const root = await workspace(t), directory = path.join(root, 'data', sha256); await fs.mkdir(directory, { recursive: true });
    const preserved = path.join(root, 'preserved.csv'), target = path.join(directory, original.filename); await fs.writeFile(preserved, 'preserve');
    if (kind === 'ordinary') await fs.writeFile(target, 'existing');
    else if (kind === 'symbolic') await fs.symlink(preserved, target);
    else await fs.link(preserved, target);
    await assert.rejects(prepareExperimentDataset(original.projectId, root, dataset, { service }), rejectCode('EXPERIMENT_DATASET_INPUT_COLLISION'));
    assert.equal(await fs.readFile(preserved, 'utf8'), 'preserve');
    assert.equal(await fs.readFile(target, 'utf8'), kind === 'ordinary' ? 'existing' : 'preserve');
  }
});

test('pre-cancel and revoked guard stop all data writes without exposing raw causes', async t => {
  const root = await workspace(t), dataset = await bound(), controller = new AbortController(); controller.abort();
  await assert.rejects(prepareExperimentDataset(original.projectId, root, dataset, { service, signal: controller.signal }), rejectCode('EXPERIMENT_DATASET_CANCELLED'));
  await assert.rejects(prepareExperimentDataset(original.projectId, root, dataset, { service, beforeEffect: () => { throw new Error('/private/credential'); } }), rejectCode('EXPERIMENT_DATASET_AUTHORIZATION_REVOKED'));
  assert.deepEqual(await fs.readdir(root), []);
});

test('cancellation after source verification prevents creating the input tree', async t => {
  const root = await workspace(t), dataset = await bound(), controller = new AbortController();
  const abortService = { content: async () => { controller.abort(); return { dataset: original, bytes }; } };
  await assert.rejects(prepareExperimentDataset(original.projectId, root, dataset, { service: abortService, signal: controller.signal }), rejectCode('EXPERIMENT_DATASET_CANCELLED'));
  assert.deepEqual(await fs.readdir(root), []);
});

test('directory replacement in the write guard is detected before a byte is written elsewhere', async t => {
  const root = await workspace(t), dataset = await bound(), elsewhere = path.join(root, 'elsewhere'); await fs.mkdir(elsewhere);
  let changed = false;
  await assert.rejects(prepareExperimentDataset(original.projectId, root, dataset, { service, beforeEffect: async () => {
    const target = path.join(root, 'data', sha256);
    if (!changed && await fs.lstat(target).catch(() => null)) { changed = true; await fs.rename(target, `${target}-saved`); await fs.symlink(elsewhere, target); }
  } }), rejectCode('EXPERIMENT_DATASET_UNSAFE_PATH'));
  assert.equal(changed, true); assert.deepEqual(await fs.readdir(elsewhere), []);
});

test('launch and post-run checks reject content tampering, writable files and new hard links', async t => {
  const dataset = await bound();
  for (const kind of ['content', 'writable', 'hard', 'symbolic']) {
    const root = await workspace(t); await prepareExperimentDataset(original.projectId, root, dataset, { service });
    const target = path.join(root, dataset.input.path);
    if (kind === 'content') { await fs.chmod(target, 0o600); await fs.writeFile(target, Buffer.alloc(bytes.length, 'x')); await fs.chmod(target, 0o400); }
    if (kind === 'writable') await fs.chmod(target, 0o600);
    if (kind === 'hard') await fs.link(target, path.join(root, 'alias.csv'));
    if (kind === 'symbolic') { await fs.rename(target, `${target}.saved`); await fs.symlink(`${target}.saved`, target); }
    await assert.rejects(assertExperimentDatasetInput(root, dataset), error => error instanceof ExperimentRunnerError && !error.message.includes(root));
  }
});

test('raw domain failures are typed and sanitized, with no private filesystem paths retained', async t => {
  const root = await workspace(t), dataset = await bound();
  await assert.rejects(prepareExperimentDataset(original.projectId, root, dataset, { service: { content: async () => { throw new Error('/private/data/original.csv'); } } }), rejectCode('EXPERIMENT_DATASET_UNAVAILABLE'));
  await assert.rejects(assertExperimentDatasetInput(root, dataset), rejectCode('EXPERIMENT_DATASET_UNAVAILABLE'));
});
