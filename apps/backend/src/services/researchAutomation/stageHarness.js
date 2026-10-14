import { createHash } from 'node:crypto';
import { createHarnessRun, getHarnessRun, listHarnessRuns, runHarnessRequest } from '../harnessRuntime/index.js';
import { ResearchWorkflowError } from '../researchWorkflow/errors.js';

const fail = (code, message) => { throw new ResearchWorkflowError(409, code, message); };
const identity = request => createHash('sha256').update(JSON.stringify({ task: request.task, role: request.role,
  input: request.input, context: request.context, prompt: request.prompt, skills: request.researchSkills })).digest('hex');
const result = run => ({ ok: run.status === 'completed', reply: run.reply || '', patches: run.patches || [], runtime: run.adapter,
  runId: run.id, events: run.events || [], fallback: run.fallback, error: run.error });
const hasEvaluation = request => request.stageContract?.fields?.some(field => field.startsWith('evaluationProtocol'));
const contractEnvelope = prompt => {
  const block = /Required output fields \(name: type\) for reproduction_plan:\n[\s\S]*?(?=Stage-specific project skills:\n)/g;
  return typeof prompt === 'string' && [...prompt.matchAll(block)].length === 1 ? prompt.replace(block, '') : null;
};

/** The original stage call ledger owns every producer, including code workers.
 * Bind its effect receipt after the real Run is saved and before any model work. */
export function createAutomationStageHarness({ projectId, session, stage, step, signal, beforeEffect, saveStep,
  createRun = createHarnessRun, readRun = getHarnessRun, listRuns = listHarnessRuns, execute = runHarnessRequest, campaignEvaluation = false }) {
  let calls = [...(step.calls || [])];
  const persist = () => saveStep({ calls: [...calls], runIds: calls.map(call => call.runId) });
  const check = (run, inputHash) => {
    if (identity(run.request) !== inputHash) fail('AUTOMATION_RUN_INPUT_CHANGED', '已保存Run的实际任务输入发生变化。');
    if (run.parentRunId !== session.coordinatorRunId || run.kind !== 'research-stage' || run.automationSessionId !== session.id
      || JSON.stringify(run.request?.context?.automationHandoff) !== JSON.stringify(step.handoff)) {
      fail('AUTOMATION_RUN_OWNER_CHANGED', '阶段Run不属于当前交接。');
    }
  };
  return async (request, { onPrepared, requireExisting = false } = {}) => {
    await beforeEffect(); signal?.throwIfAborted();
    if (campaignEvaluation && (request.source !== 'campaign-evaluation' || request.role !== 'campaign-evaluator' || request.task !== 'campaign_evaluation' || request.capabilities?.length !== 0 || request.fallback !== false)) fail('AUTOMATION_EVALUATION_REQUEST_INVALID', '自动评价仅允许固定空工具的独立评价入口。');
    let inputHash = identity(request), requestId = `${session.id}:${stage}:${inputHash}`;
    let saved = calls.findLast(call => call.inputHash === inputHash), previous;
    if (!saved) {
      for (const candidate of calls.filter(call => call.task === request.task).reverse()) {
        const stored = await readRun(projectId, candidate.runId);
        if (identity(stored.request) === inputHash) { saved = candidate; previous = stored; break; }
      }
    }
    // C3 adds an optional reproduction contract. Only its known prompt block
    // may change; recover the original request instead of silently re-delegating.
    if (!saved && request.task === 'research:reproduction_plan' && hasEvaluation(request)) {
      const recorded = calls.filter(call => call.task === request.task);
      const listed = await listRuns(projectId, { parentRunId: session.coordinatorRunId, limit: 100 });
      if (listed.length === 100) fail('AUTOMATION_RUN_UNRESOLVED', '原复现调用清单不完整，不能重新派发。');
      const pool = new Map(listed.map(run => [run.id, run]));
      for (const call of recorded) pool.set(call.runId, await readRun(projectId, call.runId));
      const legacy = [...pool.values()].filter(run => run.request?.task === request.task && run.request.stageContract?.stage === 'reproduction_plan' && !hasEvaluation(run.request));
      if (legacy.length > 1) fail('AUTOMATION_RUN_UNRESOLVED', '存在多条原复现调用，需要先对账。');
      if (legacy.length) {
        previous = legacy[0]; const call = recorded.find(item => item.runId === previous.id), hash = identity(previous.request);
        check(previous, hash);
        if (call && call.inputHash !== hash || ['role', 'input', 'context', 'researchSkills'].some(key => JSON.stringify(previous.request[key]) !== JSON.stringify(request[key]))
          || !contractEnvelope(previous.request.prompt) || contractEnvelope(previous.request.prompt) !== contractEnvelope(request.prompt)) fail('AUTOMATION_RUN_INPUT_CHANGED', '旧复现调用的输入、交接或修复说明发生变化，不能隐式重派。');
        request = { ...request, prompt: previous.request.prompt, stageContract: previous.request.stageContract }; inputHash = hash;
        requestId = previous.request.requestId || `${session.id}:${stage}:${hash}`;
        saved = call || { runId: previous.id, inputHash, inputIdentityVersion: 2, task: request.task, attempt: session.attempt || 0 };
        if (!call) { calls.push(saved); await persist(); }
      }
    }
    // A crash between Run persistence and the step receipt must reattach the
    // original Run. Conflicting or multiple receipts require reconciliation.
    if (!saved) {
      const orphaned = await listRuns(projectId, { requestId, limit: 100 });
      if (orphaned.length > 1) fail('AUTOMATION_RUN_UNRESOLVED', '同一阶段输入存在多个Run，需要先对账。');
      if (orphaned.length) {
        previous = orphaned[0]; check(previous, inputHash);
        saved = { runId: previous.id, inputHash, inputIdentityVersion: 2, task: request.task, attempt: session.attempt || 0 };
        calls.push(saved); await persist();
      }
    }
    if (requireExisting && !saved) fail('AUTOMATION_RUN_UNRESOLVED', '原代码调用尚未找到；不会重新派发。');
    if (saved) {
      previous ||= await readRun(projectId, saved.runId); check(previous, inputHash);
      if (previous.cleanup?.modelSlotRetained || previous.error?.code === 'HARNESS_INTERRUPTED') {
        fail('AUTOMATION_RUN_UNRESOLVED', '上次Run的进程或持久结果尚未对账，不能自动重跑。');
      }
      if (previous.status === 'completed' || previous.status === 'created' || previous.status === 'paused' && previous.recovery?.status === 'ready') {
        await onPrepared?.(previous); await beforeEffect(); signal?.throwIfAborted();
        return previous.status === 'completed' ? result(previous)
          : execute({ ...request, existingRunId: previous.id, signal }, { automationSessionId: session.id });
      }
      if (campaignEvaluation || previous.retainedWorkspace && previous.recovery?.status !== 'ready'
        || !['failed', 'cancelled'].includes(previous.status) || (saved.attempt || 0) >= (session.attempt || 0)
        || request.context?.codeAuthorization) {
        fail('AUTOMATION_RUN_UNRESOLVED', '已记录阶段Run；不会重复启动未知、未结束或已绑定的代码调用。');
      }
    }
    const prepared = await createRun(projectId, { ...request, parentRunId: session.coordinatorRunId, delegationTask: request.task,
      source: campaignEvaluation ? 'campaign-evaluation' : 'research-automation', requestId }, { automationSessionId: session.id, campaignEvaluationAdmission: campaignEvaluation });
    check(prepared, inputHash);
    calls.push({ runId: prepared.id, inputHash, inputIdentityVersion: 2, task: request.task, attempt: session.attempt || 0 });
    await persist(); await onPrepared?.(prepared); await beforeEffect(); signal?.throwIfAborted();
    return execute({ ...request, existingRunId: prepared.id, signal }, { automationSessionId: session.id });
  };
}
