import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DATA_DIR } from '../config/constants.js';
import { assertStorageName, safeJoin } from '../utils/pathUtils.js';
import { getProjectRoot } from './projectService.js';
import { isSensitivePath } from './harnessRuntime/capabilities.js';
import { withHarnessRunLock } from './harnessRuntime/repository.js';

const FORMAT = 'scienceprism-project-backup';
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 10000;
const EXCLUDED = new Set(['.git', 'node_modules', '.cache', '.compile']);
const SECRET_FIELD = /^(?:apiKey|llmApiKey|token|accessToken|refreshToken|password|secret|collabToken|authorization)$/i;
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
function fail(statusCode, code, message) { return Object.assign(new Error(message), { statusCode, code }); }
function allowed(filePath) {
  // Runtime metadata is excluded from model context, but is essential to recovery.
  const credentialPath = typeof filePath === 'string' ? filePath.replace(/^\.(?:scienceprism|openprism)(?:\/|$)/, '') : filePath;
  return typeof filePath === 'string' && filePath.length > 0 && !filePath.startsWith('/')
    && !filePath.includes('\\') && !filePath.split('/').some(p => !p || p === '.' || p === '..' || EXCLUDED.has(p))
    && !/[\x00-\x1f]/.test(filePath) && !isSensitivePath(credentialPath) && !filePath.endsWith('.tmp');
}
function withoutSecrets(value) {
  if (Array.isArray(value)) return value.map(withoutSecrets);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !SECRET_FIELD.test(key)).map(([key, item]) => [key, withoutSecrets(item)]));
}
function safeBytes(filePath, bytes) {
  if (filePath === 'project.json' || ((filePath.startsWith('.scienceprism/') || filePath.startsWith('.openprism/')) && filePath.endsWith('.json') && !filePath.includes('/artifacts/'))) {
    const value = withoutSecrets(JSON.parse(bytes.toString('utf8')));
    if (filePath === '.scienceprism/mcp.json' && Array.isArray(value.servers)) {
      value.servers = value.servers.map(server => {
        // MCP credentials use arbitrary environment/header names and may be in
        // URL queries. Restored connections must be configured and discovered again.
        let url = server.url || '';
        try { const parsed = new URL(url); parsed.search = ''; url = parsed.href; } catch {}
        return { ...server, url, env: {}, headers: {}, enabled: false, discovery: null };
      });
    }
    return Buffer.from(JSON.stringify(value, null, 2));
  }
  return bytes;
}
async function collect(root, relative = '', state = { files: [], bytes: 0 }) {
  const entries = await fs.readdir(relative ? safeJoin(root, relative) : root, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const filePath = relative ? `${relative}/${entry.name}` : entry.name;
    if (!allowed(filePath)) continue;
    if (entry.isSymbolicLink()) throw fail(400, 'BACKUP_SYMLINK', 'Remove project symlinks before backing up.');
    const target = safeJoin(root, filePath);
    if (entry.isDirectory()) { await collect(root, filePath, state); continue; }
    if (!entry.isFile()) throw fail(400, 'BACKUP_FILE_TYPE', 'Only regular project files can be backed up.');
    const stat = await fs.stat(target);
    if (state.bytes + stat.size > MAX_BYTES || state.files.length >= MAX_FILES) throw fail(413, 'BACKUP_TOO_LARGE', 'Project backups support up to 64 MiB and 10,000 files.');
    const original = await fs.readFile(target);
    const bytes = safeBytes(filePath, original);
    state.bytes += bytes.length;
    if (state.bytes > MAX_BYTES) throw fail(413, 'BACKUP_TOO_LARGE', 'Project backup is too large.');
    state.files.push({ path: filePath, encoding: 'base64', bytes: bytes.length, sha256: sha(bytes), content: bytes.toString('base64') });
  }
  return state.files;
}

/** A versioned, hash-checked local snapshot. Configuration credentials are excluded. */
export async function exportProjectBackup(projectId) {
  return withHarnessRunLock(projectId, async () => {
    const root = await getProjectRoot(projectId);
    const files = await collect(root);
    const check = await collect(root);
    if (JSON.stringify(files) !== JSON.stringify(check)) throw fail(409, 'BACKUP_CHANGED', 'Project files changed during backup. Save and retry.');
    const metadata = files.find(file => file.path === 'project.json');
    const project = JSON.parse(Buffer.from(metadata.content, 'base64').toString('utf8'));
    if (project.id !== projectId) throw fail(400, 'BACKUP_PROJECT_MISMATCH', 'Project metadata does not match its directory.');
    return { format: FORMAT, version: 1, createdAt: new Date().toISOString(), project, files };
  });
}

function validateBackup(backup) {
  if (!backup || backup.format !== FORMAT || backup.version !== 1 || !Array.isArray(backup.files) || !backup.files.length || backup.files.length > MAX_FILES) throw fail(400, 'INVALID_BACKUP', 'Unsupported or incomplete project backup.');
  const id = assertStorageName(backup.project?.id);
  if (id.startsWith('.')) throw fail(400, 'INVALID_BACKUP', 'Invalid project identifier.');
  let total = 0;
  const paths = new Set();
  const files = backup.files.map(file => {
    if (!file || !allowed(file.path) || paths.has(file.path) || file.encoding !== 'base64' || typeof file.content !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.content)) throw fail(400, 'INVALID_BACKUP', 'Invalid, duplicate, or sensitive backup path.');
    paths.add(file.path);
    total += file.content.length * 3 / 4;
    if (total > MAX_BYTES + 2 * MAX_FILES) throw fail(413, 'BACKUP_TOO_LARGE', 'Project backup is too large.');
    const bytes = Buffer.from(file.content, 'base64');
    if (bytes.length !== file.bytes || sha(bytes) !== file.sha256) throw fail(400, 'BACKUP_HASH_MISMATCH', 'A backup file is damaged or incomplete.');
    // A crafted backup must not introduce configuration credentials either.
    if (!safeBytes(file.path, bytes).equals(bytes)) throw fail(400, 'BACKUP_CREDENTIALS', 'Backup metadata contains excluded credentials or unsupported formatting.');
    return { path: file.path, bytes };
  });
  const metadata = files.find(file => file.path === 'project.json');
  if (!metadata || JSON.parse(metadata.bytes.toString('utf8')).id !== id) throw fail(400, 'BACKUP_PROJECT_MISMATCH', 'Backup project identity is inconsistent.');
  return { id, files };
}

/** Restore preserves lineage IDs and never replaces an existing project. */
export async function restoreProjectBackup(backup) {
  let validated;
  try { validated = validateBackup(backup); }
  catch (error) { if (error.statusCode) throw error; throw fail(400, 'INVALID_BACKUP', 'The backup cannot be read.'); }
  const { id, files } = validated;
  return withHarnessRunLock(id, async () => {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const destination = path.join(DATA_DIR, id);
    try { await fs.lstat(destination); throw fail(409, 'PROJECT_EXISTS', 'This project already exists. Restore to an empty data directory; existing projects are never overwritten.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const temporary = await fs.mkdtemp(path.join(DATA_DIR, '.restore-'));
    try {
      for (const file of files.filter(file => file.path !== 'project.json')) {
        const target = safeJoin(temporary, file.path);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, file.bytes, { flag: 'wx' });
      }
      await fs.writeFile(path.join(temporary, 'project.json'), files.find(file => file.path === 'project.json').bytes, { flag: 'wx' });
      await fs.rename(temporary, destination);
      return JSON.parse((await fs.readFile(path.join(destination, 'project.json'))).toString('utf8'));
    } finally { await fs.rm(temporary, { recursive: true, force: true }); }
  });
}
