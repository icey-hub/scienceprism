import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { datasetService } from '../datasets/index.js';
import { datasetFilename } from '../datasets/preview.js';
import { MAX_DATASET_BYTES } from '../datasets/download.js';
import { ExperimentRunnerError } from './errors.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = (code, message, status = 409) => { throw new ExperimentRunnerError(status, code, message); };
const owned = stat => !process.getuid || stat.uid === process.getuid();
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
const managed = dataset => typeof dataset?.id === 'string' && /^dataset-[a-f0-9]{64}$/.test(dataset.id);

function datasetSha(dataset) {
  if (typeof dataset?.id !== 'string' || !/^dataset-[a-f0-9]{64}$/.test(dataset.id)
    || dataset.version !== dataset.id.slice(8)) fail('EXPERIMENT_DATASET_VERSION_INVALID', '请选择数据页中的固定 SHA256 数据版本。', 400);
  return dataset.version;
}

function fixedInput(projectId, selected, stored) {
  const sha256 = datasetSha(selected);
  if (stored?.id !== selected.id || stored.projectId !== projectId || stored.sha256 !== sha256
    || !Number.isSafeInteger(stored.byteLength) || stored.byteLength < 1 || stored.byteLength > MAX_DATASET_BYTES) {
    fail('EXPERIMENT_DATASET_SOURCE_CHANGED', '本项目的原始数据或固定版本记录已变化。');
  }
  let filename;
  try { filename = datasetFilename(stored.filename); }
  catch { fail('EXPERIMENT_DATASET_METADATA_INVALID', '原始数据文件名不安全。', 400); }
  const source = stored.source, license = stored.license;
  if (!source || !['import', 'https', 'huggingface'].includes(source.kind)
    || Object.keys(source).some(key => !['kind', 'url', 'revision'].includes(key))
    || !(source.revision === null || typeof source.revision === 'string' && source.revision.length <= 300)
    || (source.kind === 'import' ? source.url !== null : typeof source.url !== 'string' || !/^https:\/\//.test(source.url))
    || !license || typeof license.label !== 'string' || !license.label || license.label.length > 300
    || typeof license.verified !== 'boolean' || Object.keys(license).some(key => !['label', 'verified'].includes(key))
    || !['train', 'validation', 'test', 'unknown'].includes(stored.split)) {
    fail('EXPERIMENT_DATASET_METADATA_INVALID', '原始数据来源、许可或划分记录无效。', 400);
  }
  return { path: `data/${sha256}/${filename}`, sha256, byteLength: stored.byteLength, filename,
    source: structuredClone(source), license: structuredClone(license), split: stored.split };
}

function inputMetadata(dataset) {
  const sha256 = datasetSha(dataset), input = dataset.input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('EXPERIMENT_DATASET_INPUT_INVALID', '实验数据输入记录无效。', 400);
  // Reuse the domain metadata checks; only this canonical relative location is accepted.
  const canonical = fixedInput('input', dataset, { ...input, id: dataset.id, projectId: 'input', sha256 });
  if (!isDeepStrictEqual(input, canonical)) fail('EXPERIMENT_DATASET_INPUT_INVALID', '实验数据路径或固定元数据已变化。', 400);
  return canonical;
}

async function typed(operation) {
  try { return await operation(); }
  catch (error) {
    if (error instanceof ExperimentRunnerError) throw error;
    if (error?.code === 'DATASET_NOT_FOUND') fail('EXPERIMENT_DATASET_NOT_FOUND', '本项目没有这个数据版本。', 404);
    fail('EXPERIMENT_DATASET_UNAVAILABLE', '实验数据无法安全读取或准备，请核对原始版本。');
  }
}

/** Resolve only the dataset domain's immutable versions; legacy notes remain unchanged. */
export async function resolveExperimentDataset(projectId, dataset, { service = datasetService } = {}) {
  if (!managed(dataset)) {
    if (dataset?.input) fail('EXPERIMENT_DATASET_VERSION_INVALID', '只有固定 SHA256 数据版本能够绑定原始输入。', 400);
    return dataset;
  }
  return typed(async () => {
    datasetSha(dataset);
    const stored = await service.get(projectId, dataset.id);
    return { ...dataset, input: fixedInput(projectId, dataset, stored) };
  });
}

async function checkDirectory(target) {
  const stat = await fs.lstat(target);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !owned(stat) || await fs.realpath(target) !== target) {
    fail('EXPERIMENT_DATASET_UNSAFE_PATH', '实验数据目录必须是本进程拥有的真实目录。', 403);
  }
  return stat;
}

async function directories(workspaceRoot, input, { create = false, guard = async () => {} } = {}) {
  if (typeof workspaceRoot !== 'string' || !path.isAbsolute(workspaceRoot) || path.normalize(workspaceRoot) !== workspaceRoot) {
    fail('EXPERIMENT_DATASET_UNSAFE_PATH', '实验工作区路径无效。', 403);
  }
  const list = [{ target: workspaceRoot, stat: await checkDirectory(workspaceRoot) }];
  for (const component of ['data', input.sha256]) {
    const target = path.join(list.at(-1).target, component);
    if (create) {
      await guard(); await recheckDirectories(list);
      try { await fs.mkdir(target, { mode: 0o700 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    list.push({ target, stat: await checkDirectory(target) });
  }
  return list;
}

async function recheckDirectories(list) {
  for (const item of list) if (!sameFile(item.stat, await checkDirectory(item.target))) {
    fail('EXPERIMENT_DATASET_UNSAFE_PATH', '实验数据目录在准备期间发生变化。', 403);
  }
}

async function verifyFile(target, input, list) {
  await recheckDirectories(list);
  const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || !owned(before) || before.size !== input.byteLength
      || before.mode & 0o222 || before.size > MAX_DATASET_BYTES) {
      fail('EXPERIMENT_DATASET_INPUT_CHANGED', '实验数据输入已改变，必须使用固定只读版本。');
    }
    const digest = createHash('sha256'), buffer = Buffer.alloc(Math.min(64 * 1024, input.byteLength + 1));
    let byteLength = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, input.byteLength + 1 - byteLength), byteLength);
      if (!bytesRead) break;
      byteLength += bytesRead;
      if (byteLength > input.byteLength) fail('EXPERIMENT_DATASET_INPUT_CHANGED', '实验数据输入超出固定版本大小。');
      digest.update(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat(), current = await fs.lstat(target);
    await recheckDirectories(list);
    if (!sameFile(before, current) || current.isSymbolicLink() || after.nlink !== 1 || current.nlink !== 1
      || after.mode & 0o222 || current.mode & 0o222 || after.size !== input.byteLength
      || byteLength !== input.byteLength || digest.digest('hex') !== input.sha256) {
      fail('EXPERIMENT_DATASET_INPUT_CHANGED', '实验数据输入内容与固定 SHA256 不符。');
    }
    return { ...structuredClone(input), verified: true };
  } finally { await handle.close(); }
}

/** Copy verified domain bytes into the isolated workspace, never a caller's private path. */
export async function prepareExperimentDataset(projectId, workspaceRoot, dataset, { service = datasetService, beforeEffect, signal } = {}) {
  if (!dataset?.input) {
    if (managed(dataset)) fail('EXPERIMENT_DATASET_BINDING_REQUIRED', '请新建实验以绑定数据页中的固定原始版本。');
    return null;
  }
  return typed(async () => {
    const input = inputMetadata(dataset);
    const guard = async () => {
      if (signal?.aborted) fail('EXPERIMENT_DATASET_CANCELLED', '实验数据准备已停止。');
      try { await beforeEffect?.(); }
      catch { fail('EXPERIMENT_DATASET_AUTHORIZATION_REVOKED', '实验数据准备授权已变化。', 403); }
      if (signal?.aborted) fail('EXPERIMENT_DATASET_CANCELLED', '实验数据准备已停止。');
    };
    await guard();
    const content = await service.content(projectId, dataset.id);
    if (!isDeepStrictEqual(input, fixedInput(projectId, dataset, content.dataset))
      || !Buffer.isBuffer(content.bytes) || content.bytes.length !== input.byteLength || hash(content.bytes) !== input.sha256) {
      fail('EXPERIMENT_DATASET_SOURCE_CHANGED', '原始数据或来源记录与实验固定版本不符。');
    }
    await guard();
    const list = await directories(workspaceRoot, input, { create: true, guard });
    const target = path.join(list.at(-1).target, input.filename);
    await guard(); await recheckDirectories(list);
    let handle;
    try { handle = await fs.open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o400); }
    catch (error) {
      if (error.code === 'EEXIST') fail('EXPERIMENT_DATASET_INPUT_COLLISION', '实验工作区已存在同名数据输入，不能覆盖。');
      throw error;
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || !owned(stat)) fail('EXPERIMENT_DATASET_UNSAFE_PATH', '实验数据目标文件不安全。', 403);
      await guard(); await recheckDirectories(list);
      await handle.writeFile(content.bytes); await handle.sync();
      await guard(); await recheckDirectories(list);
    } finally { await handle.close(); }
    await guard();
    const verified = await verifyFile(target, input, list);
    if (signal?.aborted) fail('EXPERIMENT_DATASET_CANCELLED', '实验数据准备已停止。');
    return verified;
  });
}

/** Used immediately before launch and after process stop; writable or mutated data is rejected. */
export async function assertExperimentDatasetInput(workspaceRoot, dataset) {
  if (!dataset?.input) {
    if (managed(dataset)) fail('EXPERIMENT_DATASET_BINDING_REQUIRED', '请新建实验以绑定数据页中的固定原始版本。');
    return null;
  }
  return typed(async () => {
    const input = inputMetadata(dataset), list = await directories(workspaceRoot, input);
    return verifyFile(path.join(list.at(-1).target, input.filename), input, list);
  });
}
