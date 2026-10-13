import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { HarnessRuntimeError } from './errors.js';

const MAX_BYTES = 1_048_576;
const releasedOwners = new Map();
const fail = (code, message, status = 409) => { throw new HarnessRuntimeError(status, `HARNESS_WORKSPACE_${code}`, message); };
const id = z.string().min(1).max(200).regex(/^[^\x00-\x1f\x7f]+$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const relative = z.string().min(1).max(1024).refine(value => !/[\\\x00-\x1f\x7f]/.test(value)
  && !path.posix.isAbsolute(value) && !/^[A-Za-z]:/.test(value) && !value.split('/').some(part => !part || part === '.' || part === '..'));
const status = z.enum(['preparing', 'running', 'completed', 'failed', 'cancelled', 'ambiguous']);
const versions = z.object({ runtime: id, codex: id.optional(), schemaHash: hash.optional(), toolsHash: hash.optional() }).strict();
const child = z.object({ runId: id, parentRunId: id, parentAttempt: z.number().int().positive(), workerRoot: relative,
  pid: z.number().int().positive().nullable(), threadId: id.nullable(), turnId: id.nullable(), status,
  stopConfirmed: z.boolean() }).strict();
const checkpointObject = z.object({ schemaVersion: z.literal(1), identityHash: hash, runId: id, attempt: z.number().int().positive(),
  revision: z.number().int().nonnegative(), status, stopConfirmed: z.boolean(),
  versions: versions.nullable(), skills: z.array(z.object({ path: relative, sha256: hash, bytes: z.number().int().nonnegative().max(MAX_BYTES) }).strict()).max(128),
  baseFiles: z.array(z.object({ path: relative, sha256: hash.nullable(), bytes: z.number().int().nonnegative().max(MAX_BYTES) }).strict()).max(4096),
  children: z.array(child).max(16), runtimeProcess: z.object({ pid: z.number().int().positive().nullable(), stopConfirmed: z.boolean() }).strict().optional(),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime() }).strict();
const checkpointSchema = checkpointObject.refine(value => ['skills', 'baseFiles'].every(key => new Set(value[key].map(entry => entry.path)).size === value[key].length)
    && new Set(value.children.map(entry => entry.runId)).size === value.children.length
    && new Set(value.children.map(entry => entry.workerRoot)).size === value.children.length
    && value.children.every(entry => entry.parentRunId === value.runId && entry.parentAttempt === value.attempt));
const ownerSchema = z.object({ schemaVersion: z.literal(1), identityHash: hash, token: z.string().uuid(), pid: z.number().int().positive(), released: z.boolean() }).strict();
const updateSchema = checkpointObject.pick({ status: true, stopConfirmed: true, versions: true, skills: true, baseFiles: true, children: true, runtimeProcess: true }).partial();
const parse = (schema, value, code = 'INPUT_INVALID') => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) fail(code, 'The retained workspace metadata is invalid.');
  return parsed.data;
};
const digest = value => createHash('sha256').update(value).digest('hex');

function directory(target, { create = false, privateMode = false } = {}) {
  let current = path.parse(target).root;
  for (const part of target.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (create && !fs.existsSync(current)) fs.mkdirSync(current, { mode: 0o700 });
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('STORAGE_INVALID', 'The runtime directory must not contain links.');
  }
  const stat = fs.lstatSync(target);
  if (privateMode && ((stat.mode & 0o777) !== 0o700 || stat.uid !== process.getuid?.())) fail('STORAGE_INVALID', 'The private runtime directory has an invalid owner or mode.');
}

function file(root, name, allowMissing = false) {
  directory(root, { privateMode: true });
  const target = path.join(root, name);
  let stat;
  try { stat = fs.lstatSync(target); } catch (error) { if (allowMissing && error.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid?.()) {
    fail('STORAGE_INVALID', 'Runtime metadata must be a private regular file.');
  }
  const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.ino !== stat.ino || opened.dev !== stat.dev) fail('STORAGE_INVALID', 'Runtime metadata changed while being opened.');
    if (opened.size > MAX_BYTES) fail('CAPACITY', 'Runtime metadata exceeds its byte limit.', 503);
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let bytes = 0;
    while (bytes < buffer.length) { const count = fs.readSync(fd, buffer, bytes, buffer.length - bytes, bytes); if (!count) break; bytes += count; }
    if (bytes > MAX_BYTES) fail('CAPACITY', 'Runtime metadata exceeds its byte limit.', 503);
    try { return JSON.parse(buffer.subarray(0, bytes).toString('utf8')); } catch { fail('STATE_INVALID', 'Runtime metadata is not valid JSON.'); }
  } finally { fs.closeSync(fd); }
}

function write(root, name, value, exclusive = false) {
  const bytes = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(bytes) > MAX_BYTES) fail('CAPACITY', 'Runtime metadata exceeds its byte limit.', 503);
  file(root, name, true);
  const temporary = path.join(root, `.${name}.${randomUUID()}.tmp`);
  let fd;
  try {
    fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    file(root, name, true);
    if (exclusive) { fs.linkSync(temporary, path.join(root, name)); fs.unlinkSync(temporary); }
    else fs.renameSync(temporary, path.join(root, name));
    const dirFd = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  } catch (error) {
    if (error instanceof HarnessRuntimeError) throw error;
    fail('SAVE_FAILED', 'Private runtime metadata could not be saved.', 500);
  } finally { if (fd !== undefined) fs.closeSync(fd); fs.rmSync(temporary, { force: true }); }
}

// ESRCH is the only acceptable evidence of death. A reused PID, EPERM, or
// any unknown OS error blocks recovery; a saved terminal status is insufficient.
function dead(pid) {
  if (pid === null) return false;
  try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; }
}
function childrenStopped(state) {
  const process = state.runtimeProcess;
  return (!process || (process.pid === null ? process.stopConfirmed : dead(process.pid))) && state.children.every(entry => entry.pid === null
    ? entry.stopConfirmed && !['preparing', 'running'].includes(entry.status)
    : dead(entry.pid));
}

function workerDirectory(root, relativePath) {
  let current = root;
  for (const part of relativePath.split('/')) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700) {
      fail('STORAGE_INVALID', 'Worker controls require private real directories.');
    }
  }
}

/** Private parent-Run workspace and exclusive ownership only. No scheduling,
 * prompt retry, model credentials, or automatic tool replay occurs here.
 * A crash during the recovery claim requires explicit operator reconciliation;
 * this module never deletes an unexplained claim based on elapsed time.
 */
export async function createRetainedWorkspace({ projectRoot, runId, attempt, recover = false, expectedVersions } = {}) {
  parse(id, runId); parse(z.number().int().positive(), attempt);
  if (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot) || path.resolve(projectRoot) !== projectRoot || typeof recover !== 'boolean') {
    fail('INPUT_INVALID', 'A normalized project root and Run identity are required.');
  }
  if (expectedVersions !== undefined) expectedVersions = parse(versions, expectedVersions);
  directory(projectRoot);
  const realProjectRoot = fs.realpathSync(projectRoot);
  if (realProjectRoot !== projectRoot) fail('STORAGE_INVALID', 'The project root must be canonical.');
  const identityHash = digest(JSON.stringify([realProjectRoot, runId, attempt]));
  const container = path.join(path.dirname(realProjectRoot), '.scienceprism-runtime');
  directory(container, { create: true, privateMode: true });
  const root = path.join(container, identityHash);
  let created = false;
  try { fs.mkdirSync(root, { mode: 0o700 }); created = true; } catch (error) { if (error.code !== 'EEXIST') throw error; }
  directory(root, { privateMode: true });
  const claimPath = path.join(root, 'claim');
  let claim;
  try { claim = fs.openSync(claimPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600); }
  catch (error) { if (error.code === 'EEXIST') fail('BUSY', 'Another instance owns the workspace claim.'); throw error; }
  let owner;
  let state;
  try {
    if (created) {
      const at = new Date().toISOString();
      state = { schemaVersion: 1, identityHash, runId, attempt, revision: 0, status: 'preparing', stopConfirmed: false,
        versions: expectedVersions || null, skills: [], baseFiles: [], children: [], createdAt: at, updatedAt: at };
    } else {
      owner = parse(ownerSchema, file(root, 'owner.json'), 'STATE_INVALID');
      state = parse(checkpointSchema, file(root, 'checkpoint.json'), 'STATE_INVALID');
      if (owner.identityHash !== identityHash || state.identityHash !== identityHash || state.runId !== runId || state.attempt !== attempt) fail('IDENTITY_CONFLICT', 'The retained Run identity does not match.');
      if (expectedVersions && JSON.stringify(state.versions) !== JSON.stringify(expectedVersions)) fail('VERSION_CONFLICT', 'The retained runtime versions do not match.');
      for (const entry of state.children) workerDirectory(root, entry.workerRoot);
      if (!recover) fail('RECOVERY_REQUIRED', 'This workspace already exists; explicit recovery is required.');
      const trustedRelease = owner.released && owner.pid === process.pid && releasedOwners.get(root) === owner.token;
      if ((!trustedRelease && !dead(owner.pid)) || !childrenStopped(state)) fail('OWNER_ACTIVE', 'The previous owner or child process has not been confirmed stopped.');
    }
    directory(path.join(root, 'workspace'), { create: true, privateMode: true });
    directory(path.join(root, 'dsh-home'), { create: true, privateMode: true });
    owner = { schemaVersion: 1, identityHash, token: randomUUID(), pid: process.pid, released: false };
    // Save evidence before ownership. If this fails, the old owner stays intact;
    // an incomplete first creation is refused rather than silently reinitialized.
    if (created) write(root, 'checkpoint.json', state, true);
    write(root, 'owner.json', owner, created);
    releasedOwners.delete(root);
  } finally { fs.closeSync(claim); fs.unlinkSync(claimPath); }
  let closed = false;
  const read = () => {
    if (closed) fail('OWNER_CLOSED', 'The workspace owner has been released.');
    const current = parse(ownerSchema, file(root, 'owner.json'), 'STATE_INVALID');
    if (current.token !== owner.token || current.pid !== process.pid || current.released || current.identityHash !== identityHash) fail('OWNER_CONFLICT', 'The workspace owner changed.');
    for (const name of ['workspace', 'dsh-home']) directory(path.join(root, name), { privateMode: true });
    const checkpoint = parse(checkpointSchema, file(root, 'checkpoint.json'), 'STATE_INVALID');
    if (checkpoint.identityHash !== identityHash || checkpoint.runId !== runId || checkpoint.attempt !== attempt) fail('IDENTITY_CONFLICT', 'The retained Run identity changed.');
    if (JSON.stringify(checkpoint) !== JSON.stringify(state)) fail('STATE_CONFLICT', 'The retained checkpoint changed outside its owner.');
    for (const entry of checkpoint.children) workerDirectory(root, entry.workerRoot);
    return checkpoint;
  };
  return Object.freeze({ root, workspace: path.join(root, 'workspace'), dshHome: path.join(root, 'dsh-home'), recovered: !created,
    async read() { return read(); },
    async update(input) {
      const patch = parse(updateSchema, input); const previous = read();
      const next = parse(checkpointSchema, { ...previous, ...patch, revision: previous.revision + 1, updatedAt: new Date().toISOString() });
      for (const key of ['versions', 'skills', 'baseFiles']) {
        const fixed = key === 'versions' ? previous[key] !== null : previous[key].length > 0;
        if (fixed && JSON.stringify(previous[key]) !== JSON.stringify(next[key])) fail('VERSION_CONFLICT', 'Captured input and runtime versions cannot be replaced.');
      }
      for (const previousChild of previous.children) {
        const nextChild = next.children.find(entry => entry.runId === previousChild.runId);
        if (!nextChild || nextChild.workerRoot !== previousChild.workerRoot || nextChild.pid !== previousChild.pid && previousChild.pid !== null && !dead(previousChild.pid)) {
          fail('CHILD_CONFLICT', 'Child process evidence cannot be removed or replaced while active.');
        }
      }
      if (previous.runtimeProcess?.pid !== null && previous.runtimeProcess?.pid !== undefined
        && next.runtimeProcess?.pid !== previous.runtimeProcess.pid && !dead(previous.runtimeProcess.pid)) {
        fail('CHILD_CONFLICT', 'Runtime process evidence cannot be replaced while active.');
      }
      if (next.runtimeProcess?.stopConfirmed && next.runtimeProcess.pid !== null && !dead(next.runtimeProcess.pid)) fail('CHILD_ACTIVE', 'Runtime stopping has not been confirmed by the OS.');
      for (const entry of next.children) {
        if (entry.workerRoot === 'workspace' || entry.workerRoot.startsWith('workspace/') || entry.workerRoot === 'dsh-home' || entry.workerRoot.startsWith('dsh-home/')) fail('STORAGE_INVALID', 'Worker controls must stay outside the model workspace and credential home.');
        workerDirectory(root, entry.workerRoot);
        if (entry.stopConfirmed && entry.pid !== null && !dead(entry.pid)) fail('CHILD_ACTIVE', 'Child stopping has not been confirmed by the OS.');
      }
      if (next.stopConfirmed && !childrenStopped(next)) fail('CHILD_ACTIVE', 'Not all child processes are confirmed stopped.');
      write(root, 'checkpoint.json', next); state = next; return structuredClone(next);
    },
    async release({ status: terminalStatus, stopConfirmed } = {}) {
      parse(z.enum(['completed', 'failed', 'cancelled', 'ambiguous']), terminalStatus); parse(z.boolean(), stopConfirmed);
      const current = read();
      if (stopConfirmed && !childrenStopped(current)) fail('CHILD_ACTIVE', 'Not all child processes are confirmed stopped.');
      const next = { ...current, revision: current.revision + 1, status: terminalStatus, stopConfirmed, updatedAt: new Date().toISOString() };
      write(root, 'checkpoint.json', next);
      state = next;
      write(root, 'owner.json', { ...owner, released: stopConfirmed });
      if (stopConfirmed) releasedOwners.set(root, owner.token);
      closed = true; return structuredClone(next);
    }
  });
}
