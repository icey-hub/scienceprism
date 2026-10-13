import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { getProjectRoot } from '../projectService.js';
import { withHubLock } from '../projectHub/repository.js';
import { safeJoin } from '../../utils/pathUtils.js';
import { DatasetError, MAX_DATASET_BYTES } from './download.js';
import { datasetFilename, previewDataset } from './preview.js';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fail = (code, message, status = 409) => { throw new DatasetError(code, message, status); };
export function isDatasetPrivatePath(value) {
  const relative = path.posix.normalize(String(value).replace(/\\/g, '/')).replace(/^\.\//, '').toLowerCase();
  return relative === '.scienceprism/datasets' || relative.startsWith('.scienceprism/datasets/');
}
export function assertDatasetGenericFileAccess(value, { mutation = false, projectRoot } = {}) {
  const normalized = String(value).replace(/\\/g, '/');
  const relative = (projectRoot ? path.relative(projectRoot, safeJoin(projectRoot, normalized)) : path.posix.normalize(normalized)).replace(/^\.\//, '').toLowerCase();
  if (isDatasetPrivatePath(relative) || mutation && relative === '.scienceprism') fail('DATASET_IMMUTABLE', '请通过数据版本接口读取或导入数据；原始文件和获取回执不可直接编辑。');
}
function directory(target, create = false) {
  if (create) { try { fs.mkdirSync(target, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; } }
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(target) !== target || process.getuid && stat.uid !== process.getuid()) fail('DATASET_UNSAFE_STORAGE', '数据存储目录不安全。');
}
async function regularFile(target, maxBytes, operation) {
  const handle = await fsp.open(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes || process.getuid && stat.uid !== process.getuid()) fail('DATASET_UNSAFE_STORAGE', '数据文件必须为独立、有界的普通文件。');
    return await operation(handle, stat);
  } finally { await handle.close(); }
}
async function fileDigest(target) {
  return regularFile(target, MAX_DATASET_BYTES, async (handle, stat) => {
    const sha = createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false })) sha.update(chunk);
    return { sha256: sha.digest('hex'), byteLength: stat.size };
  });
}

/** One project-owned index, immutable content-addressed data, and partial files.
 * Original bytes remain private; experiments consume a verified version through
 * the domain service rather than editing the acquisition cache. */
export function createDatasetRepository({ resolveProject = getProjectRoot } = {}) {
  async function locations(projectId, { create = false } = {}) {
    let project;
    try { project = await resolveProject(projectId); directory(project); }
    catch { fail('DATASET_PROJECT_NOT_FOUND', '项目不存在或路径不可用。', 404); }
    const metadata = safeJoin(project, '.scienceprism');
    const control = safeJoin(project, '.scienceprism/datasets');
    if (create) { directory(metadata, true); directory(control, true); directory(path.join(control, 'blobs'), true); directory(path.join(control, 'parts'), true); }
    else if (fs.existsSync(control)) { directory(metadata); directory(control); }
    return { project, control, index: path.join(control, 'index.json'), blobs: path.join(control, 'blobs'), parts: path.join(control, 'parts') };
  }
  async function read(projectId) {
    const root = await locations(projectId);
    try {
      return await regularFile(root.index, 4 * 1024 * 1024, async handle => {
        const index = JSON.parse(await handle.readFile('utf8'));
        if (index.schemaVersion !== 1 || index.projectId !== projectId || !Number.isSafeInteger(index.version) || index.version < 1
          || !Array.isArray(index.datasets) || !Array.isArray(index.jobs) || index.datasets.length > 2000 || index.jobs.length > 1000
          || index.datasets.some(item => !hash(item.sha256) || item.id !== `dataset-${item.sha256}` || !Number.isSafeInteger(item.byteLength) || item.byteLength < 1 || item.byteLength > MAX_DATASET_BYTES)
          || new Set(index.datasets.map(item => item.id)).size !== index.datasets.length || new Set(index.jobs.map(item => item.id)).size !== index.jobs.length) fail('DATASET_STORAGE_INVALID', '数据版本索引损坏，请保留原记录。', 500);
        return index;
      });
    } catch (error) {
      if (error.code === 'ENOENT') return { schemaVersion: 1, projectId, version: 1, datasets: [], jobs: [] };
      if (error instanceof DatasetError) throw error;
      fail('DATASET_STORAGE_INVALID', '数据索引不可读取，请保留原记录。', 500);
    }
  }
  async function update(projectId, change, { owner } = {}) {
    return withHubLock(projectId, async () => {
      owner?.assertOwned();
      const root = await locations(projectId, { create: true });
      const index = await read(projectId), result = await change(index, root);
      owner?.assertOwned();
      const temporary = path.join(root.control, `.index-${randomUUID()}.tmp`);
      try {
        index.version++;
        const encoded = JSON.stringify(index, null, 2) + '\n';
        if (Buffer.byteLength(encoded) > 4 * 1024 * 1024) fail('DATASET_STORAGE_LIMIT', '数据索引已达到体积上限，请检查已有任务。');
        await fsp.writeFile(temporary, encoded, { flag: 'wx', mode: 0o600 });
        directory(root.control); owner?.assertOwned();
        await fsp.rename(temporary, root.index);
      } finally { await fsp.rm(temporary, { force: true }); }
      return structuredClone(result);
    });
  }
  async function store(projectId, partial, metadata, { owner } = {}) {
    const filename = datasetFilename(metadata.filename), root = await locations(projectId, { create: true });
    directory(root.parts); directory(root.blobs);
    if (path.dirname(partial) !== root.parts || !/^[a-z0-9-]+\.part$/.test(path.basename(partial))) fail('DATASET_UNSAFE_STORAGE', '数据提交只能读取本项目的暂存文件。');
    const recorded = await fileDigest(partial);
    if (!recorded.byteLength) fail('DATASET_EMPTY', '数据文件为空。', 400);
    if (metadata.expectedSha256 && recorded.sha256 !== metadata.expectedSha256) fail('DATASET_HASH_MISMATCH', '下载内容与预期SHA256不符，未生成数据版本。');
    const sample = await regularFile(partial, MAX_DATASET_BYTES, async (handle, stat) => {
      const bytes = Buffer.alloc(Math.min(stat.size, 1024 * 1024)); await handle.read(bytes, 0, bytes.length, 0); return bytes;
    });
    const preview = previewDataset(sample, { filename, byteLength: recorded.byteLength });
    return update(projectId, async index => {
      const existing = index.datasets.find(item => item.sha256 === recorded.sha256);
      if (index.datasets.length >= 2000 && !existing) fail('DATASET_STORAGE_LIMIT', '数据版本数量达到上限，请先检查已有记录。');
      const target = path.join(root.blobs, recorded.sha256);
      try { await fsp.copyFile(partial, target, fs.constants.COPYFILE_EXCL); await fsp.chmod(target, 0o400); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      const persisted = await fileDigest(target);
      if (persisted.sha256 !== recorded.sha256 || persisted.byteLength !== recorded.byteLength) fail('DATASET_HASH_MISMATCH', '原始数据内容发生变化，不能覆盖已有版本。');
      if (existing) return { dataset: existing, duplicate: true };
      const dataset = { id: `dataset-${recorded.sha256}`, projectId, filename, name: metadata.name || filename,
        ...recorded, source: metadata.source, license: metadata.license || { label: '未记录', verified: false },
        split: metadata.split || 'unknown', preview, acquiredAt: new Date().toISOString(), readOnly: true };
      index.datasets.push(dataset); return { dataset, duplicate: false };
    }, { owner });
  }
  async function content(projectId, datasetId) {
    const dataset = (await read(projectId)).datasets.find(item => item.id === datasetId);
    if (!dataset) fail('DATASET_NOT_FOUND', '本项目没有这个数据版本。', 404);
    const root = await locations(projectId); directory(root.blobs);
    const target = path.join(root.blobs, dataset.sha256);
    let recorded;
    try { recorded = await fileDigest(target); }
    catch (error) { if (error instanceof DatasetError) throw error; fail('DATASET_FILE_UNAVAILABLE', '原始数据文件不可读取，请保留版本记录并重新导入。', 404); }
    if (recorded.sha256 !== dataset.sha256 || recorded.byteLength !== dataset.byteLength) fail('DATASET_HASH_MISMATCH', '原始数据与固定版本不符，请导入新的版本。');
    const bytes = await regularFile(target, MAX_DATASET_BYTES, handle => handle.readFile());
    if (digest(bytes) !== dataset.sha256) fail('DATASET_HASH_MISMATCH', '读取期间原始数据发生变化。');
    return { dataset, bytes };
  }
  return { locations, read, update, store, content };
}
