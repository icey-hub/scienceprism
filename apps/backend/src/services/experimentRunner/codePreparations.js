import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { getProjectRoot } from '../projectService.js';
import { getHarnessRun, listHarnessRuns } from '../harnessRuntime/index.js';
import { isSensitivePath } from '../harnessRuntime/capabilities.js';
import { ExperimentRunnerError } from './errors.js';

const MAX_CODE_BYTES = 1024 * 1024, MAX_RECORD_BYTES = 2 * MAX_CODE_BYTES;
const digest = value => createHash('sha256').update(value).digest('hex');
const fail = (code, message, status = 409) => { throw new ExperimentRunnerError(status, code, message); };
const owned = stat => !process.getuid || stat.uid === process.getuid();
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
const version = bytes => ({ exists: bytes !== null, sha256: bytes === null ? null : digest(bytes) });
const validVersion = value => value && typeof value.exists === 'boolean' && (value.exists ? /^[a-f0-9]{64}$/.test(value.sha256) : value.sha256 === null)
  && Object.keys(value).every(key => ['exists', 'sha256'].includes(key));
function codePath(value) {
  if (typeof value !== 'string' || !value.isWellFormed() || !value || value.length > 2048 || /[\x00-\x1f\x7f\\:]/.test(value)
    || path.posix.normalize(value) !== value || value.startsWith('/') || value.split('/').some(part => !part || part === '..' || part.startsWith('.'))
    || isSensitivePath(value) || !/\.(?:py|mjs|js|cjs)$/.test(value)) fail('CODE_PREPARATION_PATH_INVALID', '请选择普通、非敏感的 Python 或 Node 源文件路径。', 400);
  return value;
}
function inputRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['sourceRunId', 'paths'].includes(key))
    || typeof input.sourceRunId !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(input.sourceRunId)
    || !Array.isArray(input.paths) || input.paths.length < 1 || input.paths.length > 20) fail('CODE_PREPARATION_INPUT_INVALID', '请提供来源 Agent 任务与 1–20 个源文件。', 400);
  const paths = input.paths.map(codePath).sort();
  if (new Set(paths).size !== paths.length) fail('CODE_PREPARATION_INPUT_INVALID', '源文件路径不能重复。', 400);
  return { sourceRunId: input.sourceRunId, paths };
}
async function typed(operation) {
  try { return await operation(); }
  catch (error) { if (error instanceof ExperimentRunnerError) throw error; fail('CODE_PREPARATION_UNAVAILABLE', '代码准备记录无法安全读取，请核对来源任务和存储。'); }
}
async function directory(target) {
  const stat = await fs.lstat(target);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !owned(stat) || await fs.realpath(target) !== target) fail('CODE_PREPARATION_UNSAFE_STORAGE', '代码目录必须为本进程拥有的真实目录。', 403);
  return stat;
}
async function ensureDirectory(target) {
  try { await fs.mkdir(target, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  return directory(target);
}
async function parents(root, relative, { create = false, guard = async () => {} } = {}) {
  const list = [{ target: root, stat: await directory(root) }];
  for (const component of relative.split('/').slice(0, -1)) {
    const target = path.join(list.at(-1).target, component);
    if (create) { await guard(); await checkParents(list); await ensureDirectory(target); }
    else { try { await directory(target); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
    list.push({ target, stat: await directory(target) });
  }
  return list;
}
async function checkParents(list) {
  for (const item of list) if (!sameFile(item.stat, await directory(item.target))) fail('CODE_PREPARATION_UNSAFE_STORAGE', '代码目录在操作期间发生变化。', 403);
}
async function readRegular(target, maxBytes, { readOnly = false, missing = false } = {}) {
  let handle;
  try { handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (missing && error.code === 'ENOENT') return null; throw error; }
  try {
    const initial = await handle.stat();
    if (!initial.isFile() || initial.nlink !== 1 || !owned(initial) || initial.size > maxBytes || readOnly && initial.mode & 0o222) fail('CODE_PREPARATION_UNSAFE_STORAGE', '代码文件必须是独立、有界的普通文件。', 403);
    const chunks = []; let count = 0;
    while (count <= maxBytes) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1 - count)), { bytesRead } = await handle.read(buffer, 0, buffer.length, count);
      if (!bytesRead) break; count += bytesRead;
      if (count > maxBytes) fail('CODE_PREPARATION_TOO_LARGE', '代码超出固定体积上限。', 413);
      chunks.push(buffer.subarray(0, bytesRead));
    }
    const current = await fs.lstat(target), final = await handle.stat();
    if (!sameFile(initial, current) || current.isSymbolicLink() || !owned(final) || !owned(current) || final.nlink !== 1 || current.nlink !== 1 || final.size !== count
      || readOnly && (final.mode & 0o222 || current.mode & 0o222)) fail('CODE_PREPARATION_UNSAFE_STORAGE', '代码文件在读取期间发生变化。', 403);
    return Buffer.concat(chunks, count);
  } finally { await handle.close(); }
}
async function projectVersion(root, relative) {
  const list = await parents(root, relative);
  if (!list) return version(null);
  const result = version(await readRegular(path.join(root, relative), MAX_CODE_BYTES, { missing: true }));
  await checkParents(list); return result;
}
const signed = record => ({ schemaVersion: record.schemaVersion, projectId: record.projectId, source: record.source,
  sourceAttempt: record.sourceAttempt, files: record.files });
const publicPreparation = record => ({ schemaVersion: 1, id: record.id, sha256: record.sha256, projectId: record.projectId, status: 'ready',
  source: structuredClone(record.source), files: record.files.map(({ content, ...metadata }) => structuredClone(metadata)), createdAt: record.createdAt });

/** Owns fixed Codex proposals independently of the project tree; never applies a Patch to the original project. */
export function createCodePreparationService({ resolveProject = getProjectRoot, getRun = getHarnessRun, listRuns = listHarnessRuns } = {}) {
  async function locations(projectId, create = false) {
    if (typeof projectId !== 'string' || !/^[a-zA-Z0-9_-]{1,120}$/.test(projectId)) fail('CODE_PREPARATION_PROJECT_INVALID', '项目标识无效。', 400);
    const projectRoot = await resolveProject(projectId); await directory(projectRoot);
    const parent = path.dirname(projectRoot); await directory(parent);
    const control = path.join(parent, '.scienceprism-code-preparations'), store = path.join(control, digest(projectId));
    if (create) { await ensureDirectory(control); await ensureDirectory(store); }
    else { await directory(control); await directory(store); }
    const storage = [];
    for (const target of [parent, control, store]) storage.push({ target, stat: await directory(target) });
    return { projectRoot, control, store, storage };
  }
  async function producer(projectId, sourceRunId, selectedPaths, expectedChildren) {
    const parent = await getRun(projectId, sourceRunId);
    if (parent?.id !== sourceRunId || parent.projectId !== projectId || parent.status !== 'completed' || parent.adapter !== 'deepseek'
      || parent.cleanup?.modelSlotRetained || !Number.isSafeInteger(parent.attempt) || parent.attempt < 1) fail('CODE_PREPARATION_SOURCE_INVALID', '来源必须是已停止的 DeepSeek 编排任务。');
    const completedEvents = (parent.events || []).filter(event => event.type === 'runtime/delegation' && event.phase === 'completed'
      && event.runtime === 'codex' && event.parentRunId === parent.id && event.attempt === parent.attempt).map(event => event.childRunId);
    const ledger = expectedChildren ? [] : await listRuns(projectId, { parentRunId: parent.id, limit: 100 });
    const ids = [...new Set(expectedChildren || [...completedEvents, ...ledger.map(run => run.id)])].sort();
    if (!ids.length || ids.length > 100) fail('CODE_PREPARATION_CHILD_REQUIRED', '来源任务没有真实完成的 Codex 子任务。');
    const children = [];
    for (const id of ids) {
      const child = await getRun(projectId, id);
      const valid = child?.id === id && child.projectId === projectId && child.parentRunId === parent.id && child.parentAttempt === parent.attempt
        && child.status === 'completed' && child.adapter === 'codex' && child.kind === 'codex-worker' && child.recovery?.phase === 'handed-off'
        && child.workerStorage?.stopConfirmed === true && !child.cleanup?.modelSlotRetained && child.workerResult?.ok === true;
      if (valid) children.push(child);
      else if (expectedChildren) fail('CODE_PREPARATION_CHILD_CHANGED', '固定 Codex 子任务的身份或停止回执已变化。');
    }
    const files = [], used = new Set(); let total = 0;
    for (const relative of selectedPaths) {
      const patches = (parent.patches || []).filter(patch => patch.path === relative);
      const patch = patches[0];
      if (patches.length !== 1 || patch.deleted || typeof patch.content !== 'string' || !patch.content.isWellFormed() || !validVersion(patch.baseVersion)) fail('CODE_PREPARATION_PATCH_INVALID', '来源任务中缺少唯一、完整的非删除源文件提案。');
      const child = children.find(run => {
        const matches = (run.patches || []).filter(item => item.path === relative);
        return matches.length === 1 && !matches[0].deleted && matches[0].content === patch.content && isDeepStrictEqual(matches[0].baseVersion, patch.baseVersion);
      });
      if (!child) fail('CODE_PREPARATION_HANDOFF_MISMATCH', 'DeepSeek 最终代码与 Codex 子任务的固定提案不一致。');
      const bytes = Buffer.byteLength(patch.content); total += bytes;
      if (total > MAX_CODE_BYTES) fail('CODE_PREPARATION_TOO_LARGE', '所选源代码总量不能超过 1MiB。', 413);
      files.push({ path: relative, sha256: digest(patch.content), bytes, baseVersion: structuredClone(patch.baseVersion), content: patch.content }); used.add(child.id);
    }
    const childRunIds = [...used].sort();
    if (expectedChildren && !isDeepStrictEqual(childRunIds, expectedChildren)) fail('CODE_PREPARATION_CHILD_CHANGED', '固定代码的子任务来源发生变化。');
    return { source: { runId: parent.id, childRunIds }, sourceAttempt: parent.attempt, files };
  }
  async function readRecord(projectId, id) {
    if (typeof id !== 'string' || !/^code-preparation-[a-f0-9]{64}$/.test(id)) fail('CODE_PREPARATION_ID_INVALID', '代码准备标识无效。', 400);
    const root = await locations(projectId), bytes = await readRegular(path.join(root.store, `${id}.json`), MAX_RECORD_BYTES, { readOnly: true });
    await checkParents(root.storage);
    let record; try { record = JSON.parse(bytes.toString('utf8')); } catch { fail('CODE_PREPARATION_CORRUPT', '代码准备记录损坏。'); }
    if (record?.schemaVersion !== 1 || record.id !== id || record.projectId !== projectId || record.sha256 !== id.slice(17)
      || digest(JSON.stringify(signed(record))) !== record.sha256 || !Array.isArray(record.files) || record.files.length < 1 || record.files.length > 20
      || typeof record.createdAt !== 'string' || !Number.isFinite(Date.parse(record.createdAt))) fail('CODE_PREPARATION_CORRUPT', '代码准备签名或记录不完整。');
    inputRequest({ sourceRunId: record.source?.runId, paths: record.files.map(file => file.path) });
    let total = 0;
    for (const file of record.files) {
      if (typeof file.content !== 'string' || !file.content.isWellFormed() || file.sha256 !== digest(file.content) || file.bytes !== Buffer.byteLength(file.content)
        || !validVersion(file.baseVersion)) fail('CODE_PREPARATION_CORRUPT', '代码准备文件内容与摘要不符。');
      total += file.bytes;
    }
    if (total > MAX_CODE_BYTES) fail('CODE_PREPARATION_CORRUPT', '代码准备内容超出上限。');
    return { record, root };
  }
  async function verifyRecord(projectId, id, expectedSha) {
    const { record, root } = await readRecord(projectId, id);
    if (typeof expectedSha !== 'string' || expectedSha !== record.sha256) fail('CODE_PREPARATION_VERSION_CHANGED', '实验代码准备版本与固定摘要不符。');
    const actual = await producer(projectId, record.source.runId, record.files.map(file => file.path), record.source.childRunIds);
    if (!isDeepStrictEqual(actual, { source: record.source, sourceAttempt: record.sourceAttempt, files: record.files })) fail('CODE_PREPARATION_SOURCE_CHANGED', '固定来源 Agent 的代码提案已经变化。');
    for (const file of record.files) if (!isDeepStrictEqual(await projectVersion(root.projectRoot, file.path), file.baseVersion)) fail('CODE_PREPARATION_BASE_CHANGED', '项目源码与 Codex 提案的原始版本不符。');
    return { record, root };
  }
  async function assertWorkspaceFiles(record, workspace) {
    if (typeof workspace !== 'string' || !path.isAbsolute(workspace) || path.normalize(workspace) !== workspace) fail('CODE_PREPARATION_UNSAFE_STORAGE', '实验工作区路径无效。', 403);
    const files = [];
    for (const file of record.files) {
      const list = await parents(workspace, file.path); if (!list) fail('CODE_PREPARATION_OVERLAY_CHANGED', '实验代码输入已消失。');
      if (digest(await readRegular(path.join(workspace, file.path), MAX_CODE_BYTES, { readOnly: true })) !== file.sha256) fail('CODE_PREPARATION_OVERLAY_CHANGED', '实验代码输入发生变化。');
      await checkParents(list);
      files.push({ ...publicPreparation(record).files.find(item => item.path === file.path), verified: true });
    }
    return { preparation: publicPreparation(record), files };
  }
  return {
    async create(projectId, input) { return typed(async () => {
      const request = inputRequest(input), root = await locations(projectId, true), proposal = await producer(projectId, request.sourceRunId, request.paths);
      for (const file of proposal.files) if (!isDeepStrictEqual(await projectVersion(root.projectRoot, file.path), file.baseVersion)) fail('CODE_PREPARATION_BASE_CHANGED', '项目源码已变化，不能固定这个旧代码提案。');
      const content = { schemaVersion: 1, projectId, ...proposal }, sha256 = digest(JSON.stringify(content));
      const record = { ...content, id: `code-preparation-${sha256}`, sha256, createdAt: new Date().toISOString() }, encoded = JSON.stringify(record);
      if (Buffer.byteLength(encoded) > MAX_RECORD_BYTES) fail('CODE_PREPARATION_TOO_LARGE', '代码准备记录超出固定体积上限。', 413);
      const target = path.join(root.store, `${record.id}.json`), temporary = path.join(root.store, `.prepare-${randomUUID()}.tmp`);
      let cached = false;
      try {
        await checkParents(root.storage);
        await fs.writeFile(temporary, encoded, { flag: 'wx', mode: 0o400 }); await checkParents(root.storage);
        try { await fs.link(temporary, target); } catch (error) { if (error.code !== 'EEXIST') throw error; cached = true; }
      } finally { await fs.unlink(temporary).catch(() => {}); }
      const stored = await verifyRecord(projectId, record.id, sha256);
      return { preparation: publicPreparation(stored.record), cached };
    }); },
    async list(projectId) { return typed(async () => {
      let root; try { root = await locations(projectId); } catch (error) { if (error.code === 'ENOENT') return { preparations: [] }; throw error; }
      const names = (await fs.readdir(root.store)).filter(name => /^code-preparation-[a-f0-9]{64}\.json$/.test(name));
      if (names.length > 2000) fail('CODE_PREPARATION_STORAGE_LIMIT', '代码准备记录数量达到上限。');
      const preparations = [];
      for (const name of names.sort()) preparations.push(publicPreparation((await readRecord(projectId, name.slice(0, -5))).record));
      return { preparations };
    }); },
    async get(projectId, id) { return typed(async () => {
      const { record } = await readRecord(projectId, id);
      return publicPreparation((await verifyRecord(projectId, id, record.sha256)).record);
    }); },
    async verify(projectId, id, expectedSha) { return typed(async () => {
      const { record } = await verifyRecord(projectId, id, expectedSha);
      return { preparation: publicPreparation(record), files: structuredClone(record.files) };
    }); },
    async assertWorkspace(projectId, id, expectedSha, workspace) { return typed(async () => {
      const { record } = await verifyRecord(projectId, id, expectedSha);
      return assertWorkspaceFiles(record, workspace);
    }); },
    async prepareWorkspace(projectId, id, expectedSha, workspace, { signal, beforeEffect } = {}) { return typed(async () => {
      const guard = async () => {
        if (signal?.aborted) fail('CODE_PREPARATION_CANCELLED', '实验代码准备已停止。');
        try { await beforeEffect?.(); } catch { fail('CODE_PREPARATION_AUTHORIZATION_REVOKED', '实验代码准备授权已变化。', 403); }
        if (signal?.aborted) fail('CODE_PREPARATION_CANCELLED', '实验代码准备已停止。');
      };
      await guard(); const { record } = await verifyRecord(projectId, id, expectedSha);
      if (typeof workspace !== 'string' || !path.isAbsolute(workspace) || path.normalize(workspace) !== workspace) fail('CODE_PREPARATION_UNSAFE_STORAGE', '实验工作区路径无效。', 403);
      for (const file of record.files) {
        await guard(); const list = await parents(workspace, file.path, { create: true, guard });
        const target = path.join(workspace, file.path), temporary = path.join(path.dirname(target), `.code-${randomUUID()}.tmp`);
        const assertBase = async () => {
          await checkParents(list);
          if (!isDeepStrictEqual(version(await readRegular(target, MAX_CODE_BYTES, { missing: true })), file.baseVersion)) fail('CODE_PREPARATION_OVERLAY_CONFLICT', '实验工作区代码与提案原始版本不符，不能覆盖。');
        };
        await assertBase(); await guard(); await assertBase();
        try {
          await fs.writeFile(temporary, file.content, { flag: 'wx', mode: 0o400 });
          await guard(); await assertBase();
          if (file.baseVersion.exists) await fs.rename(temporary, target);
          else { try { await fs.link(temporary, target); } catch (error) { if (error.code === 'EEXIST') fail('CODE_PREPARATION_OVERLAY_CONFLICT', '实验代码目标已存在，不能覆盖。'); throw error; } await fs.unlink(temporary); }
          await guard(); await checkParents(list);
          if (digest(await readRegular(target, MAX_CODE_BYTES, { readOnly: true })) !== file.sha256) fail('CODE_PREPARATION_OVERLAY_CHANGED', '准备后的实验代码与固定摘要不符。');
        } finally { await fs.unlink(temporary).catch(() => {}); }
      }
      await guard();
      await verifyRecord(projectId, id, expectedSha);
      const result = await assertWorkspaceFiles(record, workspace);
      if (signal?.aborted) fail('CODE_PREPARATION_CANCELLED', '实验代码准备已停止。');
      return result;
    }); }
  };
}
export const codePreparationService = createCodePreparationService();
