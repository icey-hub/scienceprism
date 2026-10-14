import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { safeJoin } from '../../utils/pathUtils.js';
import { HarnessRuntimeError } from './errors.js';
import { readFileState, sameVersion } from './fileVersions.js';
import { collabFileMatches, syncCollabFile } from '../collab/docStore.js';

/** Replace one file atomically; a failed write never leaves a truncated draft. */
export async function writeTransactionFile(root, relativePath, state) {
  const target = safeJoin(root, relativePath);
  if (!state.exists) {
    await fs.rm(target, { force: true });
    return;
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporaryPath = `${relativePath}.${randomUUID()}.patch-tmp`;
  const temporary = safeJoin(root, temporaryPath);
  try {
    const mode = await fs.stat(target).then((stat) => stat.mode, (error) => {
      if (error.code !== 'ENOENT') throw error;
      return undefined;
    });
    await fs.writeFile(temporary, state.content, { encoding: 'utf8', flag: 'wx', mode });
    // Recheck the target after asynchronous operations, including symlink checks.
    await fs.rename(safeJoin(root, temporaryPath), safeJoin(root, relativePath));
  } finally {
    await fs.rm(safeJoin(root, temporaryPath), { force: true }).catch(() => {});
  }
}

export async function rollbackFileTransaction(root, transaction, projectId, readState = readFileState) {
  const conflicts = [];
  for (const entry of [...transaction.entries].reverse()) {
    try {
      const current = await readState(root, entry.path);
      if (sameVersion(current, entry.before)) continue;
      const collabMatchesBefore = collabFileMatches(`${projectId}:${entry.path}`, entry.before);
      const collabMatchesAfter = collabFileMatches(`${projectId}:${entry.path}`, entry.after);
      if (!sameVersion(current, entry.after) || (!collabMatchesBefore && !collabMatchesAfter)) {
        conflicts.push({ path: entry.path, reason: 'changed_since_application' });
        continue;
      }
      await writeTransactionFile(root, entry.path, entry.before);
      if (collabMatchesAfter) syncCollabFile(`${projectId}:${entry.path}`, entry.before.exists ? entry.before.content : '');
    } catch (error) {
      conflicts.push({ path: entry.path, reason: error.code || error.message });
    }
  }
  transaction.status = conflicts.length ? 'recovery_required' : 'rolled_back';
  transaction.recoveryConflicts = conflicts;
  transaction.recoveredAt = new Date().toISOString();
  return conflicts;
}

/** Caller persists its own pre-write journal and holds the existing file lock. */
export async function writeFileTransaction({root, projectId, entries, readState = readFileState, beforeWrite = async () => {}, beforePublish = async () => {}}) {
    for (const entry of entries) {
      const current = await readState(root, entry.path);
      if (!sameVersion(current, entry.before)) {
        throw new HarnessRuntimeError(409, 'PATCH_VERSION_CONFLICT', 'A file changed during application.', { conflicts: [{ path: entry.path }] });
      }
      await beforeWrite(entry);
      await writeTransactionFile(root, entry.path, entry.after);
    }
    await beforePublish();
    // WebSocket updates can arrive while disk writes await. Recheck the live
    // documents together, then synchronously publish changes before yielding.
    const changedDocuments = entries.filter((entry) => !collabFileMatches(`${projectId}:${entry.path}`, entry.before, { deleted: !entry.after.exists }));
    if (changedDocuments.length) {
      throw new HarnessRuntimeError(409, 'PATCH_VERSION_CONFLICT', 'A collaborative document changed during application.', { paths: changedDocuments.map((entry) => entry.path) });
    }
    for (const entry of entries) syncCollabFile(`${projectId}:${entry.path}`, entry.after.exists ? entry.after.content : '');
}
