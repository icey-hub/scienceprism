import path from 'node:path';
import { getProjectRoot } from '../projectService.js';
import { listSkillCatalog } from '../skillCatalog.js';
import { createGithubSkillSource, normalizeRepository, abortable } from '../skillDiscovery/github.js';
import { inspectSkillDescription } from '../skillDiscovery/metadata.js';
import { createSkillInstallationRepository, createSourceLock, installationError, assertNotCancelled, validInstallPath,
  SOURCE_LOCK, LICENSE_DIRECTORY, MAX_SKILL_FILES, MAX_SKILL_FILE_BYTES, MAX_SKILL_BYTES } from './repository.js';

export function normalizeSelectedSkill(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['selected', 'confirmed'].includes(key)) || input.confirmed !== true) {
    throw installationError('SELECTION_REQUIRED', '请选择并确认安装一个具体 Skill。');
  }
  const source = input.selected;
  if (!source || typeof source !== 'object' || Array.isArray(source) || Object.keys(source).some(key => !['repository', 'commit', 'path', 'digest'].includes(key))
    || !/^[a-f0-9]{40}$/.test(source.commit) || !/^[a-f0-9]{64}$/.test(source.digest) || typeof source.path !== 'string') throw installationError('INVALID_SELECTION', '安装选择必须包含仓库、完整 commit、子目录和已审阅 SKILL 摘要。');
  let normalized;
  try { normalized = normalizeRepository({ repository: source.repository, ref: source.commit, path: source.path }); }
  catch { throw installationError('INVALID_SELECTION', '安装来源无效。'); }
  return { repository: normalized.repository, commit: normalized.ref, path: normalized.path, digest: source.digest };
}
const inFolder = (file, folder) => !folder || file.startsWith(`${folder}/`);
const relativeTo = (file, folder) => folder ? file.slice(folder.length + 1) : file;
const isLicense = file => /^(?:licen[cs]e(?:\.[a-z0-9]+)?|copying(?:\.[a-z0-9]+)?)$/i.test(path.posix.basename(file));
function ancestors(folder) {
  const result = [];
  while (folder) { folder = path.posix.dirname(folder); if (folder === '.') folder = ''; result.push(folder); }
  return result;
}
function assertText(bytes, name) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw installationError('BINARY_UNSUPPORTED', '此首版安装器只保留 UTF-8 文本；发现二进制资产，未安装任何文件。', 422); }
  if (text.includes('\0')) throw installationError('BINARY_UNSUPPORTED', '发现二进制资产，未安装任何文件。', 422);
  if (path.posix.basename(name) === 'package.json') {
    let manifest; try { manifest = JSON.parse(text); } catch { throw installationError('INVALID_MANIFEST', 'package.json 不是有效 JSON；未执行任何依赖安装。', 422); }
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw installationError('INVALID_MANIFEST', 'package.json 必须是 JSON 对象。', 422);
    for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies', 'scripts']) {
      if (manifest[key] !== undefined && (!manifest[key] || typeof manifest[key] !== 'object' || Array.isArray(manifest[key]) || Object.values(manifest[key]).some(value => typeof value !== 'string'))) {
        throw installationError('INVALID_MANIFEST', 'package.json 依赖或脚本声明格式无效。', 422);
      }
    }
  }
  return text;
}

export function createSkillInstallationService({ sourceFactory = createGithubSkillSource({ maxRequests: 70 }), resolveProject = getProjectRoot,
  listInstalled = listSkillCatalog, repository = createSkillInstallationRepository({ resolveProject }), timeoutMs = 60_000 } = {}) {
    async function withPrepared(projectId, selected, { signal } = {}, operation) {
      const controller = new AbortController();
      const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      const timer = setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), timeoutMs);
      try {
        // Cancellation bounds all network preparation. Publication itself owns
        // the final cancellation check and completes one atomic rename.
        const bundle = await abortable(async () => {
          assertNotCancelled(combined);
          const projectRoot = await resolveProject(projectId);
          const installed = await listInstalled({ projectId, projectRoot });
          const snapshot = await sourceFactory({ signal: combined }).resolve({ repository: selected.repository, ref: selected.commit, path: selected.path });
          const skillPath = selected.path ? `${selected.path}/SKILL.md` : 'SKILL.md';
          const skillDocument = await snapshot.read(skillPath);
          if (skillDocument.digest !== selected.digest) throw installationError('SELECTION_CHANGED', 'SKILL 内容与选择时摘要不一致；请重新检查候选。', 409);
          const metadata = inspectSkillDescription(skillDocument.content, path.posix.basename(selected.path) || selected.repository.split('/')[1]);
          if (metadata.metadataStatus !== 'declared' || !metadata.name) throw installationError('INVALID_METADATA', 'SKILL 必须包含可验证的名称与说明；不要求 stages。', 422);
          const existing = installed.skills.find(skill => skill.name === metadata.name);
          if (existing && existing.relativePath !== `.agents/skills/${metadata.name}/SKILL.md`) throw installationError('NAME_CONFLICT', '此名称已由项目或内置 Skill 使用；未覆盖。', 409);
          const parents = ancestors(selected.path);
          if ((snapshot.unsafeEntries || []).some(entry => inFolder(entry.path, selected.path) || (isLicense(entry.path) && parents.includes(path.posix.dirname(entry.path) === '.' ? '' : path.posix.dirname(entry.path))))) throw installationError('UNSAFE_PACKAGE', '选中目录或祖先许可包含符号链接或子模块，未安装。', 422);
          const payload = snapshot.files.filter(file => inFolder(file.path, selected.path)).map(file => ({ file, path: relativeTo(file.path, selected.path), kind: 'original' }));
          if (payload.some(entry => entry.path === SOURCE_LOCK || entry.path.startsWith(`${SOURCE_LOCK}/`) || entry.path === LICENSE_DIRECTORY || entry.path.startsWith(`${LICENSE_DIRECTORY}/`))) throw installationError('RESERVED_PATH', '来源占用了安装器保留元数据路径。', 422);
          const licenses = snapshot.files.filter(file => isLicense(file.path) && parents.includes(path.posix.dirname(file.path) === '.' ? '' : path.posix.dirname(file.path)))
            .map(file => ({ file, path: `${LICENSE_DIRECTORY}/${file.path}`, kind: 'ancestor-license' }));
          const entries = [...payload, ...licenses].sort((a, b) => a.path.localeCompare(b.path));
          const foldedPaths = entries.map(entry => entry.path.toLowerCase());
          if (new Set(foldedPaths).size !== foldedPaths.length || foldedPaths.some(file => foldedPaths.some(other => other !== file && other.startsWith(`${file}/`)))) throw installationError('UNSAFE_PACKAGE', '来源包含大小写或文件/目录冲突，未安装。', 422);
          if (!entries.length || entries.length > MAX_SKILL_FILES || entries.some(entry => !validInstallPath(entry.path))) throw installationError('PACKAGE_LIMIT', 'Skill 文件数量或目录深度超过限制。', 422);
          if (entries.some(entry => entry.file.size > MAX_SKILL_FILE_BYTES) || entries.reduce((total, entry) => total + entry.file.size, 0) > MAX_SKILL_BYTES) throw installationError('PACKAGE_LIMIT', 'Skill 单文件超过 512 KB 或总大小超过 4 MiB。', 422);
          const files = []; const lockedFiles = [];
          for (const entry of entries) {
            assertNotCancelled(combined);
            const data = await snapshot.readBytes(entry.file.path, { maxBytes: MAX_SKILL_FILE_BYTES });
            assertText(data.bytes, entry.file.path);
            files.push({ path: entry.path, bytes: data.bytes });
            lockedFiles.push({ path: entry.path, originalPath: entry.file.path, size: data.bytes.length, digest: data.digest, kind: entry.kind });
          }
          return { files, lock: createSourceLock({ name: metadata.name, source: selected, files: lockedFiles }) };
        }, combined);
        const result = await operation(bundle, combined);
        return { ...result, installationOnly: true, scriptsExecuted: false, runtimeVerified: false, bindingsChanged: false };
      } finally { clearTimeout(timer); controller.abort(); }
    }
  function lifecycleInput(input, keys, confirmed = true) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key))
      || (confirmed && input.confirmed !== true) || typeof input.expectedVersionId !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedVersionId)) throw installationError('SELECTION_REQUIRED', '请明确选择目标版本并确认此操作。');
    return input;
  }
  return {
    list: projectId => repository.list(projectId),
    async install(projectId, input, options) {
      const selected = normalizeSelectedSkill(input);
      return withPrepared(projectId, selected, options, (bundle, signal) => repository.install(projectId, bundle, { signal }));
    },
    async previewUpdate(projectId, name, input, options) {
      lifecycleInput(input, ['selected', 'expectedVersionId'], false);
      const selected = normalizeSelectedSkill({ selected: input.selected, confirmed: true });
      return withPrepared(projectId, selected, options, bundle => repository.preview(projectId, name, bundle, { expectedVersionId: input.expectedVersionId }));
    },
    async update(projectId, name, input, options) {
      lifecycleInput(input, ['selected', 'expectedVersionId', 'confirmed']);
      const selected = normalizeSelectedSkill({ selected: input.selected, confirmed: true });
      return withPrepared(projectId, selected, options, (bundle, signal) => repository.update(projectId, name, bundle, { expectedVersionId: input.expectedVersionId, signal }));
    },
    async rollback(projectId, name, input, { signal } = {}) {
      lifecycleInput(input, ['versionId', 'expectedVersionId', 'confirmed']);
      const result = await repository.rollback(projectId, name, { versionId: input.versionId, expectedVersionId: input.expectedVersionId, signal });
      return { ...result, scriptsExecuted: false, bindingsChanged: false, runtimeVerified: false };
    },
    async uninstall(projectId, name, input, { signal } = {}) {
      lifecycleInput(input, ['expectedVersionId', 'confirmed']);
      const result = await repository.uninstall(projectId, name, { expectedVersionId: input.expectedVersionId, signal });
      return { ...result, scriptsExecuted: false, bindingsChanged: false, runtimeVerified: false };
    },
    versions: (projectId, name) => repository.versions(projectId, name),
    document: (projectId, name, versionId, file) => repository.document(projectId, name, versionId, file)
  };
}
