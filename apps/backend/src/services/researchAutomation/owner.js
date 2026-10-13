import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ResearchWorkflowError } from '../researchWorkflow/errors.js';

const fail = (code, message) => { throw new ResearchWorkflowError(409, `AUTOMATION_OWNER_${code}`, message); };
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
const identity = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && value === value.trim()
  && value.isWellFormed() && !/[\x00-\x1f\x7f]/.test(value);
const ownUid = stat => process.getuid === undefined || stat.uid === process.getuid();
function directory(target, { create = false, privateMode = false } = {}) {
  if (create) { try { fs.mkdirSync(target, { mode: 0o700 }); } catch (reason) { if (reason.code !== 'EEXIST') fail('STORAGE_INVALID', 'The protected owner directory cannot be created.'); } }
  let stat, canonical;
  try { stat = fs.lstatSync(target); canonical = fs.realpathSync(target); }
  catch { fail('STORAGE_INVALID', 'The protected owner directory is unavailable.'); }
  if (!stat.isDirectory() || stat.isSymbolicLink() || canonical !== target || !ownUid(stat)
    || privateMode && (stat.mode & 0o777) !== 0o700) fail('STORAGE_INVALID', 'Owner directories must be canonical, private and unlinked.');
  return stat;
}
function readOwner(active) {
  directory(active, { privateMode: true });
  const target = path.join(active, 'owner.json'); let stat;
  try { stat = fs.lstatSync(target); } catch { fail('UNKNOWN', 'The existing owner has no reliable identity record.'); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !ownUid(stat) || (stat.mode & 0o777) !== 0o600 || stat.size > 4096) fail('STORAGE_INVALID', 'Owner metadata must be a bounded private regular file without links.');
  let fd;
  try {
    fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size > 4096) fail('STORAGE_INVALID', 'Owner metadata changed while being opened.');
    const buffer = Buffer.alloc(4097), length = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (length > 4096) fail('UNKNOWN', 'Owner metadata exceeds its bound.');
    let owner; try { owner = JSON.parse(buffer.subarray(0, length).toString('utf8')); } catch { fail('UNKNOWN', 'The existing owner metadata is invalid.'); }
    if (!owner || typeof owner !== 'object' || Array.isArray(owner) || Object.keys(owner).length !== 5
      || Object.keys(owner).some(key => !['schemaVersion', 'pid', 'sessionId', 'token', 'released'].includes(key))
      || owner.schemaVersion !== 1 || !Number.isSafeInteger(owner.pid) || owner.pid < 1 || !identity(owner.sessionId)
      || !uuid(owner.token) || typeof owner.released !== 'boolean') fail('UNKNOWN', 'The existing owner identity is invalid.');
    return owner;
  } catch (reason) {
    if (reason instanceof ResearchWorkflowError) throw reason;
    fail('UNKNOWN', 'The existing owner identity could not be safely read.');
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function saveOwner(active, owner, { exclusive = false } = {}) {
  directory(active, { privateMode: true });
  const target = path.join(active, 'owner.json'), temporary = path.join(active, `.owner-${randomUUID()}.tmp`);
  let fd;
  try {
    fd = fs.openSync(exclusive ? target : temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    fs.writeFileSync(fd, JSON.stringify(owner) + '\n'); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    if (!exclusive) {
      const current = readOwner(active);
      if (current.token !== owner.token || current.pid !== process.pid || current.sessionId !== owner.sessionId || current.released) fail('LOST', 'This lease no longer owns the active session.');
      fs.renameSync(temporary, target);
    }
    const dir = fs.openSync(active, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  } catch (reason) {
    if (reason instanceof ResearchWorkflowError) throw reason;
    fail('SAVE_FAILED', 'The automation owner could not be durably saved.');
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (!exclusive) { try { fs.unlinkSync(temporary); } catch (reason) { if (reason.code !== 'ENOENT') fail('SAVE_FAILED', 'The temporary owner record could not be removed.'); } }
  }
}
function stopped(pid) {
  try { process.kill(pid, 0); return false; }
  catch (reason) { return reason.code === 'ESRCH'; }
}

/** Read-only process evidence for status views. It never creates storage,
 * releases a claim, returns its token, or infers death from elapsed time. */
export function inspectAutomationOwner({ projectRoot } = {}) {
  if (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot) || path.resolve(projectRoot) !== projectRoot) fail('INPUT_INVALID', 'A canonical project root is required.');
  directory(projectRoot);
  const metadata = path.join(projectRoot, '.scienceprism'), root = path.join(metadata, 'automation-owner');
  const exists = target => {
    try { fs.lstatSync(target); return true; }
    catch (reason) { if (reason.code === 'ENOENT') return false; fail('STORAGE_INVALID', 'The protected owner directory could not be inspected.'); }
  };
  if (!exists(metadata)) return null; directory(metadata);
  if (!exists(root)) return null; directory(root, { privateMode: true });
  const active = path.join(root, 'active');
  if (!exists(active)) return null;
  directory(path.join(root, 'archive'), { privateMode: true });
  const owner = readOwner(active);
  let present;
  try { process.kill(owner.pid, 0); present = true; }
  catch (reason) { present = reason.code === 'ESRCH' ? false : null; }
  return { pid: owner.pid, sessionId: owner.sessionId, released: owner.released, present };
}

/** Cross-process ownership of one project's automatic research chain. Empty,
 * corrupt or uncertain claims remain reserved; elapsed time grants no lease. */
export function claimAutomationOwner({ projectRoot, sessionId } = {}) {
  if (!identity(sessionId) || typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot)
    || path.resolve(projectRoot) !== projectRoot) fail('INPUT_INVALID', 'A canonical project root and bounded session identity are required.');
  directory(projectRoot);
  const metadata = path.join(projectRoot, '.scienceprism'); directory(metadata, { create: true });
  const root = path.join(metadata, 'automation-owner'); directory(root, { create: true, privateMode: true });
  const archive = path.join(root, 'archive'); directory(archive, { create: true, privateMode: true });
  const active = path.join(root, 'active');
  try { fs.mkdirSync(active, { mode: 0o700 }); }
  catch (reason) {
    if (reason.code !== 'EEXIST') fail('STORAGE_INVALID', 'The active automation owner cannot be created.');
    const previous = readOwner(active);
    if (!previous.released && !stopped(previous.pid)) fail('BUSY', 'A live or uncertain process owns this project automation.');
    directory(archive, { privateMode: true }); directory(active, { privateMode: true });
    // A fixed, nonempty archive destination is a CAS barrier. A losing
    // reclaimer cannot rename a newly created active owner over the winner.
    const destination = path.join(archive, previous.token);
    if (fs.existsSync(destination)) fail('BUSY', 'This owner has already been reclaimed.');
    try { fs.renameSync(active, destination); }
    catch { fail('BUSY', 'Another process changed the owner during recovery.'); }
    directory(destination, { privateMode: true });
    try { fs.mkdirSync(active, { mode: 0o700 }); }
    catch { fail('BUSY', 'Another process claimed the project after recovery.'); }
  }
  const owner = { schemaVersion: 1, pid: process.pid, sessionId, token: randomUUID(), released: false };
  saveOwner(active, owner, { exclusive: true }); let released = false;
  const assertOwned = () => {
    if (released) fail('CLOSED', 'The automation lease has been released.');
    directory(metadata); directory(root, { privateMode: true }); directory(archive, { privateMode: true });
    const current = readOwner(active);
    if (current.token !== owner.token || current.sessionId !== sessionId || current.pid !== process.pid || current.released) fail('LOST', 'The automation session no longer owns this project.');
    return true;
  };
  return Object.freeze({ pid: process.pid, sessionId, assertOwned,
    release({ stopConfirmed } = {}) {
      assertOwned();
      if (stopConfirmed !== true) return false;
      saveOwner(active, { ...owner, released: true }); released = true; return true;
    }
  });
}
