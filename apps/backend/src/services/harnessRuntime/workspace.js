import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createTwoFilesPatch } from 'diff';
import { safeJoin } from '../../utils/pathUtils.js';
import { isPathAllowed, isSensitivePath } from './capabilities.js';
import { fileVersion } from './fileVersions.js';
import { isBundledSkillPath } from '../researchResearch/researchSkills.js';

const MAX_PATCH_FILE_BYTES = 1024 * 1024;
const IGNORED_FILES = new Set(['project.json', '.compile']);

function toPosix(relativePath) {
  return relativePath.split(path.sep).join('/');
}

export async function collectFiles(root, relative = '') {
  const current = path.join(root, relative);
  const entries = await fs.readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (IGNORED_FILES.has(entry.name) || isSensitivePath(entry.name)) continue;
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(root, child));
    else if (entry.isFile()) files.push(toPosix(child));
  }
  return files;
}

function normalizedAllowedPaths(policy) {
  return (policy?.allowedPaths || []).map((value) => String(value || '').replace(/\\/g, '/'))
    .map((value) => path.posix.normalize(value))
    .filter((value) => value && value !== '.' && value !== '..' && !value.startsWith('../') && !value.startsWith('/') && !isSensitivePath(value));
}

export async function copyWorkspace(sourceRoot, targetRoot, policy = {}) {
  const allowedPaths = normalizedAllowedPaths(policy);
  const hasPathScope = Array.isArray(policy?.allowedPaths) && policy.allowedPaths.length > 0;
  await fs.mkdir(targetRoot, { recursive: true });
  await fs.cp(sourceRoot, targetRoot, {
    recursive: true,
    filter(source) {
      const relative = toPosix(path.relative(sourceRoot, source));
      if (!relative) return true;
      const name = path.basename(source);
      if (IGNORED_FILES.has(name) || isSensitivePath(relative)) return false;
      if (!hasPathScope) return true;
      return isPathAllowed(relative, policy) || allowedPaths.some((allowedPath) => allowedPath.startsWith(`${relative}/`));
    }
  });
}

async function readTextFile(root, relativePath) {
  const absolute = safeJoin(root, relativePath);
  const stat = await fs.stat(absolute);
  if (!stat.isFile() || stat.size > MAX_PATCH_FILE_BYTES) return null;
  return fs.readFile(absolute, 'utf8');
}

export async function snapshotWorkspace(workspace, policy) {
  const snapshot = new Map();
  for (const relativePath of await collectFiles(workspace)) {
    if (isPathAllowed(relativePath, policy, { operation: 'read' })) {
      snapshot.set(relativePath, await readTextFile(workspace, relativePath));
    }
  }
  return snapshot;
}

export async function collectPatches(snapshot, workspaceRoot, policy, excludedPaths = []) {
  const originalFiles = [...snapshot.keys()];
  const workspaceFiles = await collectFiles(workspaceRoot);
  const originalSet = new Set(originalFiles);
  const workspaceSet = new Set(workspaceFiles);
  const allPaths = [...new Set([...originalFiles, ...workspaceFiles])].sort();
  const patches = [];

  for (const relativePath of allPaths) {
    if (isBundledSkillPath(relativePath, excludedPaths)) continue;
    if (!isPathAllowed(relativePath, policy, { operation: 'patch' })) continue;
    const original = originalSet.has(relativePath) ? snapshot.get(relativePath) : '';
    const proposed = workspaceSet.has(relativePath) ? await readTextFile(workspaceRoot, relativePath) : '';
    if (original === null || proposed === null || (original === proposed && originalSet.has(relativePath) === workspaceSet.has(relativePath))) continue;
    patches.push({
      path: relativePath,
      original,
      baseVersion: fileVersion(originalSet.has(relativePath) ? original : null),
      content: proposed,
      deleted: !workspaceSet.has(relativePath),
      diff: createTwoFilesPatch(relativePath, relativePath, original, proposed, 'current', 'proposed')
    });
  }
  return patches;
}
