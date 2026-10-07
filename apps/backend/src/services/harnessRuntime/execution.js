import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertProjectPath, capabilityForToolName, isPathAllowed } from './capabilities.js';
import { asRuntimeError, HarnessRuntimeError } from './errors.js';
import { resolveHarnessProjectRoot } from './repository.js';
import { collectPatches, copyWorkspace, snapshotWorkspace } from './workspace.js';
import { copyBundledResearchSkills, restrictWorkspaceResearchSkills } from '../researchResearch/researchSkills.js';
import { fileVersion } from './fileVersions.js';
import { finalizeAssistantReply } from '../assistantReply.js';

const MAX_EVENTS = 1000;
const now = () => new Date().toISOString();

export function summarizeEvent(event = {}) {
  const source = event?.params?.event || event;
  const data = source?.data || event?.params || {};
  return {
    type: source?.type || event?.method || 'unknown',
    name: data?.name,
    callId: data?.callId,
    tool: data?.tool,
    capability: capabilityForToolName(data?.name || data?.tool),
    usage: data?.usage || data?.tokenUsage,
    ...(source?.type === 'file/read' ? { path: data.path, version: data.version } : {}),
    text: source?.type === 'assistant/message'
      ? source.data?.message?.content?.filter((block) => block?.type === 'text').map((block) => block.text).join('')
      : undefined,
    at: now()
  };
}

function patchListFromResult(result, policy, contextPack) {
  const patches = Array.isArray(result?.patches) ? result.patches : [];
  return patches.filter((patch) => patch && typeof patch.path === 'string' && isPathAllowed(patch.path, policy, { operation: 'patch' }))
    .map((patch) => {
      const relativePath = assertProjectPath(patch.path, policy, { operation: 'patch' });
      const file = contextPack?.files?.find((item) => item.path === relativePath);
      // Old adapters may omit a baseline. Only a server-captured context version
      // is a safe fallback; never read the current file to bless an old proposal.
      const baseVersion = patch.baseVersion || (file ? { exists: true, sha256: file.sha256 } : null);
      const original = patch.original ?? (file && !file.truncated ? file.content : undefined);
      return { ...patch, path: relativePath, original, baseVersion };
    });
}

function timeoutPromise(ms, controller) {
  let timer;
  const promise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new HarnessRuntimeError(504, 'HARNESS_TIMEOUT', `Harness Run exceeded its ${ms}ms timeout.`, { timeoutMs: ms }, { retryable: true });
      controller.timeoutError = error;
      controller.abort(error);
      reject(error);
    }, ms);
  });
  promise.cancel = () => clearTimeout(timer);
  return promise;
}

async function runWithTimeout(task, timeoutMs, controller) {
  const timeout = timeoutPromise(timeoutMs, controller);
  let abort;
  const aborted = new Promise((_, reject) => {
    abort = () => reject(controller.signal.reason || new Error('Harness Run aborted.'));
    if (controller.signal.aborted) abort();
    else controller.signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([task, timeout, aborted]);
  } finally {
    timeout.cancel();
    controller.signal.removeEventListener('abort', abort);
  }
}

// Persistence and in-flight ownership stay with the runtime composition root.
export function createRunExecutor({ getRun, updateRun, adapterFor, forgetRequest }) {
  async function persistEvents(projectId, runId, events) {
    if (!events.length) return;
    await updateRun(projectId, runId, (run) => {
      run.events = [...(run.events || []), ...events].slice(-MAX_EVENTS);
      run.updatedAt = now();
      return run;
    });
  }

  async function executeRun(projectId, runId, request, control) {
    const run = await getRun(projectId, runId);
    const adapter = adapterFor(run.adapter);
    if (!adapter) throw new HarnessRuntimeError(500, 'HARNESS_ADAPTER_NOT_FOUND', `Unknown Harness Adapter: ${run.adapter}.`);
    if (run.capabilities.denied?.length) {
      throw new HarnessRuntimeError(403, 'CAPABILITY_DENIED', 'Requested Harness capabilities were not granted by the Project Constraints.', { denied: run.capabilities.denied });
    }
    const projectRoot = await resolveHarnessProjectRoot(projectId);
    let runRoot;
    let workspace;
    let dshHome;
    let workspaceSnapshot;
    let excludedSkillPaths = [];
    let eventWrite = Promise.resolve();
    const emit = (event) => {
      const summary = summarizeEvent(event);
      eventWrite = eventWrite.then(() => persistEvents(projectId, runId, [summary])).catch(() => {});
      const capability = summary.capability;
      const toolName = summary.name || summary.tool;
      if (toolName && !capability && !control.violation) {
        control.violation = new HarnessRuntimeError(403, 'TOOL_CAPABILITY_UNKNOWN', `Harness tool is not mapped to an allowed capability: ${toolName}.`, { tool: toolName });
        control.controller.abort(control.violation);
        return;
      }
      if (capability && !run.capabilities.granted.includes(capability) && !control.violation) {
        control.violation = new HarnessRuntimeError(403, 'CAPABILITY_DENIED', `Harness tool capability denied: ${capability}.`, { capability, tool: summary.name || summary.tool });
        control.controller.abort(control.violation);
      }
    };

    try {
      if (run.adapter === 'deepseek') {
        const unenforceable = run.capabilities.granted.filter((capability) => ['research.search', 'experiment.execute'].includes(capability));
        if (unenforceable.length) {
          throw new HarnessRuntimeError(403, 'CAPABILITY_POLICY_UNENFORCEABLE', 'The DeepSeek Harness SDK has no pre-tool policy hook for network or command execution. Use the legacy Adapter for these capabilities.', { capabilities: unenforceable });
        }
        // Only the SDK executes in a workspace. Legacy reads the project through
        // guarded tools; Fake needs no files. Copying for them was unused work.
        runRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'scienceprism-harness-'));
        workspace = path.join(runRoot, 'workspace');
        dshHome = path.join(runRoot, 'dsh-home');
        await copyWorkspace(projectRoot, workspace, run.capabilities);
        workspaceSnapshot = await snapshotWorkspace(workspace, run.capabilities);
        for (const file of run.contextPack.files || []) {
          const snapshot = workspaceSnapshot.get(file.path);
          if (snapshot === undefined || snapshot === null || fileVersion(snapshot).sha256 !== file.sha256) {
            throw new HarnessRuntimeError(409, 'DOCUMENT_VERSION_CONFLICT', 'The project changed after context was captured.', { path: file.path });
          }
        }
        if (Array.isArray(request.researchSkills)) {
          const removedSkillPaths = await restrictWorkspaceResearchSkills(workspace, { enabledSkillNames: request.researchSkills });
          const bundledSkillPaths = await copyBundledResearchSkills(workspace, { enabledSkillNames: request.researchSkills });
          excludedSkillPaths = [...removedSkillPaths, ...bundledSkillPaths];
        }
      }
      const task = adapter.run({
        request: { ...request, contextPack: run.contextPack },
        projectRoot,
        workspace,
        dshHome,
        capabilities: run.capabilities.granted,
        capabilityPolicy: run.capabilities,
        // Every adapter receives the Run's limits, not only the DeepSeek SDK.
        limits: run.limits,
        signal: control.controller.signal,
        emit
      });
      const rawResult = await runWithTimeout(task, run.limits.timeoutMs, control.controller);
      control.controller.signal.throwIfAborted();
      const result = await finalizeAssistantReply(projectId, request, rawResult);
      await eventWrite;
      const workspacePatches = run.adapter === 'deepseek'
        ? await collectPatches(workspaceSnapshot, workspace, run.capabilities, excludedSkillPaths)
        : [];
      const patches = [...workspacePatches, ...patchListFromResult(result, run.capabilities, run.contextPack)]
        .filter((patch, index, values) => values.findIndex((item) => item.path === patch.path) === index);
      const updated = await updateRun(projectId, runId, (current) => {
        current.status = 'completed';
        current.finishedAt = now();
        current.updatedAt = current.finishedAt;
        control.controller.signal.throwIfAborted();
        current.reply = result?.finalResponse || result?.reply || '';
        current.constraintProposal = result?.constraintProposal;
        current.constraintProposalError = result?.constraintProposalError;
        current.sessionId = result?.sessionId;
        current.patches = patches;
        current.humanDecision = patches.length ? { status: 'pending' } : { status: 'none' };
        current.output = result?.output;
        current.tokenUsage = result?.usage || result?.tokenUsage || current.events.map((event) => event.usage).find(Boolean) || null;
        current.adapterResult = { ok: result?.ok !== false, fallback: current.fallback || false };
        return current;
      });
      forgetRequest(runId);
      return updated;
    } catch (error) {
      await eventWrite;
      const runtimeError = control.violation || control.timeoutError || asRuntimeError(error);
      if (control.cancelRequested || control.controller.signal.reason?.code === 'HARNESS_CANCELLED') {
        return updateRun(projectId, runId, (current) => {
          current.status = 'cancelled';
          current.finishedAt = now();
          current.updatedAt = current.finishedAt;
          current.error = { code: 'HARNESS_CANCELLED', message: 'Harness Run was cancelled.', retryable: false };
          return current;
        });
      }
      if (control.pauseRequested || control.controller.signal.reason?.code === 'HARNESS_PAUSED') {
        return updateRun(projectId, runId, (current) => {
          current.status = 'paused';
          current.updatedAt = now();
          current.error = { code: 'HARNESS_PAUSED', message: 'Harness Run was paused and can be resumed.', retryable: true };
          return current;
        });
      }

      if (run.adapter === 'deepseek' && run.fallback && !control.controller.signal.aborted && runtimeError.retryable && !runtimeError.code?.includes('CAPABILITY') && !runtimeError.code?.includes('PATH')) {
        const fallbackAdapter = adapterFor('legacy');
        try {
          emit({ type: 'runtime/fallback', data: { from: 'deepseek', to: 'legacy', error: runtimeError.message } });
          const rawFallback = await runWithTimeout(fallbackAdapter.run({
            request: { ...request, contextPack: run.contextPack },
            projectRoot,
            workspace,
            dshHome,
            capabilities: run.capabilities.granted,
            capabilityPolicy: run.capabilities,
            limits: run.limits,
            signal: control.controller.signal,
            emit
          }), run.limits.timeoutMs, control.controller);
          control.controller.signal.throwIfAborted();
          const fallbackResult = await finalizeAssistantReply(projectId, request, rawFallback);
          await eventWrite;
          const patches = patchListFromResult(fallbackResult, run.capabilities, run.contextPack);
          const updated = await updateRun(projectId, runId, (current) => {
            control.controller.signal.throwIfAborted();
            current.status = 'completed';
            current.finishedAt = now();
            current.updatedAt = current.finishedAt;
            current.adapter = 'legacy';
            current.adapterHistory = [...(current.adapterHistory || []), { adapter: 'deepseek', error: runtimeError.message, at: now() }];
            current.reply = fallbackResult?.finalResponse || fallbackResult?.reply || '';
            current.constraintProposal = fallbackResult?.constraintProposal;
            current.constraintProposalError = fallbackResult?.constraintProposalError;
            current.tokenUsage = fallbackResult?.usage || fallbackResult?.tokenUsage || null;
            current.sessionId = fallbackResult?.sessionId;
            current.patches = patches;
            current.humanDecision = patches.length ? { status: 'pending' } : { status: 'none' };
            current.fallback = true;
            current.error = { code: runtimeError.code, message: runtimeError.message, retryable: runtimeError.retryable };
            current.adapterResult = { ok: true, fallback: true };
            return current;
          });
          forgetRequest(runId);
          return updated;
        } catch (fallbackError) {
          if (control.cancelRequested || control.controller.signal.reason?.code === 'HARNESS_CANCELLED') {
            return updateRun(projectId, runId, (current) => {
              current.status = 'cancelled';
              current.finishedAt = now();
              current.updatedAt = current.finishedAt;
              current.error = { code: 'HARNESS_CANCELLED', message: 'Harness Run was cancelled.', retryable: false };
              return current;
            });
          }
          if (control.pauseRequested || control.controller.signal.reason?.code === 'HARNESS_PAUSED') {
            return updateRun(projectId, runId, (current) => {
              current.status = 'paused';
              current.updatedAt = now();
              current.error = { code: 'HARNESS_PAUSED', message: 'Harness Run was paused and can be resumed.', retryable: true };
              return current;
            });
          }
          const fallbackRuntimeError = asRuntimeError(fallbackError, 'FALLBACK_FAILED');
          return updateRun(projectId, runId, (current) => {
            current.status = 'failed';
            current.finishedAt = now();
            current.updatedAt = current.finishedAt;
            current.error = { code: fallbackRuntimeError.code, message: fallbackRuntimeError.message, retryable: fallbackRuntimeError.retryable };
            current.harnessError = runtimeError.message;
            return current;
          });
        }
      }

      return updateRun(projectId, runId, (current) => {
        current.status = 'failed';
        current.finishedAt = now();
        current.updatedAt = current.finishedAt;
        current.error = { code: runtimeError.code, message: runtimeError.message, retryable: runtimeError.retryable };
        return current;
      });
    } finally {
      forgetRequest(runId);
      if (runRoot) await fs.rm(runRoot, { recursive: true, force: true }).catch(() => {});
    }
  }

  return executeRun;
}
