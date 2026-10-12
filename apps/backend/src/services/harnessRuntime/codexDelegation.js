import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { HarnessRuntimeError, asRuntimeError } from './errors.js';
import { collectPatches, copyWorkspace, snapshotWorkspace } from './workspace.js';
import { createDshFileBroker } from './dshFileBroker.js';
import { appendRuntimeEvents, summarizeEvent, sumEventUsage } from './runtimeEvents.js';
import { safeJoin } from '../../utils/pathUtils.js';

const now = () => new Date().toISOString();
const fail = (code, message) => new HarnessRuntimeError(409, code, message);
export const usageTotal = usage => Number(usage?.totalTokens ?? usage?.total_tokens ?? usage?.total
  ?? ((usage?.inputTokens ?? usage?.input ?? 0) + (usage?.outputTokens ?? usage?.output ?? 0)));

// An internal tool callback, not another scheduler or public runtime selector.
// The parent's model slot remains held while DSH awaits this worker.
export function createCodexDelegation({ parent, workspace, runtimeHome, skillProjection, provider, worker,
  readPolicy, getRun, updateRun, runChild, signal, emit, flushEvents = async () => {} }) {
  const deadline = Date.now() + parent.limits.timeoutMs;
  const calls = new Map();
  let pending = Promise.resolve();
  let childTokens = 0;
  let closed = false;
  let preserveWorkspace = false;
  const persist = (id, event) => updateRun(id, run => { appendRuntimeEvents(run, [summarizeEvent(event)]); return run; });

  async function execute(input, options) {
    if (closed || signal.aborted || options.signal?.aborted) throw fail('HARNESS_CANCELLED', 'The parent task is no longer active.');
    if (!input || Object.keys(input).some(key => !['task', 'maxTokens', 'timeoutMs'].includes(key))
      || typeof input.task !== 'string' || !input.task.trim() || Buffer.byteLength(input.task) > 262144
      || input.maxTokens !== undefined && (!Number.isSafeInteger(input.maxTokens) || input.maxTokens < 128 || input.maxTokens > 100000)
      || input.timeoutMs !== undefined && (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 100 || input.timeoutMs > 600000)) {
      throw fail('CODEX_WORKER_INPUT_INVALID', 'Provide a bounded task and optional token/time limits.');
    }
    await flushEvents();
    const current = await getRun(parent.id);
    const policy = await readPolicy();
    if (!policy.active || current.attempt !== parent.attempt || !policy.capabilities.granted.includes('patch.propose')) {
      throw fail('DELEGATION_CAPABILITY_DENIED', 'This parent no longer permits a coding worker.');
    }
    const remaining = parent.limits.maxTokens - usageTotal(sumEventUsage(current.events)) - childTokens;
    const limits = { maxTokens: Math.min(remaining, input.maxTokens ?? remaining, 100000),
      timeoutMs: Math.min(deadline - Date.now(), input.timeoutMs ?? 600000, 600000), maxConcurrent: 1, retryLimit: 0 };
    if (limits.maxTokens < 128 || limits.timeoutMs < 100) throw fail('HARNESS_BUDGET_EXHAUSTED', 'The parent has no remaining worker budget.');
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal, ...(options.signal ? [options.signal] : [])]);
    const granted = policy.capabilities.granted.filter(cap => ['project.read', 'patch.propose'].includes(cap));
    const child = { schemaVersion: 1, id: randomUUID(), projectId: parent.projectId, kind: 'codex-worker', adapter: 'codex',
      status: 'running', stage: parent.stage, task: 'coding-worker', role: parent.role, roleAuthority: parent.roleAuthority,
      parentRunId: parent.id, parentAttempt: parent.attempt, delegationTask: 'coding-worker', delegationDepth: 1,
      delegationCallId: options.callId, attempt: 1, createdAt: now(), startedAt: now(), updatedAt: now(), finishedAt: null,
      model: provider.model, capabilities: { ...parent.capabilities, ...policy.capabilities, granted, denied: [] }, limits,
      skills: parent.skills, skillVersions: parent.skillVersions, request: { task: 'coding-worker', prompt: input.task, source: parent.request?.source },
      patches: [], events: [], humanDecision: { status: 'none' }, output: null, error: null, fallback: false };
    return runChild(child, controller, async () => {
      let root;
      let merger;
      let eventWrite = Promise.resolve();
      let result;
      let usage;
      const mergedPaths = [];
      const readChildPolicy = async () => {
        const latest = await readPolicy();
        const stored = await getRun(child.id);
        return { ...latest, runId: child.id, role: child.role || 'unassigned', task: child.task,
          active: latest.active && ['projectId', 'runId', 'role', 'task'].every(key => latest[key] === policy[key]) && stored.status === 'running' && !combined.aborted,
          capabilities: { ...latest.capabilities, granted: latest.capabilities.granted.filter(cap => granted.includes(cap) && stored.capabilities.granted.includes(cap)) } };
      };
      const childEmit = event => { eventWrite = eventWrite.then(() => persist(child.id, event)); };
      try {
        root = await fs.mkdtemp(path.join(runtimeHome, 'delegated-'));
        const childWorkspace = path.join(root, 'workspace');
        await copyWorkspace(workspace, childWorkspace, child.capabilities);
        const snapshot = await snapshotWorkspace(childWorkspace, child.capabilities);
        // Copy the already fixed parent Skill view, never re-resolve latest installs.
        for (const document of skillProjection?.documents || []) {
          const relative = document.projectionPath;
          if (!relative?.startsWith('.dsh/skills/') || relative.split('/').some(part => ['..', '.'].includes(part))) throw fail('SKILL_PROJECTION_INVALID', 'The Skill projection path is invalid.');
          const source = safeJoin(workspace, relative);
          const stat = await fs.lstat(source);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== document.bytes) throw fail('SKILL_VERSION_CONFLICT', 'The parent Skill file changed.');
          const content = await fs.readFile(safeJoin(workspace, relative));
          if (content.length !== document.bytes || createHash('sha256').update(content).digest('hex') !== document.sha256) throw fail('SKILL_VERSION_CONFLICT', 'The parent Skill view changed.');
          const target = path.join(childWorkspace, relative);
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.writeFile(target, content, { mode: 0o400, flag: 'wx' });
        }
        emit({ type: 'runtime/delegation', data: { childRunId: child.id, parentRunId: parent.id, phase: 'started', runtime: 'codex' } });
        result = await worker.run({ provider, task: input.task, workspace: childWorkspace, runtimeHome: path.join(root, 'controls'),
          skillProjection, readPolicy: readChildPolicy, onDecision: event => persist(child.id, event), signal: combined,
          timeoutMs: limits.timeoutMs, maxTokens: limits.maxTokens, emit: childEmit,
          onSession: identity => updateRun(child.id, stored => { stored.sessionId = identity.threadId; stored.output = { codex: identity }; return stored; }) });
        usage = result.usage;
        await eventWrite;
        combined.throwIfAborted();
        if (result.ok === false) throw fail('CODEX_WORKER_FAILED', 'The coding worker did not complete.');
        if (usageTotal(usage) > limits.maxTokens) throw fail('HARNESS_BUDGET_EXHAUSTED', 'The coding worker exhausted the remaining token budget.');
        const patches = await collectPatches(snapshot, childWorkspace, child.capabilities);
        merger = await createDshFileBroker({ workspace, readPolicy, onDecision: event => persist(parent.id, event), signal: combined });
        for (const patch of patches) {
          if (patch.deleted) throw fail('CODEX_PATCH_UNSUPPORTED', 'This worker cannot delete project files.');
          await merger.execute({ tool: 'project_propose_patch', callId: `${child.id}:${patch.path}`.slice(0,200),
            arguments: { path: patch.path, content: patch.content, expectedSha256: patch.baseVersion.sha256 } });
          mergedPaths.push(patch.path);
        }
        await updateRun(child.id, stored => { stored.status = 'completed'; stored.reply = result.finalResponse || '';
          stored.patches = patches; stored.output = { ...result.output, proposalOwnerRunId: parent.id };
          stored.tokenUsage = usage; stored.finishedAt = now(); stored.updatedAt = now(); return stored; });
        emit({ type: 'runtime/delegation', data: { childRunId: child.id, parentRunId: parent.id, phase: 'completed', runtime: 'codex' } });
        return { runId: child.id, childRunId: child.id, status: 'completed', reply: result.finalResponse || '', output: result.output,
          proposals: patches.map(patch => ({ path: patch.path, baseVersion: patch.baseVersion })), usage };
      } catch (error) {
        if (error?.code === 'CODEX_STOP_FAILED') preserveWorkspace = true;
        await eventWrite;
        usage ||= error?.details?.usage;
        const failure = asRuntimeError(error);
        await updateRun(child.id, stored => { stored.status = combined.aborted ? 'cancelled' : 'failed'; stored.finishedAt = now();
          stored.updatedAt = now(); stored.tokenUsage = usage || null;
          stored.output = { ...stored.output, proposalOwnerRunId: parent.id, mergedPaths };
          if (preserveWorkspace) stored.cleanup = { status: 'process-stop-unconfirmed', workspaceRetained: true };
          stored.error = { code: failure.code, message: failure.message, retryable: false }; return stored; });
        emit({ type: 'runtime/delegation', data: { childRunId: child.id, parentRunId: parent.id, phase: combined.aborted ? 'cancelled' : 'failed', runtime: 'codex' } });
        throw error;
      } finally {
        // Missing usage after a failed model call consumes the allocated budget.
        childTokens += usage ? usageTotal(usage) : limits.maxTokens;
        await updateRun(parent.id, stored => { stored.workerTokenUsage = { totalTokens: childTokens }; return stored; });
        controller.abort();
        if (merger) await merger.close();
        if (root && !preserveWorkspace) await fs.rm(root, { recursive: true, force: true });
      }
    });
  }
  return Object.freeze({
    run(input, options = {}) {
      if (typeof options.callId !== 'string' || !options.callId || options.callId.length > 200) return Promise.reject(fail('DELEGATION_ID_REQUIRED', 'A trusted tool call identity is required.'));
      const fingerprint = JSON.stringify(input);
      const previous = calls.get(options.callId);
      if (previous) return previous.fingerprint === fingerprint ? previous.promise : Promise.reject(fail('DELEGATION_ID_CONFLICT', 'The delegation identity was reused with different input.'));
      if (calls.size >= 16) return Promise.reject(fail('DELEGATION_LIMIT', 'This Run has reached its worker call limit.'));
      const promise = pending.then(() => execute(structuredClone(input), options));
      pending = promise.catch(() => {});
      calls.set(options.callId, { fingerprint, promise });
      return promise;
    },
    async close() { closed = true; await pending; },
    get usage() { return { totalTokens: childTokens }; },
    get preserveWorkspace() { return preserveWorkspace; }
  });
}
