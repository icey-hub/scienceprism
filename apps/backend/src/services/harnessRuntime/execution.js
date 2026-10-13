import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { assertProjectPath, capabilityForToolName, isPathAllowed } from './capabilities.js';
import { asRuntimeError, HarnessRuntimeError } from './errors.js';
import { resolveHarnessProjectRoot } from './repository.js';
import { collectPatches, copyWorkspace, snapshotWorkspace } from './workspace.js';
import { projectSelectedSkillDocuments } from '../skillRuntime/projection.js';
import { fileVersion } from './fileVersions.js';
import { finalizeAssistantReply } from '../assistantReply.js';
import { createCurrentToolPolicy } from './currentToolPolicy.js';
import { createCodexDelegation, usageTotal } from './codexDelegation.js';
import { createCodexWorker, CODEX_WORKER_TOOLS } from './adapters/codexWorker.js';
import { CODEX_PROTOCOL_VERSION } from './adapters/codexAdapter.js';
import { createRetainedWorkspace } from './retainedWorkspace.js';
import { loadRetainedRecoveryInputs } from './runRecovery.js';
import { getEnv } from '../../config/constants.js';
import { resolveLLMConfig, normalizeBaseURL, normalizeChatEndpoint } from '../llmService.js';

import { assertDshMcpPolicy } from '../mcp/execution.js';
import { summarizeEvent, appendRuntimeEvents, sumEventUsage } from './runtimeEvents.js';
export { summarizeEvent } from './runtimeEvents.js';
const now = () => new Date().toISOString();

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

async function runWithTimeout(task, timeoutMs, controller, stopTimeoutMs) {
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
    if (controller.signal.aborted) {
      let stopTimer;
      const outcome = await Promise.race([
        task.then(() => ({ stopped: true }), error => ({ stopped: !['CODEX_STOP_FAILED', 'DSH_STOP_FAILED'].includes(error?.code), error })),
        new Promise(resolve => { stopTimer = setTimeout(() => resolve({ stopped: false }), stopTimeoutMs); })
      ]);
      clearTimeout(stopTimer);
      if (!outcome.stopped) {
        controller.stopError = new HarnessRuntimeError(503, 'HARNESS_STOP_UNCONFIRMED', 'The runtime has not confirmed stopping. Its private workspace and model slot are retained.');
        throw controller.stopError;
      }
    }
  }
}

// Persistence and in-flight ownership stay with the runtime composition root.
export function createRunExecutor({ getRun, updateRun, adapterFor, forgetRequest, readProjectConstraints, runChild,
  codexWorker = () => createCodexWorker({ executable: getEnv('CODEX_EXECUTABLE') }), stopTimeoutMs = 10000 }) {
  async function persistEvents(projectId, runId, events) {
    if (!events.length) return;
    await updateRun(projectId, runId, (run) => {
      appendRuntimeEvents(run, events);
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
    const readPolicy = createCurrentToolPolicy({ initialRun: run, getRun: () => getRun(projectId, runId),
      readConstraints: () => readProjectConstraints(projectRoot), signal: control.controller.signal });
    let runRoot;
    let retained;
    let workspace;
    let dshHome;
    let workspaceSnapshot;
    let excludedSkillPaths = [];
    let skillProjection;
    let delegation;
    const continuing = run.recovery?.status === 'ready';
    const previousParentTokens = continuing ? Math.max(usageTotal(sumEventUsage(run.events)),
      Number(run.tokenUsage?.parentTotalTokens ?? Math.max(0, usageTotal(run.tokenUsage) - usageTotal(run.workerTokenUsage)))) : 0;
    let parentReportedTokens = previousParentTokens;
    let eventWrite = Promise.resolve();
    const emit = (event) => {
      const summary = summarizeEvent(event);
      // Only this adapter emits the exact identity of its pre-authorized call.
      if (run.adapter === 'mcp' && summary.name === `mcp__${request.mcpCall?.serverId}__${request.mcpCall?.toolName}`) summary.capability = 'project.read';
      eventWrite = eventWrite.then(() => persistEvents(projectId, runId, [summary])).catch(() => {});
      if (summary.usage) {
        parentReportedTokens += usageTotal(summary.usage);
        if (parentReportedTokens + (delegation?.usage.totalTokens || 0) > run.limits.maxTokens && !control.violation) {
          control.violation = new HarnessRuntimeError(409, 'HARNESS_BUDGET_EXHAUSTED', 'The combined parent and worker token budget was exhausted.');
          control.controller.abort(control.violation);
          return;
        }
      }
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
        assertDshMcpPolicy(request);
        const resolvedModel = resolveLLMConfig(request.llmConfig).model;
        if (run.model !== resolvedModel) {
          await updateRun(projectId, runId, current => { current.model = resolvedModel; return current; });
        }
        // Only the SDK executes in a workspace. Legacy reads the project through
        // guarded tools; Fake needs no files. Copying for them was unused work.
        retained = await createRetainedWorkspace({ projectRoot, runId, attempt: continuing ? run.recovery.workspaceAttempt : run.attempt, recover: continuing,
          expectedVersions: { runtime: 'scienceprism-harness-retention-v1', codex: CODEX_PROTOCOL_VERSION,
            toolsHash: createHash('sha256').update(JSON.stringify(CODEX_WORKER_TOOLS)).digest('hex') } });
        runRoot = retained.root;
        workspace = retained.workspace;
        dshHome = retained.dshHome;
        await retained.update({ status: 'running', stopConfirmed: false, runtimeProcess: { pid: null, stopConfirmed: true } });
        await updateRun(projectId, runId, current => { current.retainedWorkspace = { format: 'scienceprism-harness-retention-v1', attempt: continuing ? run.recovery.workspaceAttempt : run.attempt }; return current; });
        if (continuing) {
          const inputs = await loadRetainedRecoveryInputs({ retained, run, projectRoot, capabilities: (await readPolicy()).capabilities });
          workspaceSnapshot = inputs.snapshot;
          skillProjection = inputs.skillProjection;
        } else {
        if (run.capabilities.granted.includes('project.read')) await copyWorkspace(projectRoot, workspace, run.capabilities);
        else await fs.mkdir(workspace, { recursive: true });
        workspaceSnapshot = await snapshotWorkspace(workspace, run.capabilities);
        await copyWorkspace(workspace, path.join(runRoot, 'baseline'), run.capabilities);
        for (const file of run.contextPack.files || []) {
          const snapshot = workspaceSnapshot.get(file.path);
          if (snapshot === undefined || snapshot === null || fileVersion(snapshot).sha256 !== file.sha256) {
            throw new HarnessRuntimeError(409, 'DOCUMENT_VERSION_CONFLICT', 'The project changed after context was captured.', { path: file.path });
          }
        }
        skillProjection = await projectSelectedSkillDocuments({ projectId, projectRoot, workspaceRoot: workspace,
          enabledSkillNames: request.researchSkills || [], capabilityPolicy: run.capabilities, signal: control.controller.signal });
        }
        excludedSkillPaths = skillProjection.excludedPaths;
        await retained.update(continuing ? { status: 'running' } : { status: 'running',
          skills: skillProjection.documents.map(document => ({ path: document.projectionPath, sha256: document.sha256, bytes: document.bytes })),
          baseFiles: [...workspaceSnapshot].map(([file, text]) => ({ path: file, sha256: text === null ? null : createHash('sha256').update(text).digest('hex'), bytes: text === null ? 0 : Buffer.byteLength(text) })) });
        await updateRun(projectId, runId, current => {
          current.skillVersions = { format: skillProjection.format, documents: skillProjection.documents, totalBytes: skillProjection.totalBytes, scriptsIncluded: false };
          return current;
        });
        if ((getEnv('CODEX_EXECUTABLE') || continuing && run.recovery.children.length > 0) && run.capabilities.granted.includes('patch.propose')) {
          const provider = resolveLLMConfig(request.llmConfig);
          delegation = createCodexDelegation({ parent: { ...run, skillVersions: { format: skillProjection.format, documents: skillProjection.documents } },
            workspace, runtimeHome: runRoot, skillProjection,
            recoveredChildren: continuing ? run.recovery.children : [],
            provider: { baseUrl: normalizeBaseURL(normalizeChatEndpoint(provider.endpoint)), model: provider.model, apiKey: provider.apiKey },
            worker: codexWorker(), readPolicy, getRun: id => getRun(projectId, id), updateRun: (id, updater) => updateRun(projectId, id, updater),
            runChild, signal: control.controller.signal, emit, flushEvents: () => eventWrite,
            onChildCheckpoint: async child => {
              const checkpoint = await retained.read();
              await retained.update({ children: [...checkpoint.children.filter(previous => previous.runId !== child.runId), child] });
            } });
        }
      }
      const remainingTokens = run.limits.maxTokens - previousParentTokens - (delegation?.usage.totalTokens || 0);
      if (remainingTokens <= 0) throw new HarnessRuntimeError(409, 'HARNESS_BUDGET_EXHAUSTED', 'No model budget remains after recovered results.');
      const task = adapter.run({
        request: { ...request, contextPack: run.contextPack },
        projectRoot,
        workspace,
        dshHome,
        skillProjection,
        continuation: continuing ? { format: run.recovery.format, children: run.recovery.children, proposals: run.patches.map(patch => ({ path: patch.path, baseVersion: patch.baseVersion })) } : undefined,
        readPolicy,
        onDecision: event => persistEvents(projectId, runId, [summarizeEvent(event)]),
        onProcess: process => retained?.update({ runtimeProcess: process }),
        delegateCodex: delegation ? async (input, options) => {
          try { return await delegation.run(input, options); }
          catch (error) {
            if (delegation.preserveWorkspace || error?.code === 'CODEX_STOP_FAILED') {
              control.stopUnconfirmed = true;
              control.controller.stopError = new HarnessRuntimeError(503, 'HARNESS_STOP_UNCONFIRMED', 'A delegated process has not confirmed stopping.');
              control.controller.abort(control.controller.stopError);
            }
            throw error;
          }
        } : undefined,
        capabilities: run.capabilities.granted,
        capabilityPolicy: run.capabilities,
        // Every adapter receives the Run's limits, not only the DeepSeek SDK.
        limits: { ...run.limits, maxTokens: remainingTokens },
        signal: control.controller.signal,
        emit
      });
      const rawResult = await runWithTimeout(task, run.limits.timeoutMs, control.controller, stopTimeoutMs);
      control.controller.signal.throwIfAborted();
      if (delegation?.preserveWorkspace) throw new HarnessRuntimeError(503, 'HARNESS_STOP_UNCONFIRMED', 'A delegated process has not confirmed stopping.');
      if (delegation && previousParentTokens + usageTotal(rawResult?.usage || rawResult?.tokenUsage) + delegation.usage.totalTokens > run.limits.maxTokens) {
        throw new HarnessRuntimeError(409, 'HARNESS_BUDGET_EXHAUSTED', 'The combined parent and worker token budget was exhausted.');
      }
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
        const parentUsage = result?.usage || result?.tokenUsage;
        const parentTokens = parentUsage ? previousParentTokens + usageTotal(parentUsage) : usageTotal(sumEventUsage(current.events));
        current.tokenUsage = delegation ? { ...parentUsage,
          totalTokens: parentTokens + delegation.usage.totalTokens, parentTotalTokens: parentTokens, workerTotalTokens: delegation.usage.totalTokens }
          : parentUsage || sumEventUsage(current.events) || null;
        if (continuing) current.recovery = { ...current.recovery, status: 'continued' };
        current.adapterResult = { ok: result?.ok !== false, fallback: current.fallback || false };
        return current;
      });
      forgetRequest(runId);
      return updated;
    } catch (error) {
      await eventWrite;
      const runtimeError = control.controller.stopError || control.violation || control.timeoutError || asRuntimeError(error);
      control.stopUnconfirmed = ['HARNESS_STOP_UNCONFIRMED', 'CODEX_STOP_FAILED', 'DSH_STOP_FAILED'].includes(runtimeError.code) || delegation?.preserveWorkspace;
      if (!control.stopUnconfirmed && (control.cancelRequested || control.controller.signal.reason?.code === 'HARNESS_CANCELLED')) {
        return await updateRun(projectId, runId, (current) => {
          current.status = 'cancelled';
          current.finishedAt = now();
          current.updatedAt = current.finishedAt;
          current.error = { code: 'HARNESS_CANCELLED', message: 'Harness Run was cancelled.', retryable: false };
          return current;
        });
      }
      if (!control.stopUnconfirmed && (control.pauseRequested || control.controller.signal.reason?.code === 'HARNESS_PAUSED')) {
        return await updateRun(projectId, runId, (current) => {
          current.status = 'paused';
          current.updatedAt = now();
          current.error = { code: 'HARNESS_PAUSED', message: 'Harness Run was paused and can be resumed.', retryable: true };
          return current;
        });
      }

      if (run.adapter === 'deepseek' && run.fallback && !control.stopUnconfirmed && !delegation?.usage.totalTokens && !control.controller.signal.aborted && runtimeError.retryable && !runtimeError.code?.includes('CAPABILITY') && !runtimeError.code?.includes('PATH')) {
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
          }), run.limits.timeoutMs, control.controller, stopTimeoutMs);
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
          if (control.controller.stopError) {
            control.stopUnconfirmed = true;
            return await updateRun(projectId, runId, current => {
              current.status = 'failed'; current.finishedAt = now(); current.updatedAt = now();
              current.error = { code: 'HARNESS_STOP_UNCONFIRMED', message: control.controller.stopError.message, retryable: false };
              current.cleanup = { status: 'process-stop-unconfirmed', workspaceRetained: Boolean(runRoot), modelSlotRetained: true };
              return current;
            });
          }
          if (control.cancelRequested || control.controller.signal.reason?.code === 'HARNESS_CANCELLED') {
            return await updateRun(projectId, runId, (current) => {
              current.status = 'cancelled';
              current.finishedAt = now();
              current.updatedAt = current.finishedAt;
              current.error = { code: 'HARNESS_CANCELLED', message: 'Harness Run was cancelled.', retryable: false };
              return current;
            });
          }
          if (control.pauseRequested || control.controller.signal.reason?.code === 'HARNESS_PAUSED') {
            return await updateRun(projectId, runId, (current) => {
              current.status = 'paused';
              current.updatedAt = now();
              current.error = { code: 'HARNESS_PAUSED', message: 'Harness Run was paused and can be resumed.', retryable: true };
              return current;
            });
          }
          const fallbackRuntimeError = asRuntimeError(fallbackError, 'FALLBACK_FAILED');
          return await updateRun(projectId, runId, (current) => {
            current.status = 'failed';
            current.finishedAt = now();
            current.updatedAt = current.finishedAt;
            current.error = { code: fallbackRuntimeError.code, message: fallbackRuntimeError.message, retryable: fallbackRuntimeError.retryable };
            current.harnessError = runtimeError.message;
            return current;
          });
        }
      }

      return await updateRun(projectId, runId, (current) => {
        current.status = 'failed';
        current.finishedAt = now();
        current.updatedAt = current.finishedAt;
        current.error = { code: runtimeError.code, message: runtimeError.message, retryable: runtimeError.retryable };
        if (control.stopUnconfirmed) current.cleanup = { status: 'process-stop-unconfirmed', workspaceRetained: Boolean(runRoot), modelSlotRetained: true };
        return current;
      });
    } finally {
      forgetRequest(runId);
      if (delegation) {
        control.controller.abort();
        if (control.stopUnconfirmed) void delegation.close().catch(() => {});
        else await delegation.close();
      }
      if (retained) {
        // Terminal updates above must settle before releasing retained ownership.
        const current = await getRun(projectId, runId);
        await retained.release({ status: current.status === 'completed' || current.status === 'awaiting_approval' ? 'completed'
          : current.status === 'cancelled' ? 'cancelled' : control.stopUnconfirmed ? 'ambiguous' : 'failed',
          stopConfirmed: !control.stopUnconfirmed && !delegation?.preserveWorkspace });
      }
    }
  }

  return executeRun;
}
