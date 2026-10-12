import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { REPO_ROOT } from '../../config/constants.js';
import { getProjectRoot } from '../projectService.js';
import { listSkillCatalog, readEnabledSkillDocument } from '../skillCatalog.js';
import { safeJoin } from '../../utils/pathUtils.js';
import { withHubLock } from '../projectHub/repository.js';
import { readInstalledSkillProjectionVersion, recoverSkillInstallationsForProjection } from '../skillInstallation/repository.js';

export const SKILL_SOURCE_PREFIXES = Object.freeze(['.agents/skills', '.dsh/skills']);
const MAX_SELECTED = 32;
const MAX_DOCUMENTS = 512;
const MAX_BYTES = 4 * 1024 * 1024;
const NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SKIPPED_DIRECTORIES = new Set(['scripts', 'node_modules', '.scienceprism-licenses']);
function projectionError(code, message) {
  const error = new Error(message); error.code = `SKILL_PROJECTION_${code}`; error.statusCode = 422; return error;
}
function selectedNames(values) {
  if (!Array.isArray(values) || values.length > MAX_SELECTED || values.some(name => typeof name !== 'string' || !NAME.test(name) || name.length > 64)) throw projectionError('INVALID_SELECTION', '运行时 Skill 选择无效。');
  return [...new Set(values)];
}
function checked(root, relative) {
  try { return safeJoin(root, relative); } catch { throw projectionError('UNSAFE_PATH', 'Skill 投影路径含链接或越界。'); }
}
async function workspaceRootFor(workspaceRoot, projectRoot) {
  const workspace = await fs.realpath(workspaceRoot);
  const repository = await fs.realpath(REPO_ROOT);
  const project = projectRoot ? await fs.realpath(projectRoot) : null;
  if (workspace === repository || workspace === project) throw projectionError('NOT_ISOLATED', 'Skill 投影只能写入隔离工作区。');
  return workspace;
}

/** Remove copied source stores from an isolated workspace, including old
 * metadata/scripts/unselected entries. Never call on a live project directory. */
export async function clearWorkspaceSkillSources(workspaceRoot, { projectRoot } = {}) {
  if (!projectRoot) throw projectionError('PROJECT_REQUIRED', '清理 Skill 投影需要明确的原项目路径。');
  const workspace = await workspaceRootFor(workspaceRoot, projectRoot);
  for (const prefix of SKILL_SOURCE_PREFIXES) await fs.rm(checked(workspace, prefix), { recursive: true, force: true });
  return [...SKILL_SOURCE_PREFIXES];
}

async function markdownDocuments(sourceRoot, sourceDirectory) {
  const files = []; let entriesSeen = 0;
  async function walk(relative = '', depth = 0) {
    if (depth > 16) throw projectionError('LIMIT', 'Skill 引用目录超过投影深度限制。');
    const entries = await fs.readdir(checked(sourceRoot, relative ? `${sourceDirectory}/${relative}` : sourceDirectory), { withFileTypes: true });
    // A nested Skill is a separate selectable package, not a reference tree.
    if (relative && entries.some(entry => entry.name === 'SKILL.md')) return;
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (++entriesSeen > 2048) throw projectionError('LIMIT', 'Skill 引用目录超过投影检查范围。');
      if (entry.name.startsWith('.') || SKIPPED_DIRECTORIES.has(entry.name)) continue;
      const file = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw projectionError('UNSAFE_PATH', '选中 Skill 的引用包含链接，未投影。');
      if (entry.isDirectory()) await walk(file, depth + 1);
      else if (entry.isFile() && entry.name.endsWith('.md') && (file === 'SKILL.md' || entry.name !== 'SKILL.md')) files.push(file);
    }
  }
  await walk();
  return files.sort((a, b) => (a === 'SKILL.md' ? -1 : b === 'SKILL.md' ? 1 : a.localeCompare(b)));
}

/** Provider-neutral document projection. Both DSH orchestration and a Codex
 * worker can consume the same source versions; this creates no new owner,
 * install, binding, tool permission or script execution capability. */
async function projectSelectedSkillDocumentsUnlocked({ projectId, projectRoot, workspaceRoot, enabledSkillNames = [], capabilityPolicy, signal } = {}) {
  const names = selectedNames(enabledSkillNames);
  signal?.throwIfAborted();
  const authoritativeRoot = await getProjectRoot(projectId);
  if (projectRoot && await fs.realpath(projectRoot) !== await fs.realpath(authoritativeRoot)) throw projectionError('PROJECT_MISMATCH', 'Skill 来源与项目不一致。');
  const root = authoritativeRoot;
  const workspace = await workspaceRootFor(workspaceRoot, root);
  await recoverSkillInstallationsForProjection(projectId);
  const { skills } = names.length ? await listSkillCatalog({ projectId, projectRoot: root, names, capabilityPolicy }) : { skills: [] };
  const byName = new Map(skills.map(skill => [skill.name, skill]));
  const documents = []; const selected = []; const prepared = []; let totalBytes = 0;
  for (const name of names) {
    signal?.throwIfAborted();
    const skill = byName.get(name);
    if (!skill?.available) throw projectionError('UNAVAILABLE', `选中 Skill 不可用：${name}。`);
    const sourceDirectory = path.posix.dirname(skill.relativePath);
    if (!SKILL_SOURCE_PREFIXES.some(prefix => sourceDirectory === `${prefix}/${name}`)) throw projectionError('UNSAFE_PATH', 'Skill owner 返回了无效来源路径。');
    const sourceRoot = skill.source === 'project' ? root : REPO_ROOT;
    const files = await markdownDocuments(sourceRoot, sourceDirectory);
    if (!files.includes('SKILL.md')) throw projectionError('UNAVAILABLE', `选中 Skill 缺少 SKILL.md：${name}。`);
    const countBefore = documents.length;
    for (const file of files) {
      signal?.throwIfAborted();
      if (documents.length >= MAX_DOCUMENTS) throw projectionError('LIMIT', '选中 Skill 文档超过 512 份。');
      const content = await readEnabledSkillDocument({ projectId, enabledSkillNames: names, name, file, capabilityPolicy, fullDocument: true });
      const bytes = Buffer.from(content, 'utf8'); totalBytes += bytes.length;
      if (totalBytes > MAX_BYTES) throw projectionError('LIMIT', '选中 Skill 文档超过 4 MiB。');
      const projectionPath = `.dsh/skills/${name}/${file}`;
      const document = { skillName: name, source: skill.source, sourceRelativePath: `${sourceDirectory}/${file}`,
        projectionPath, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
      documents.push(document); prepared.push({ path: projectionPath, bytes });
    }
    const skillDocuments = documents.slice(countBefore);
    const versionId = skill.source === 'project' && sourceDirectory.startsWith('.agents/skills/')
      ? await readInstalledSkillProjectionVersion(projectId, name, skillDocuments) : null;
    for (const document of skillDocuments) document.versionId = versionId;
    selected.push({ name, description: skill.description, stages: skill.stages, source: skill.source, sourceRelativePath: skill.relativePath, versionId, documentCount: documents.length - countBefore });
  }
  signal?.throwIfAborted();
  await clearWorkspaceSkillSources(workspace, { projectRoot: root });
  try {
    for (const file of prepared) {
      signal?.throwIfAborted();
      await fs.mkdir(checked(workspace, path.posix.dirname(file.path)), { recursive: true });
      await fs.writeFile(checked(workspace, file.path), file.bytes, { flag: 'wx', mode: 0o400 });
    }
  } catch (error) { await clearWorkspaceSkillSources(workspace, { projectRoot: root }); throw error; }
  return { format: 'markdown-only', skills: selected, documents, totalBytes,
    excludedPaths: [...SKILL_SOURCE_PREFIXES], sourceStoresExcluded: true, scriptsIncluded: false, scriptsExecuted: false,
    bindingsChanged: false, runtimeVerified: false };
}

export function projectSelectedSkillDocuments(options = {}) {
  return withHubLock(options.projectId, () => projectSelectedSkillDocumentsUnlocked(options));
}

/** Map a runtime read back to the source version. Consumers attach this to an
 * actual tool read event; projection creation alone is not proof it was used. */
export function sourceForProjectedSkillRead(projection, relativePath) {
  if (typeof relativePath !== 'string') return null;
  const normalized = relativePath.replace(/\\/g, '/');
  if (normalized.startsWith('/') || normalized.split('/').some(part => !part || part === '.' || part === '..')) return null;
  const document = projection?.documents?.find(item => item.projectionPath === normalized);
  return document ? { skillName: document.skillName, source: document.source, sourceRelativePath: document.sourceRelativePath, versionId: document.versionId, sha256: document.sha256, bytes: document.bytes } : null;
}
