import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRetainedWorkspace } from './retainedWorkspace.js';
import { createCurrentToolPolicy } from './currentToolPolicy.js';
import { resolveHarnessProjectRoot } from './repository.js';
import { CODEX_PROTOCOL_VERSION } from './adapters/codexAdapter.js';
import { CODEX_WORKER_TOOLS } from './adapters/codexWorker.js';
import { createCodexToolReceipts } from './codexToolReceipts.js';
import { createDshFileBroker, DSH_FILE_TOOLS } from './dshFileBroker.js';
import { collectPatches } from './workspace.js';
import { isPathAllowed, isSensitivePath } from './capabilities.js';
import { HarnessRuntimeError } from './errors.js';
import { appendRuntimeEvents, summarizeEvent } from './runtimeEvents.js';

const FORMAT = 'scienceprism-recovery-v1';
const MAX_BYTES = 1_048_576;
const digest = value => createHash('sha256').update(value).digest('hex');
const allowedStatus = value => ['paused', 'failed', 'cancelled'].includes(value);
const fail = (code, message) => { throw new HarnessRuntimeError(409, `HARNESS_RECOVERY_${code}`, message); };
const relative = value => typeof value === 'string' && value.length > 0 && value.length <= 1024
  && !/[\\\x00-\x1f\x7f]/.test(value) && !path.posix.isAbsolute(value) && !/^[A-Za-z]:/.test(value)
  && !value.split('/').some(part => !part || ['.', '..'].includes(part));
function directory(root) {
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(root) !== root) fail('STORAGE_INVALID', 'The retained directory changed.');
}
function text(root, file, allowBinary = false) {
  if (!relative(file)) fail('STORAGE_INVALID', 'The retained file path is invalid.');
  let current = root;
  for (const [index, part] of file.split('/').entries()) {
    current = path.join(current, part); const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || (index < file.split('/').length - 1 ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) fail('STORAGE_INVALID', 'Only retained regular files can provide recovery evidence.');
  }
  const fd = fs.openSync(current, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) fail('STORAGE_INVALID', 'Only retained regular files can provide recovery evidence.');
    if (stat.size > MAX_BYTES) { if (allowBinary) return null; fail('BASELINE_UNSUPPORTED', 'Recovery requires bounded text baseline evidence.'); }
    const buffer = Buffer.alloc(MAX_BYTES + 1); let length = 0;
    while (length < buffer.length) { const bytes = fs.readSync(fd, buffer, length, buffer.length - length, length); if (!bytes) break; length += bytes; }
    if (length > MAX_BYTES || buffer.subarray(0, length).includes(0)) { if (allowBinary) return null; fail('BASELINE_UNSUPPORTED', 'Recovery requires bounded text baseline evidence.'); }
    return buffer.subarray(0, length).toString('utf8');
  } finally { fs.closeSync(fd); }
}
function snapshot(root, policy) {
  directory(root); const result = new Map(); let entries = 0, bytes = 0;
  function walk(base = '', depth = 0) {
    if (depth > 16) fail('CAPACITY', 'The retained file tree exceeds the recovery limit.');
    for (const item of fs.readdirSync(path.join(root, base), { withFileTypes: true })) {
      const file = base ? `${base}/${item.name}` : item.name;
      if (['project.json', '.compile'].includes(item.name) || isSensitivePath(file)
        || ['.agents/skills', '.dsh/skills'].some(prefix => file === prefix || file.startsWith(`${prefix}/`))) continue;
      if (++entries > 8192) fail('CAPACITY', 'The retained file tree exceeds the recovery limit.');
      if (item.isSymbolicLink()) fail('STORAGE_INVALID', 'Linked files cannot provide recovery evidence.');
      if (item.isDirectory()) walk(file, depth + 1);
      else if (item.isFile() && isPathAllowed(file, policy, { operation: 'read' })) {
        const value = text(root, file, true); bytes += value === null ? 0 : Buffer.byteLength(value);
        if (result.size >= 4096 || bytes > 32 * MAX_BYTES) fail('CAPACITY', 'The retained baseline exceeds the recovery limit.');
        result.set(file, value);
      }
    }
  }
  walk(); return result;
}
function manifest(snapshotValue) {
  return [...snapshotValue].map(([file, value]) => ({ path: file, sha256: value === null ? null : digest(value), bytes: value === null ? 0 : Buffer.byteLength(value) })).sort((a, b) => a.path.localeCompare(b.path));
}
function verifyManifest(actual, expected) {
  if (!Array.isArray(expected) || expected.some(value => !relative(value.path) || value.sha256 !== null && !/^[a-f0-9]{64}$/.test(value.sha256 || '')
    || !Number.isSafeInteger(value.bytes) || value.bytes < 0 || value.bytes > MAX_BYTES || value.sha256 === null && value.bytes !== 0)
    || new Set(expected.map(value => value.path)).size !== expected.length) fail('BASELINE_UNSUPPORTED', 'A fixed text baseline manifest is required.');
  if (JSON.stringify(manifest(actual)) !== JSON.stringify([...expected].sort((a, b) => a.path.localeCompare(b.path)))) fail('BASELINE_CONFLICT', 'The retained baseline or original project changed.');
}

export async function loadRetainedRecoveryInputs({ retained, run, projectRoot, capabilities = run.capabilities }) {
  const state = await retained.read();
  const baseline = snapshot(path.join(retained.root, 'baseline'), capabilities);
  verifyManifest(baseline, state.baseFiles); verifyManifest(snapshot(projectRoot, capabilities), state.baseFiles);
  const documents = run.skillVersions?.documents || [];
  const fixedSkills = documents.map(document => ({ path: document.projectionPath, sha256: document.sha256, bytes: document.bytes }));
  if (JSON.stringify(fixedSkills) !== JSON.stringify(state.skills)) fail('SKILL_CONFLICT', 'The fixed Skill manifest changed.');
  for (const document of documents) {
    const content = text(retained.workspace, document.projectionPath);
    if (digest(content) !== document.sha256 || Buffer.byteLength(content) !== document.bytes) fail('SKILL_CONFLICT', 'The fixed Skill projection changed.');
  }
  return { snapshot: baseline, skillProjection: { ...run.skillVersions, documents, excludedPaths: documents.map(document => document.projectionPath) } };
}

/** Reconcile stopped delegated workers into their existing parent copy. This
 * owns no scheduler, does not apply the original project, and never resumes or
 * starts a model turn. The parent remains paused for an explicit next action. */
export function createRunRecovery({ getRun, updateRun, readProjectConstraints, worker, resolveProjectRoot = resolveHarnessProjectRoot }) {
  return async function recover(projectId, runId, { provider, signal = new AbortController().signal } = {}) {
    const original = await getRun(projectId, runId);
    if (original.adapter !== 'deepseek' || original.kind === 'codex-worker' || !allowedStatus(original.status)
      || original.projectId !== projectId || original.id !== runId || original.retainedWorkspace?.format !== 'scienceprism-harness-retention-v1'
      || original.retainedWorkspace.attempt !== original.attempt) fail('NOT_AVAILABLE', 'This stopped parent Run has no recoverable owned workspace.');
    signal.throwIfAborted();
    const projectRoot = await resolveProjectRoot(projectId);
    const owner = await createRetainedWorkspace({ projectRoot, runId, attempt: original.retainedWorkspace.attempt, recover: true,
      expectedVersions: { runtime: 'scienceprism-harness-retention-v1', codex: CODEX_PROTOCOL_VERSION, toolsHash: digest(JSON.stringify(CODEX_WORKER_TOOLS)) } });
    let failure; let broker;
    const assertOwnership = async () => { signal.throwIfAborted(); return owner.read(); };
    const readParentPolicy = createCurrentToolPolicy({ initialRun: { ...original, status: 'running' }, signal,
      getRun: async () => {
        await assertOwnership(); const current = await getRun(projectId, runId);
        if (!allowedStatus(current.status) || current.attempt !== original.attempt || current.projectId !== projectId || current.id !== runId) fail('OWNER_CONFLICT', 'The parent Run changed while recovery held its owner.');
        return { ...current, status: 'running' };
      }, readConstraints: () => readProjectConstraints(projectRoot) });
    try {
      const state = await assertOwnership();
      if (!state.runtimeProcess || state.runtimeProcess.pid === null && state.runtimeProcess.stopConfirmed !== true) fail('PARENT_STOP_UNCONFIRMED', 'The saved DSH process has no confirmed stopping evidence.');
      if (state.runtimeProcess.pid !== null) {
        let stopped = false; try { process.kill(state.runtimeProcess.pid, 0); } catch (error) { stopped = error.code === 'ESRCH'; }
        if (!stopped) fail('PARENT_STOP_UNCONFIRMED', 'The saved DSH process is still present.');
        if (!state.runtimeProcess.stopConfirmed) await owner.update({ runtimeProcess: { ...state.runtimeProcess, stopConfirmed: true } });
      }
      await owner.update({ status: 'running', stopConfirmed: false });
      const parentPolicy = await readParentPolicy();
      if (!parentPolicy.active || !parentPolicy.capabilities.granted.includes('project.read') || !parentPolicy.capabilities.granted.includes('patch.propose')) fail('POLICY_DENIED', 'The current parent policy does not permit recovery.');
      const { snapshot: parentBaseline, skillProjection } = await loadRetainedRecoveryInputs({ retained: owner, run: original, projectRoot });
      const documents = skillProjection.documents;
      const ready = original.recovery?.format === FORMAT && original.recovery.status === 'ready' && original.recovery.workspaceAttempt === original.attempt;
      if (ready) {
        if (!Array.isArray(original.recovery.children) || original.recovery.children.length !== state.children.length
          || state.children.some(entry => !original.recovery.children.some(child => child.runId === entry.runId && child.threadId === entry.threadId && child.turnId === entry.turnId))) fail('RESULT_CONFLICT', 'The completed recovery child set changed.');
        snapshot(owner.workspace, original.capabilities);
        const currentPatches = await collectPatches(parentBaseline, owner.workspace, original.capabilities, documents.map(document => document.projectionPath));
        const fingerprint = patches => JSON.stringify(patches.map(patch => ({ path: patch.path, content: patch.content, deleted: patch.deleted === true, baseVersion: patch.baseVersion })).sort((a, b) => a.path.localeCompare(b.path)));
        if (fingerprint(currentPatches) !== fingerprint(original.patches || [])) fail('RESULT_CONFLICT', 'The recovered parent copy no longer matches its saved proposals.');
      }
      const children = [];
      const handoffs = [];
      broker = await createDshFileBroker({ workspace: owner.workspace, readPolicy: readParentPolicy, signal, skillProjection,
        onDecision: event => updateRun(projectId, runId, current => { appendRuntimeEvents(current, [summarizeEvent(event)]); return current; }) });
      for (const checkpoint of state.children) {
        await assertOwnership(); const child = await getRun(projectId, checkpoint.runId);
        let storage = child.workerStorage;
        if (child.kind !== 'codex-worker' || child.adapter !== 'codex' || child.projectId !== projectId || child.parentRunId !== runId
          || child.parentAttempt !== original.attempt || child.recovery?.format !== 'scienceprism-codex-delegation-v1'
          || child.recovery.root !== checkpoint.workerRoot || !relative(checkpoint.workerRoot)
          || storage?.format !== 'scienceprism-codex-worker-v1' || storage.protocolVersion !== CODEX_PROTOCOL_VERSION
          || storage.implementationHash !== worker.implementationHash || !/^codex-worker-[a-zA-Z0-9-]+$/.test(storage.root || '')
          || storage.threadId !== checkpoint.threadId || storage.turnId !== checkpoint.turnId || !storage.threadId || !storage.turnId
          || checkpoint.pid !== storage.pid || storage.pid === null && (storage.stopConfirmed !== true || checkpoint.stopConfirmed !== true)
          || !['prepared', 'running', 'stopped', 'stop-unconfirmed'].includes(storage.phase)) fail('WORKER_CONFLICT', 'The saved child worker identity or stopping evidence changed.');
        if (storage.pid !== null) {
          let dead = false; try { process.kill(storage.pid, 0); } catch (error) { dead = error.code === 'ESRCH'; }
          if (!dead) fail('WORKER_ACTIVE', 'The saved worker process has not been confirmed stopped.');
        }
        if (!storage.stopConfirmed || !checkpoint.stopConfirmed || storage.phase !== 'stopped') {
          storage = { ...storage, phase: 'stopped', stopConfirmed: true };
          await updateRun(projectId, child.id, current => { current.workerStorage = storage; return current; });
          const latest = await owner.read();
          await owner.update({ children: latest.children.map(entry => entry.runId === child.id ? { ...entry, status: 'ambiguous', stopConfirmed: true } : entry) });
        }
        const childRoot = path.join(owner.root, checkpoint.workerRoot), workspace = path.join(childRoot, 'workspace');
        const childBaseline = snapshot(path.join(childRoot, 'baseline'), child.capabilities);
        verifyManifest(childBaseline, child.recovery.baseFiles);
        for (const document of documents) {
          const content = text(workspace, document.projectionPath);
          if (digest(content) !== document.sha256 || Buffer.byteLength(content) !== document.bytes) fail('SKILL_CONFLICT', 'The child Skill projection changed.');
        }
        const readChildPolicy = async () => {
          const parent = await readParentPolicy(); const stored = await getRun(projectId, child.id);
          if (stored.parentRunId !== runId || stored.parentAttempt !== original.attempt || stored.role !== child.role || stored.task !== child.task
            || JSON.stringify(stored.capabilities.allowedPaths || []) !== JSON.stringify(child.capabilities.allowedPaths || [])
            || JSON.stringify(stored.capabilities.allowedPaths || []) !== JSON.stringify(parent.capabilities.allowedPaths || [])) fail('POLICY_DENIED', 'The child Run binding or file scope changed.');
          const capabilities = { ...parent.capabilities, granted: parent.capabilities.granted.filter(capability => child.capabilities.granted.includes(capability) && stored.capabilities.granted.includes(capability)) };
          return { ...parent, runId: child.id, role: stored.role || 'unassigned', task: stored.task, capabilities };
        };
        const policy = await readChildPolicy();
        if (!storage.binding || ['projectId', 'runId', 'role', 'task'].some(key => policy[key] !== storage.binding[key])
          || storage.binding.parentRunId !== runId || policy.version !== storage.binding.policyVersion
          || digest(JSON.stringify(CODEX_WORKER_TOOLS.filter(tool => policy.capabilities.granted.includes(DSH_FILE_TOOLS[tool.name])))) !== storage.toolsHash) fail('POLICY_DENIED', 'The current policy or tool schema differs from the saved worker.');
        directory(path.join(childRoot, 'controls', storage.root));
        directory(path.join(childRoot, 'controls', storage.root, 'receipts'));
        const receipts = await createCodexToolReceipts({ directory: path.join(childRoot, 'controls', storage.root, 'receipts'), workspace, readPolicy: readChildPolicy, skillProjection,
          binding: { projectId, parentRunId: runId, workerRunId: child.id, threadId: storage.threadId, turnId: storage.turnId,
            workerVersion: `${CODEX_PROTOCOL_VERSION}:${worker.implementationHash}`, toolSchemaHash: storage.toolsHash,
            policyVersion: policy.version, role: policy.role, task: policy.task } });
        // Opening an absent receipt store would look like an empty history;
        // require the real directory, while an empty existing store is valid.
        await receipts.assertSettled({ signal });
        let result = child.workerResult;
        if (!result) {
          result = await worker.readResult({ provider, runtimeHome: path.join(childRoot, 'controls'), storage, readPolicy: readChildPolicy, assertOwnership, signal,
            maxTokens: child.limits.maxTokens, onStorage: async value => {
              await assertOwnership(); await updateRun(projectId, child.id, current => { current.workerStorage = value; return current; });
              const latest = await owner.read();
              await owner.update({ children: latest.children.map(entry => entry.runId === child.id ? { ...entry, pid: value.pid,
                stopConfirmed: value.stopConfirmed === true, status: value.stopConfirmed ? 'completed' : value.phase === 'stop-unconfirmed' ? 'ambiguous' : 'running' } : entry) });
            } });
          await updateRun(projectId, child.id, current => { current.workerResult = result; return current; });
        }
        if (result?.ok !== true || result.sessionId !== storage.threadId || result.output?.codex?.threadId !== storage.threadId
          || result.output?.codex?.turnId !== storage.turnId || typeof result.finalResponse !== 'string' || Buffer.byteLength(result.finalResponse) > MAX_BYTES
          || typeof child.request?.prompt !== 'string' || !child.request.prompt.trim() || Buffer.byteLength(child.request.prompt) > 262144) fail('RESULT_CONFLICT', 'The saved worker result does not belong to this completed turn.');
        const reportedUsage = summarizeEvent({ data: { usage: result.usage || child.tokenUsage } }).usage;
        const usage = reportedUsage && Object.keys(reportedUsage).length ? reportedUsage : { totalTokens: child.limits.maxTokens, estimated: true };
        const tokens = Number(usage.totalTokens ?? usage.total_tokens ?? usage.total
          ?? ((usage.inputTokens ?? usage.input ?? usage.promptTokens ?? usage.prompt_tokens ?? 0) + (usage.outputTokens ?? usage.output ?? usage.completionTokens ?? usage.completion_tokens ?? 0)));
        if (!Number.isFinite(tokens) || tokens > child.limits.maxTokens) fail('BUDGET_EXHAUSTED', 'The saved worker exhausted its allocated budget.');
        const patches = await collectPatches(childBaseline, workspace, child.capabilities);
        snapshot(workspace, child.capabilities); // reject links/binary/oversized evidence before merging
        const handoff = await createCodexToolReceipts({ directory: path.join(childRoot, 'handoff-receipts'), workspace: owner.workspace, readPolicy: readParentPolicy,
          binding: { projectId, parentRunId: runId, workerRunId: runId, threadId: storage.threadId, turnId: storage.turnId,
            workerVersion: 'scienceprism-codex-handoff-v1', toolSchemaHash: digest('project_propose_patch-v1'), policyVersion: parentPolicy.version,
            role: original.role || 'unassigned', task: original.task } });
        const metadata = await handoff.readCompletedMetadata({ signal });
        const expected = new Map();
        for (const patch of patches) {
          if (patch.deleted) fail('PATCH_UNSUPPORTED', 'A recovered worker cannot delete project files.');
          const call = { threadId: storage.threadId, turnId: storage.turnId, tool: 'project_propose_patch', callId: `handoff:${child.id}:${digest(patch.path)}`,
            arguments: { path: patch.path, content: patch.content, expectedSha256: patch.baseVersion.sha256 } };
          expected.set(call.callId, { call, patch });
        }
        for (const receipt of metadata) {
          const operation = expected.get(receipt.callId);
          if (!operation || receipt.tool !== 'project_propose_patch' || receipt.path !== operation.patch.path
            || receipt.beforeSha256 !== operation.patch.baseVersion.sha256 || receipt.afterSha256 !== digest(operation.patch.content)
            || receipt.requestHash !== digest(JSON.stringify({ tool: operation.call.tool, arguments: operation.call.arguments }))
            || receipt.result.kind !== 'proposal' || receipt.result.byteLength !== Buffer.byteLength(operation.patch.content)) fail('HANDOFF_CONFLICT', 'The completed handoff receipt does not match its fixed child proposal.');
        }
        if ((ready || child.recovery.phase === 'handed-off') && metadata.length !== expected.size) fail('HANDOFF_CONFLICT', 'The completed handoff is missing its original receipts.');
        handoffs.push({ child, handoff, metadata, expected, result, patches, usage });
        children.push({ runId: child.id, task: child.request.prompt, reply: result.finalResponse, threadId: storage.threadId, turnId: storage.turnId,
          patches: patches.map(patch => ({ path: patch.path, baseVersion: patch.baseVersion })),
          usage });
      }
      // Different children may legitimately replace the same parent file. A
      // historical receipt is proven by its fixed child baseline/output and
      // the complete ordered hash chain, not by rechecking an obsolete endpoint
      // against the current parent file or redispatching that old proposal.
      const chains = new Map();
      for (const entry of handoffs) {
        const completed = new Set(entry.metadata.map(receipt => receipt.callId));
        for (const operation of entry.expected.values()) {
          const chain = chains.get(operation.patch.path) || [];
          if (chain.length && chain.at(-1).after !== operation.patch.baseVersion.sha256) fail('HANDOFF_CONFLICT', 'The child handoff file hashes do not form a continuous chain.');
          if (completed.has(operation.call.callId) && chain.some(previous => !previous.completed)) fail('HANDOFF_CONFLICT', 'A later completed handoff is missing an earlier receipt.');
          chain.push({ entry, operation, completed: completed.has(operation.call.callId), before: operation.patch.baseVersion.sha256, after: digest(operation.patch.content) });
          chains.set(operation.patch.path, chain);
        }
      }
      for (const [file, chain] of chains) {
        const completed = chain.filter(operation => operation.completed);
        const endpoint = completed.length ? completed.at(-1).after : chain[0].before;
        let content = null;
        try { content = text(owner.workspace, file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if ((content === null ? null : digest(content)) !== endpoint) fail('HANDOFF_CONFLICT', 'The current parent file does not match the proven handoff chain endpoint.');
      }
      for (const entry of handoffs) {
        const completed = new Set(entry.metadata.map(receipt => receipt.callId));
        for (const operation of entry.expected.values()) {
          if (completed.has(operation.call.callId)) continue;
          await assertOwnership();
          await entry.handoff.execute(operation.call, { signal, executeTool: call => broker.execute({ tool: call.tool, callId: call.callId, arguments: call.arguments }) });
        }
        await updateRun(projectId, entry.child.id, current => { current.status = 'completed'; current.reply = entry.result.finalResponse; current.patches = entry.patches;
          current.recovery = { ...current.recovery, phase: 'handed-off', workerCompleted: true }; current.tokenUsage = entry.usage;
          current.updatedAt = new Date().toISOString(); return current; });
      }
      await assertOwnership(); verifyManifest(snapshot(projectRoot, original.capabilities), state.baseFiles);
      if ((await readParentPolicy()).version !== parentPolicy.version) fail('POLICY_DENIED', 'The parent policy changed before recovery was saved.');
      snapshot(owner.workspace, original.capabilities);
      const patches = await collectPatches(parentBaseline, owner.workspace, original.capabilities, documents.map(document => document.projectionPath));
      return await updateRun(projectId, runId, current => {
        signal.throwIfAborted(); current.status = 'paused'; current.patches = patches;
        current.humanDecision = { status: patches.length ? 'pending' : 'none' };
        current.recovery = { format: FORMAT, status: 'ready', workspaceAttempt: original.attempt, children };
        current.updatedAt = new Date().toISOString(); return current;
      });
    } catch (error) { failure = error; throw error; }
    finally {
      let cleanupError;
      try { if (broker) await broker.close(); } catch (error) { cleanupError = error; }
      const stopError = [failure, cleanupError].find(error => ['CODEX_STOP_FAILED', 'HARNESS_STOP_UNCONFIRMED'].includes(error?.code));
      try { await owner.release({ status: failure || cleanupError ? 'ambiguous' : 'completed', stopConfirmed: !stopError }); }
      catch (error) { cleanupError ||= error; }
      if (stopError && stopError !== failure) throw stopError;
      if (!failure && cleanupError) throw cleanupError;
    }
  };
}
