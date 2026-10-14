import { randomUUID } from 'node:crypto';
import { assertApprovedConstraint } from '../constraintRegistry/proposals.js';
import { assertProjectPath } from './capabilities.js';
import { HarnessRuntimeError } from './errors.js';
import { fileVersion, readFileState, sameVersion } from './fileVersions.js';
import { clone, writeHarnessRuns } from './repository.js';
import { collabFileMatches } from '../collab/docStore.js';
import { rollbackFileTransaction, writeFileTransaction } from './fileTransactions.js';

export function selectPatchPaths(run, paths) {
  const available = new Set((run.patches || []).map((patch) => patch.path));
  if (paths !== undefined && (!Array.isArray(paths) || !paths.length
    || paths.some((item) => typeof item !== 'string' || !available.has(item)))) {
    throw new HarnessRuntimeError(400, 'INVALID_PATCH_PATHS', 'Select existing proposal paths.', { paths });
  }
  return new Set(paths === undefined ? available : paths);
}

function validVersion(version) {
  return version && (version.exists === false && version.sha256 === null
    || version.exists === true && /^[a-f0-9]{64}$/.test(version.sha256));
}

/** Caller holds the project Run lock through preflight, writes and journal commit. */
export async function applyPatchTransaction({ projectId, root, document, index, policy, actor, paths }) {
  const run = clone(document.runs[index]);
  const persist = async () => {
    run.updatedAt = new Date().toISOString();
    document.runs[index] = run;
    await writeHarnessRuns(root, document);
  };
  // The journal precedes every write, so a process restart can safely roll back
  // an interrupted transaction. Files edited since the interruption are kept.
  if (['applying', 'recovery_required'].includes(run.patchApplication?.status)) {
    const conflicts = await rollbackFileTransaction(root, run.patchApplication, projectId);
    await persist();
    if (conflicts.length) {
      throw new HarnessRuntimeError(409, 'PATCH_RECOVERY_REQUIRED', 'An interrupted application needs recovery; newer content was preserved.', { runId: run.id, conflicts });
    }
  }
  const requested = selectPatchPaths(run, paths);
  if (!requested.size) throw new HarnessRuntimeError(409, 'NO_PATCHES_TO_APPLY', 'This Run has no proposals.');
  const alreadyApplied = new Set(run.appliedPatches || []);
  const repeated = [...requested].filter((name) => alreadyApplied.has(name));
  const planned = (run.patches || []).filter((patch) => requested.has(patch.path) && !alreadyApplied.has(patch.path));
  if (!planned.length) return { run, applied: [], alreadyApplied: repeated };
  const unaccepted = planned.filter((patch) => (run.patchDecisions?.[patch.path]?.status || run.humanDecision?.status) !== 'accepted');
  if (unaccepted.length) {
    throw new HarnessRuntimeError(409, 'PATCH_APPLICATION_REQUIRES_ACCEPTANCE', 'A human must accept each selected proposal before applying it.', { paths: unaccepted.map((patch) => patch.path) });
  }

  const entries = [];
  const conflicts = [];
  for (const patch of planned) {
    const relativePath = assertProjectPath(patch.path, policy, { operation: 'patch' });
    await assertApprovedConstraint(projectId, { kind: 'patch.forbid_path', path: relativePath });
    if (!patch.deleted) await assertApprovedConstraint(projectId, { kind: 'patch.forbid_text', content: String(patch.content ?? '') });
    const before = await readFileState(root, relativePath);
    const packed = run.contextManifest?.files?.find((file) => file.path === relativePath);
    const baseVersion = patch.baseVersion || (packed ? { exists: true, sha256: packed.sha256 } : null);
    if (!validVersion(baseVersion) || !sameVersion(before, baseVersion)) {
      conflicts.push({ path: relativePath, reason: validVersion(baseVersion) ? 'file_changed' : 'missing_baseline', expected: baseVersion, actual: { exists: before.exists, sha256: before.sha256 } });
    } else if (!collabFileMatches(`${projectId}:${relativePath}`, before, { deleted: patch.deleted })) {
      conflicts.push({ path: relativePath, reason: patch.deleted ? 'collaborative_document_open' : 'unsaved_collaborative_changes' });
    }
    const content = String(patch.content ?? '');
    entries.push({ path: relativePath, before, after: { ...fileVersion(patch.deleted ? null : content), content } });
  }
  if (conflicts.length) {
    throw new HarnessRuntimeError(409, 'PATCH_VERSION_CONFLICT', 'Proposal versions no longer match the saved files. No files were written.', { runId: run.id, conflicts });
  }

  const transaction = { id: randomUUID(), status: 'applying', actor: String(actor), startedAt: new Date().toISOString(), paths: entries.map((entry) => entry.path), entries };
  run.patchApplication = transaction;
  await persist();
  try {
    await writeFileTransaction({ root, projectId, entries });
    run.appliedPatches = [...alreadyApplied, ...transaction.paths];
    run.patchApplication = { ...transaction, status: 'applied', appliedAt: new Date().toISOString() };
    // The success record is sufficient after the atomic Run storage commit.
    delete run.patchApplication.entries;
    run.events = [...(run.events || []), { type: 'patches.applied', at: run.patchApplication.appliedAt, details: { paths: transaction.paths, actor: String(actor), applicationId: transaction.id } }];
    await persist();
    return { run: clone(run), applied: transaction.paths, alreadyApplied: repeated };
  } catch (error) {
    run.appliedPatches = [...alreadyApplied];
    run.events = (run.events || []).filter((event) => event.details?.applicationId !== transaction.id);
    run.patchApplication = transaction;
    const recoveryConflicts = await rollbackFileTransaction(root, transaction, projectId);
    transaction.error = { code: error.code || 'WRITE_FAILED', message: error.message };
    // Keep original contents in the journal when automatic recovery cannot finish.
    if (!recoveryConflicts.length) delete transaction.entries;
    try { await persist(); } catch { /* The pre-write journal still supports recovery after restart. */ }
    throw new HarnessRuntimeError(recoveryConflicts.length ? 409 : 500,
      recoveryConflicts.length ? 'PATCH_RECOVERY_REQUIRED' : 'PATCH_APPLICATION_FAILED',
      recoveryConflicts.length ? 'Application failed; newer content was preserved and recovery is required.' : 'Application failed; original file contents were restored.',
      { runId: run.id, recoveryStatus: transaction.status, conflicts: recoveryConflicts, cause: transaction.error });
  }
}
