import { createHash } from 'node:crypto';
import { createHarnessRun, getHarnessRun, listHarnessRuns, runHarnessRequest } from '../harnessRuntime/index.js';
import { ResearchWorkflowError } from '../researchWorkflow/errors.js';

const fail = (code, message) => { throw new ResearchWorkflowError(409, code, message); };
const identity = request => createHash('sha256').update(JSON.stringify({ task: request.task, role: request.role,
  input: request.input, context: request.context, prompt: request.prompt, skills: request.researchSkills })).digest('hex');
const result = run => ({ ok: run.status === 'completed', reply: run.reply || '', patches: run.patches || [], runtime: run.adapter,
  runId: run.id, events: run.events || [], fallback: run.fallback, error: run.error });

/** The original stage call ledger owns every producer, including code workers.
 * Bind its effect receipt after the real Run is saved and before any model work. */
export function createAutomationStageHarness({ projectId, session, stage, step, signal, beforeEffect, saveStep,
  createRun = createHarnessRun, readRun = getHarnessRun, listRuns = listHarnessRuns, execute = runHarnessRequest }) {
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
    const inputHash = identity(request), requestId = `${session.id}:${stage}:${inputHash}`;
    let saved = calls.findLast(call => call.inputHash === inputHash), previous;
    if (!saved) {
      for (const candidate of calls.filter(call => call.task === request.task).reverse()) {
        const stored = await readRun(projectId, candidate.runId);
        if (identity(stored.request) === inputHash) { saved = candidate; previous = stored; break; }
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
      if (previous.retainedWorkspace && previous.recovery?.status !== 'ready'
        || !['failed', 'cancelled'].includes(previous.status) || (saved.attempt || 0) >= (session.attempt || 0)
        || request.context?.codeAuthorization) {
        fail('AUTOMATION_RUN_UNRESOLVED', '已记录阶段Run；不会重复启动未知、未结束或已绑定的代码调用。');
      }
    }
    const prepared = await createRun(projectId, { ...request, parentRunId: session.coordinatorRunId, delegationTask: request.task,
      source: 'research-automation', requestId }, { automationSessionId: session.id });
    check(prepared, inputHash);
    calls.push({ runId: prepared.id, inputHash, inputIdentityVersion: 2, task: request.task, attempt: session.attempt || 0 });
    await persist(); await onPrepared?.(prepared); await beforeEffect(); signal?.throwIfAborted();
    return execute({ ...request, existingRunId: prepared.id, signal }, { automationSessionId: session.id });
  };
}
