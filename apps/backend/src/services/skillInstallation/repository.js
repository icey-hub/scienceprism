import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createTwoFilesPatch } from 'diff';
import { getProjectRoot } from '../projectService.js';
import { withHubLock } from '../projectHub/repository.js';
import { safeJoin } from '../../utils/pathUtils.js';
import { normalizeRepository, isSafeRepositoryPath } from '../skillDiscovery/github.js';

export const SOURCE_LOCK = '.scienceprism-source.json';
export const LICENSE_DIRECTORY = '.scienceprism-licenses';
export const MAX_SKILL_FILES = 64;
export const MAX_SKILL_FILE_BYTES = 512_000;
export const MAX_SKILL_BYTES = 4 * 1024 * 1024;
const SKILLS_DIRECTORY = '.agents/skills';
const STAGING_DIRECTORY = '.scienceprism/skill-installations-staging';
const HISTORY_DIRECTORY = '.scienceprism/skill-installation-history';
const TRANSACTION_DIRECTORY = '.scienceprism/skill-installation-transactions';
const MAX_INSTALLED = 64;
const LOCK_BYTES = 256_000;
const NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const HASH = /^[a-f0-9]{64}$/;
export class SkillInstallationError extends Error {
  constructor(code, message, statusCode = 400) { super(message); this.name = 'SkillInstallationError'; this.code = code; this.statusCode = statusCode; }
}
export const installationError = (code, message, status = 400) => new SkillInstallationError(`SKILL_INSTALLATION_${code}`, message, status);
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const validInstallPath = value => isSafeRepositoryPath(value) && value.length <= 1024 && value.split('/').length <= 16 && !/[:<>"|?*]/.test(value);
export function assertNotCancelled(signal) {
  if (signal?.aborted) throw installationError('CANCELLED', 'Skill 安装已取消。', 499);
}
const lockDigest = files => sha256(JSON.stringify(files.map(file => [file.path, file.originalPath, file.size, file.digest]).sort((a, b) => a[0].localeCompare(b[0]))));
export const skillVersionId = lock => sha256(JSON.stringify([lock.source.repository, lock.source.commit, lock.source.path, lock.source.digest, lock.bundleDigest]));

export function validateSourceLock(lock, name) {
  if (!lock || lock.schemaVersion !== 1 || lock.name !== name || typeof name !== 'string' || !NAME.test(name) || name.length > 64 || !Number.isFinite(Date.parse(lock.installedAt))
    || !Array.isArray(lock.files) || !lock.files.length || lock.files.length > MAX_SKILL_FILES || !HASH.test(lock.source?.digest) || !/^[a-f0-9]{40}$/.test(lock.source?.commit)) throw installationError('INVALID_LOCK', 'Skill 来源锁无效。', 409);
  let normalized;
  try { normalized = normalizeRepository({ repository: lock.source.repository, ref: lock.source.commit, path: lock.source.path }); }
  catch { throw installationError('INVALID_LOCK', 'Skill 来源锁无效。', 409); }
  if (normalized.repository !== lock.source.repository || normalized.path !== lock.source.path) throw installationError('INVALID_LOCK', 'Skill 来源锁无效。', 409);
  const names = new Set(); let total = 0;
  for (const file of lock.files) {
    if (!validInstallPath(file.path) || file.path === SOURCE_LOCK || !isSafeRepositoryPath(file.originalPath) || names.has(file.path)
      || !HASH.test(file.digest) || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_SKILL_FILE_BYTES) throw installationError('INVALID_LOCK', 'Skill 来源锁无效。', 409);
    names.add(file.path); total += file.size;
  }
  if (total > MAX_SKILL_BYTES || total !== lock.totalBytes || lock.bundleDigest !== lockDigest(lock.files)
    || lock.files.find(file => file.path === 'SKILL.md')?.digest !== lock.source.digest) throw installationError('INVALID_LOCK', 'Skill 来源锁摘要无效。', 409);
  return lock;
}
export function createSourceLock({ name, source, files }) {
  const lock = { schemaVersion: 1, name, source, installedAt: new Date().toISOString(), files,
    totalBytes: files.reduce((total, file) => total + file.size, 0), bundleDigest: lockDigest(files),
    installationOnly: true, scriptsExecuted: false, runtimeVerified: false };
  return validateSourceLock(lock, name);
}

export function createSkillInstallationRepository({ resolveProject = getProjectRoot, fsOps = fs } = {}) {
  const checked = (root, relative) => {
    try { return safeJoin(root, relative); } catch { throw installationError('UNSAFE_PATH', '项目 Skill 路径包含链接或越界。', 409); }
  };
  async function boundedFile(root, relative, maxBytes) {
    let handle;
    try {
      handle = await fsOps.open(checked(root, relative), constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK || 0));
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > maxBytes) throw installationError('INVALID_FILE', 'Skill 文件类型或大小无效。', 409);
      const bytes = Buffer.alloc(maxBytes + 1); let count = 0;
      while (count <= maxBytes) {
        const { bytesRead } = await handle.read(bytes, count, bytes.length - count, null);
        if (!bytesRead) break; count += bytesRead;
      }
      if (count > maxBytes) throw installationError('INVALID_FILE', 'Skill 文件超过读取限制。', 409);
      return bytes.subarray(0, count);
    } finally { await handle?.close(); }
  }
  async function directoryEntries(root, relative) {
    try { return await fsOps.readdir(checked(root, relative), { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  async function inspect(root, name, relativePath = `${SKILLS_DIRECTORY}/${name}`) {
    const row = { name, relativePath, state: 'unmanaged', integrity: 'unknown', source: null, issues: [], runtimeVerified: false };
    let lock;
    try { lock = validateSourceLock(JSON.parse((await boundedFile(root, `${relativePath}/${SOURCE_LOCK}`, LOCK_BYTES)).toString('utf8')), name); }
    catch (error) {
      row.state = error.code === 'ENOENT' ? 'unmanaged' : 'invalid-lock';
      row.issues.push(error.code === 'ENOENT' ? 'missing-source-lock' : 'invalid-source-lock'); return row;
    }
    row.source = lock.source; row.installedAt = lock.installedAt; row.bundleDigest = lock.bundleDigest; row.versionId = skillVersionId(lock);
    row.totalBytes = lock.totalBytes; row.fileCount = lock.files.length; row.preservedLicenses = lock.files.filter(file => file.path.startsWith(`${LICENSE_DIRECTORY}/`));
    const actual = new Set(); let entriesSeen = 0;
    async function walk(directory, depth) {
      if (depth > 16) throw installationError('LOCAL_CHANGES', 'Skill 目录深度超过检查范围。', 409);
      for (const entry of await directoryEntries(root, `${relativePath}${directory ? `/${directory}` : ''}`)) {
        if (++entriesSeen > 2048) throw installationError('LOCAL_CHANGES', 'Skill 目录超过检查范围。', 409);
        const file = directory ? `${directory}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) throw installationError('LOCAL_CHANGES', 'Skill 目录包含链接或非普通文件。', 409);
        if (entry.isDirectory()) await walk(file, depth + 1);
        else if (file !== SOURCE_LOCK) actual.add(file);
      }
    }
    try {
      await walk('', 0);
      for (const file of lock.files) {
        if (!actual.delete(file.path)) { row.issues.push(`missing:${file.path}`); continue; }
        const bytes = await boundedFile(root, `${relativePath}/${file.path}`, MAX_SKILL_FILE_BYTES);
        if (bytes.length !== file.size || sha256(bytes) !== file.digest) row.issues.push(`modified:${file.path}`);
      }
      if (actual.size) row.issues.push(...[...actual].slice(0, 64).map(file => `extra:${file}`));
    } catch { row.issues.push('unsafe-or-unreadable-local-files'); }
    row.state = row.issues.length ? 'modified' : 'installed'; row.integrity = row.issues.length ? 'changed' : 'verified';
    return row;
  }
  async function listAt(root) {
    const entries = await directoryEntries(root, SKILLS_DIRECTORY);
    if (entries.length > MAX_INSTALLED) throw installationError('LIMIT', '项目 Skill 目录超过 64 项检查上限。', 422);
    const items = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (entry.isSymbolicLink() || !NAME.test(entry.name) || entry.name.length > 64) items.push({ name: entry.name, state: 'unsafe', integrity: 'unknown', source: null, issues: ['unsafe-directory'], runtimeVerified: false });
      else items.push(await inspect(root, entry.name));
    }
    return items;
  }
  async function list(projectId) {
    return withHubLock(projectId, async () => {
      const root = await resolveProject(projectId); const recovered = await recoverPending(root);
      return { installations: await listAt(root), recovered, runtimeVerified: false };
    });
  }
  async function install(projectId, bundle, { signal } = {}) {
    const lock = validateSourceLock(bundle.lock, bundle.lock?.name);
    if (!Array.isArray(bundle.files) || bundle.files.length !== lock.files.length) throw installationError('INVALID_BUNDLE', 'Skill 文件集合不完整。');
    for (const entry of lock.files) {
      const file = bundle.files.find(item => item.path === entry.path);
      if (!file || !Buffer.isBuffer(file.bytes) || file.bytes.length !== entry.size || sha256(file.bytes) !== entry.digest) throw installationError('INVALID_BUNDLE', 'Skill 文件摘要不一致。');
    }
    return withHubLock(projectId, async () => {
      assertNotCancelled(signal);
      const root = await resolveProject(projectId); await recoverPending(root); const target = `${SKILLS_DIRECTORY}/${lock.name}`;
      const entries = await directoryEntries(root, SKILLS_DIRECTORY);
      if (entries.some(entry => entry.name === lock.name)) {
        const existing = await inspect(root, lock.name);
        if (existing.state === 'installed' && existing.bundleDigest === lock.bundleDigest && JSON.stringify(existing.source) === JSON.stringify(lock.source)) return { installation: existing, duplicate: true };
        throw installationError('NAME_CONFLICT', '同名 Skill 已存在或有本地修改；未覆盖。', 409);
      }
      if (entries.length >= MAX_INSTALLED) throw installationError('LIMIT', '项目最多安装 64 项 Skill。', 422);
      await fsOps.mkdir(checked(root, STAGING_DIRECTORY), { recursive: true });
      await fsOps.mkdir(checked(root, SKILLS_DIRECTORY), { recursive: true });
      // Preserve the selected source from the first install so an older Run
      // can still read its exact document after later local edits/uninstall.
      await archive(root, bundle, signal);
      const temporary = `${STAGING_DIRECTORY}/${randomUUID()}`;
      await fsOps.mkdir(checked(root, temporary), { mode: 0o700 });
      try {
        for (const file of bundle.files) {
          assertNotCancelled(signal);
          const destination = `${temporary}/${file.path}`;
          await fsOps.mkdir(checked(root, path.posix.dirname(destination)), { recursive: true });
          await fsOps.writeFile(checked(root, destination), file.bytes, { flag: 'wx', mode: 0o600 });
        }
        await fsOps.writeFile(checked(root, `${temporary}/${SOURCE_LOCK}`), `${JSON.stringify(lock, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
        assertNotCancelled(signal);
        // All writers in this backend use the project lock. Recheck immediately
        // before the sole publication rename; the source receipt moves with it.
        try { await fsOps.lstat(checked(root, target)); throw installationError('NAME_CONFLICT', '同名 Skill 已存在；未覆盖。', 409); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        await fsOps.rename(checked(root, temporary), checked(root, target));
        return { installation: await inspect(root, lock.name), duplicate: false };
      } finally { await fsOps.rm(checked(root, temporary), { recursive: true, force: true }); }
    });
  }
  function validName(name) {
    if (typeof name !== 'string' || !NAME.test(name) || name.length > 64) throw installationError('INVALID_NAME', 'Skill 名称无效。');
  }
  function validVersion(value) {
    if (typeof value !== 'string' || !HASH.test(value)) throw installationError('INVALID_VERSION', '必须指定完整 Skill 版本 ID。');
  }
  const historyPath = (name, version) => `${HISTORY_DIRECTORY}/${name}/${version}`;
  async function exists(root, relative) {
    try { await fsOps.lstat(checked(root, relative)); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }
  async function readBundle(root, name, relative = `${SKILLS_DIRECTORY}/${name}`) {
    const row = await inspect(root, name, relative);
    if (row.state !== 'installed') throw installationError('LOCAL_CHANGES', 'Skill 文件或来源锁存在本地修改，操作已停止。', 409);
    const lock = validateSourceLock(JSON.parse((await boundedFile(root, `${relative}/${SOURCE_LOCK}`, LOCK_BYTES)).toString('utf8')), name);
    const files = [];
    for (const entry of lock.files) {
      const bytes = await boundedFile(root, `${relative}/${entry.path}`, MAX_SKILL_FILE_BYTES);
      if (bytes.length !== entry.size || sha256(bytes) !== entry.digest) throw installationError('LOCAL_CHANGES', '读取期间 Skill 文件发生变化。', 409);
      files.push({ path: entry.path, bytes });
    }
    return { lock, files, row };
  }
  async function expectedCurrent(root, name, expectedVersionId) {
    validName(name); validVersion(expectedVersionId);
    if (!await exists(root, `${SKILLS_DIRECTORY}/${name}`)) throw installationError('NOT_INSTALLED', 'Skill 当前未安装。', 404);
    const current = await readBundle(root, name);
    if (skillVersionId(current.lock) !== expectedVersionId) throw installationError('VERSION_CONFLICT', 'Skill 版本已变化，请重新预览。', 409);
    return current;
  }
  function checkedBundle(bundle, name) {
    const lock = validateSourceLock(bundle?.lock, name);
    if (!Array.isArray(bundle.files) || bundle.files.length !== lock.files.length) throw installationError('INVALID_BUNDLE', 'Skill 文件集合不完整。');
    for (const entry of lock.files) {
      const file = bundle.files.find(item => item.path === entry.path);
      if (!file || !Buffer.isBuffer(file.bytes) || file.bytes.length !== entry.size || sha256(file.bytes) !== entry.digest) throw installationError('INVALID_BUNDLE', 'Skill 文件摘要不一致。');
    }
    return bundle;
  }
  async function writeBundle(root, relative, bundle, signal) {
    checkedBundle(bundle, bundle.lock.name);
    await fsOps.mkdir(checked(root, relative), { recursive: true, mode: 0o700 });
    for (const file of bundle.files) {
      assertNotCancelled(signal);
      const destination = `${relative}/${file.path}`;
      await fsOps.mkdir(checked(root, path.posix.dirname(destination)), { recursive: true });
      await fsOps.writeFile(checked(root, destination), file.bytes, { flag: 'wx', mode: 0o600 });
    }
    await fsOps.writeFile(checked(root, `${relative}/${SOURCE_LOCK}`), `${JSON.stringify(bundle.lock, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  }
  async function archive(root, bundle, signal) {
    const name = bundle.lock.name; const version = skillVersionId(bundle.lock); const destination = historyPath(name, version);
    if (await exists(root, destination)) {
      const saved = await readBundle(root, name, destination);
      if (skillVersionId(saved.lock) !== version) throw installationError('HISTORY_CONFLICT', '历史版本来源不一致。', 409);
      return;
    }
    const versions = await directoryEntries(root, `${HISTORY_DIRECTORY}/${name}`);
    if (versions.length >= 32) throw installationError('HISTORY_LIMIT', '此 Skill 已保存 32 个历史版本；未自动清理历史。', 422);
    const temporary = `${STAGING_DIRECTORY}/${randomUUID()}`;
    try {
      await writeBundle(root, temporary, bundle, signal);
      await fsOps.mkdir(checked(root, `${HISTORY_DIRECTORY}/${name}`), { recursive: true });
      await fsOps.rename(checked(root, temporary), checked(root, destination));
    } finally { await fsOps.rm(checked(root, temporary), { recursive: true, force: true }); }
  }
  async function recoverTransaction(root, transaction) {
    const { name, stagingId, fromVersionId, toVersionId, operation } = transaction || {};
    validName(name); validVersion(fromVersionId);
    if (transaction.schemaVersion !== 1 || !/^[a-f0-9-]{36}$/.test(stagingId) || !['update', 'rollback', 'uninstall'].includes(operation)
      || (operation === 'uninstall' ? toVersionId !== null : !HASH.test(toVersionId))) throw installationError('RECOVERY_CONFLICT', 'Skill 恢复记录无效，未更改文件。', 409);
    const target = `${SKILLS_DIRECTORY}/${name}`; const staging = `${STAGING_DIRECTORY}/${stagingId}`;
    const previous = `${staging}/previous`; const journal = `${TRANSACTION_DIRECTORY}/${name}.json`;
    const saved = await readBundle(root, name, historyPath(name, fromVersionId));
    if (skillVersionId(saved.lock) !== fromVersionId) throw installationError('RECOVERY_CONFLICT', '历史备份无法核验，未继续恢复。', 409);
    let outcome;
    if (await exists(root, target)) {
      const current = await readBundle(root, name);
      const version = skillVersionId(current.lock);
      if (version === toVersionId) outcome = 'completed';
      else if (version === fromVersionId && !await exists(root, previous)) outcome = 'restored';
      else throw installationError('RECOVERY_CONFLICT', 'Skill 当前目录已发生变化，保留恢复材料供检查。', 409);
    } else if (await exists(root, previous)) {
      const prior = await readBundle(root, name, previous);
      if (skillVersionId(prior.lock) !== fromVersionId) throw installationError('RECOVERY_CONFLICT', 'Skill 恢复版本不一致。', 409);
      await fsOps.rename(checked(root, previous), checked(root, target)); outcome = 'restored';
    } else throw installationError('RECOVERY_CONFLICT', 'Skill 当前目录和暂存备份均缺失，保留历史版本。', 409);
    await fsOps.rm(checked(root, staging), { recursive: true, force: true });
    await fsOps.rm(checked(root, journal), { force: true });
    return { name, operation, outcome };
  }
  async function recoverPending(root) {
    const entries = await directoryEntries(root, TRANSACTION_DIRECTORY);
    if (entries.length > MAX_INSTALLED) throw installationError('RECOVERY_CONFLICT', '恢复记录超过上限。', 409);
    const recovered = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) throw installationError('RECOVERY_CONFLICT', '恢复目录包含未知文件。', 409);
      let transaction;
      try { transaction = JSON.parse((await boundedFile(root, `${TRANSACTION_DIRECTORY}/${entry.name}`, 8192)).toString('utf8')); }
      catch { throw installationError('RECOVERY_CONFLICT', '无法读取恢复记录。', 409); }
      if (entry.name !== `${transaction.name}.json`) throw installationError('RECOVERY_CONFLICT', '恢复记录与名称不一致。', 409);
      recovered.push(await recoverTransaction(root, transaction));
    }
    return recovered;
  }
  async function transition(root, current, next, operation, signal) {
    const name = current.lock.name; const fromVersionId = skillVersionId(current.lock);
    const toVersionId = next ? skillVersionId(next.lock) : null;
    if (fromVersionId === toVersionId) return { installation: current.row, duplicate: true };
    assertNotCancelled(signal); await archive(root, current, signal);
    if (next) await archive(root, next, signal);
    const stagingId = randomUUID(); const staging = `${STAGING_DIRECTORY}/${stagingId}`;
    const target = `${SKILLS_DIRECTORY}/${name}`; const journal = `${TRANSACTION_DIRECTORY}/${name}.json`;
    let recorded = false;
    try {
      await fsOps.mkdir(checked(root, staging), { recursive: true, mode: 0o700 });
      if (next) await writeBundle(root, `${staging}/payload`, checkedBundle(next, name), signal);
      assertNotCancelled(signal);
      await fsOps.mkdir(checked(root, TRANSACTION_DIRECTORY), { recursive: true });
      const temporaryJournal = `${staging}/transaction.json`;
      await fsOps.writeFile(checked(root, temporaryJournal), `${JSON.stringify({ schemaVersion: 1, name, stagingId, fromVersionId, toVersionId, operation })}\n`, { flag: 'wx', mode: 0o600 });
      await fsOps.rename(checked(root, temporaryJournal), checked(root, journal)); recorded = true;
      await fsOps.rename(checked(root, target), checked(root, `${staging}/previous`));
      if (next) await fsOps.rename(checked(root, `${staging}/payload`), checked(root, target));
      // Removing the intent commits an uninstall; interrupted updates can be
      // recognized from the complete current version before cleanup.
      await fsOps.rm(checked(root, journal)); recorded = false;
      await fsOps.rm(checked(root, staging), { recursive: true, force: true });
      return { installation: next ? await inspect(root, name) : null, duplicate: false, uninstalled: !next, preservedVersionId: fromVersionId };
    } catch (error) {
      if (recorded) {
        try { await recoverPending(root); }
        catch { throw installationError('RECOVERY_REQUIRED', '版本切换已中断，恢复材料已保留；重新读取列表可继续恢复。', 503); }
      }
      throw error;
    } finally { if (!recorded) await fsOps.rm(checked(root, staging), { recursive: true, force: true }); }
  }
  function inProject(projectId, callback) {
    return withHubLock(projectId, async () => {
      const root = await resolveProject(projectId); await recoverPending(root); return callback(root);
    });
  }
  async function preview(projectId, name, bundle, { expectedVersionId } = {}) {
    return inProject(projectId, async root => {
      const current = await expectedCurrent(root, name, expectedVersionId); checkedBundle(bundle, name);
      const before = new Map(current.files.map(file => [file.path, file])); const after = new Map(bundle.files.map(file => [file.path, file]));
      const changes = []; let diffBudget = 64_000;
      for (const file of [...new Set([...before.keys(), ...after.keys()])].sort()) {
        const oldFile = before.get(file); const newFile = after.get(file);
        const oldHash = oldFile ? sha256(oldFile.bytes) : null; const newHash = newFile ? sha256(newFile.bytes) : null;
        if (oldHash === newHash) continue;
        const oldText = oldFile?.bytes.toString('utf8') || ''; const newText = newFile?.bytes.toString('utf8') || '';
        const fullDiff = diffBudget > 0 ? createTwoFilesPatch(file, file, oldText.slice(0, 20_000), newText.slice(0, 20_000), 'current', 'selected', { context: 3 }) : '';
        const diff = fullDiff.slice(0, Math.min(16_000, diffBudget)); diffBudget -= diff.length;
        changes.push({ path: file, change: !oldFile ? 'added' : !newFile ? 'removed' : 'changed', beforeDigest: oldHash, afterDigest: newHash, diff,
          diffTruncated: oldText.length > 20_000 || newText.length > 20_000 || fullDiff.length > diff.length || !diff });
      }
      return { name, current: current.row, selected: { source: bundle.lock.source, versionId: skillVersionId(bundle.lock), bundleDigest: bundle.lock.bundleDigest }, changes,
        unchanged: fromSameVersion(current.lock, bundle.lock), requiresConfirmation: true, installationPerformed: false };
    });
  }
  const fromSameVersion = (a, b) => skillVersionId(a) === skillVersionId(b);
  const update = (projectId, name, bundle, { expectedVersionId, signal } = {}) => inProject(projectId, async root => transition(root,
    await expectedCurrent(root, name, expectedVersionId), checkedBundle(bundle, name), 'update', signal));
  const rollback = (projectId, name, { versionId, expectedVersionId, signal } = {}) => inProject(projectId, async root => {
    validVersion(versionId); const current = await expectedCurrent(root, name, expectedVersionId);
    if (skillVersionId(current.lock) === versionId) return { installation: current.row, duplicate: true };
    const previous = await readBundle(root, name, historyPath(name, versionId));
    if (skillVersionId(previous.lock) !== versionId) throw installationError('HISTORY_CONFLICT', '历史版本来源不一致。', 409);
    return transition(root, current, previous, 'rollback', signal);
  });
  const uninstall = (projectId, name, { expectedVersionId, signal } = {}) => inProject(projectId, async root => transition(root,
    await expectedCurrent(root, name, expectedVersionId), null, 'uninstall', signal));
  const versions = (projectId, name) => inProject(projectId, async root => {
    validName(name); const rows = [];
    if (await exists(root, `${SKILLS_DIRECTORY}/${name}`)) rows.push({ ...await inspect(root, name), current: true });
    const entries = await directoryEntries(root, `${HISTORY_DIRECTORY}/${name}`);
    if (entries.length > 32) throw installationError('HISTORY_LIMIT', '历史版本超过检查上限。', 422);
    for (const entry of entries) {
      if (!entry.isDirectory() || !HASH.test(entry.name)) throw installationError('HISTORY_CONFLICT', '历史目录含未知版本。', 409);
      const row = await inspect(root, name, historyPath(name, entry.name));
      if (row.versionId !== entry.name) throw installationError('HISTORY_CONFLICT', '历史版本来源不一致。', 409);
      if (!rows.some(item => item.versionId === row.versionId)) rows.push({ ...row, state: row.state === 'installed' ? 'archived' : row.state, current: false, recordKind: 'saved-source' });
    }
    return { name, versions: rows, scriptsExecuted: false };
  });
  const document = (projectId, name, versionId, file = 'SKILL.md') => inProject(projectId, async root => {
    validName(name); validVersion(versionId);
    if (!validInstallPath(file) || !file.endsWith('.md') || file.startsWith('scripts/')) throw installationError('INVALID_DOCUMENT', '历史回源仅支持 Skill 内 Markdown 文档。');
    let relative = historyPath(name, versionId);
    if (!await exists(root, relative)) {
      const current = await inspect(root, name);
      if (current.versionId === versionId) relative = `${SKILLS_DIRECTORY}/${name}`;
    }
    const lock = validateSourceLock(JSON.parse((await boundedFile(root, `${relative}/${SOURCE_LOCK}`, LOCK_BYTES)).toString('utf8')), name);
    if (skillVersionId(lock) !== versionId) throw installationError('HISTORY_CONFLICT', '历史版本来源不一致。', 409);
    const entry = lock.files.find(item => item.path === file);
    if (!entry) throw installationError('DOCUMENT_NOT_FOUND', '版本中没有此文档。', 404);
    const bytes = await boundedFile(root, `${relative}/${file}`, MAX_SKILL_FILE_BYTES);
    if (bytes.length !== entry.size || sha256(bytes) !== entry.digest) throw installationError('LOCAL_CHANGES', '历史文档摘要不一致。', 409);
    return { name, versionId, source: lock.source, file, sha256: entry.digest, content: bytes.toString('utf8'), bytes: bytes.length };
  });
  // Internal only: the caller holds withHubLock for the entire projection.
  // Metadata is checked here, never copied into model-visible instructions.
  async function projectionVersion(projectId, name, documents) {
    validName(name); const root = await resolveProject(projectId); let bytes;
    try { bytes = await boundedFile(root, `${SKILLS_DIRECTORY}/${name}/${SOURCE_LOCK}`, LOCK_BYTES); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    let lock;
    try { lock = validateSourceLock(JSON.parse(bytes.toString('utf8')), name); }
    catch { throw installationError('INVALID_LOCK', 'Skill 来源锁无效，无法记录运行版本。', 409); }
    for (const document of documents) {
      const relative = document.sourceRelativePath.slice(`${SKILLS_DIRECTORY}/${name}/`.length);
      const entry = lock.files.find(file => file.path === relative);
      if (!document.sourceRelativePath.startsWith(`${SKILLS_DIRECTORY}/${name}/`) || !entry || entry.digest !== document.sha256 || entry.size !== document.bytes) {
        throw installationError('LOCAL_CHANGES', 'Skill 文档已改变，无法归属已锁定版本。', 409);
      }
    }
    const version = skillVersionId(lock);
    // Backfill the source snapshot for installations created before lifecycle
    // support, under the caller's project lock and before recording a Run ref.
    if (!await exists(root, historyPath(name, version))) await archive(root, await readBundle(root, name));
    return version;
  }
  const recoverForProjection = async projectId => recoverPending(await resolveProject(projectId));
  return { list, install, preview, update, rollback, uninstall, versions, document, projectionVersion, recoverForProjection };
}

const sourceVersions = createSkillInstallationRepository();
export const readInstalledSkillProjectionVersion = (projectId, name, documents) => sourceVersions.projectionVersion(projectId, name, documents);
export const recoverSkillInstallationsForProjection = projectId => sourceVersions.recoverForProjection(projectId);
