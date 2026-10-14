import { campaignEvaluationService } from '../validationCampaign/agentEvaluation.js';
import { getHarnessRun } from '../harnessRuntime/index.js';
import { getResearchWorkflow } from '../researchWorkflow/queries.js';
import { ResearchWorkflowError } from '../researchWorkflow/errors.js';
import { readAutomation, requireAutomatic } from './policy.js';
import { assertAutomationHandoff, sourceHash } from './handoff.js';
import { createAutomationStageHarness } from './stageHarness.js';

const fail = (code, message) => { throw new ResearchWorkflowError(409, code, message); };
/** The experiment's original call ledger owns its separate, empty-tool evaluator. */
export async function evaluateAutomationCampaign({ projectId, session, runtime = {}, beforeEffect = async () => {}, saveStep,
  evaluationService = campaignEvaluationService, createStageHarness = createAutomationStageHarness }) {
  const step = session.steps.find(item => item.stage === 'experiment');
  if (session.campaignEvaluationVersion !== 1 || !step?.campaignId) return null;
  if (!step.handoff || typeof saveStep !== 'function') fail('AUTOMATION_EVALUATION_HANDOFF_REQUIRED', '自动评价需要原实验交接和阶段保存入口。');
  let prepared, receipt = step.campaignEvaluation ? structuredClone(step.campaignEvaluation) : null;
  const guard = async () => {
    runtime.signal?.throwIfAborted(); await beforeEffect(); await requireAutomatic(projectId, 'experiment', session.id);
    const current = (await readAutomation(projectId)).session, currentStep = current?.steps.find(item => item.stage === 'experiment');
    if (current?.coordinatorRunId !== session.coordinatorRunId || current.campaignEvaluationVersion !== 1 || currentStep?.campaignId !== step.campaignId
      || currentStep.experimentRunId !== step.experimentRunId || sourceHash(currentStep.handoff || null) !== sourceHash(step.handoff)) fail('AUTOMATION_EVALUATION_OWNER_CHANGED', '原批次、材料锚点或交接已变化。');
    if (receipt && sourceHash(currentStep.campaignEvaluation || null) !== sourceHash(receipt)) fail('AUTOMATION_EVALUATION_OWNER_CHANGED', '已保存评价回执发生变化，不能覆盖原记录。');
    const coordinator = await getHarnessRun(projectId, session.coordinatorRunId);
    if (coordinator.kind !== 'research-coordinator' || coordinator.coordinatorSessionId !== session.id || coordinator.status !== 'created'
      || coordinator.request.input.workflowId !== current.workflowId) fail('AUTOMATION_EVALUATION_OWNER_CHANGED', '评价必须归属于当前真实研究父任务。');
    assertAutomationHandoff(step.handoff, { projectId, workflow: await getResearchWorkflow(projectId), session: current, stage: 'experiment', role: step.handoff.role });
    const next = await evaluationService.prepare(projectId, step.campaignId);
    if (next.source.snapshot.sessionId !== session.id || next.source.snapshot.baseRunId !== step.experimentRunId) fail('AUTOMATION_EVALUATION_OWNER_CHANGED', '批次冻结来源不属于原会话和材料运行。');
    if (prepared && prepared.source.sourceSha256 !== next.source.sourceSha256 || step.campaignEvaluation && step.campaignEvaluation.sourceSha256 !== next.source.sourceSha256) fail('CAMPAIGN_EVALUATION_SOURCE_CHANGED', '完整批次来源已变化，保留原评价，不重新派发。');
    prepared ||= next;
  };
  await guard();
  receipt ||= { version: 1, campaignId: step.campaignId, runId: null, requestId: null,
    sourceSha256: prepared.source.sourceSha256, status: 'prepared', output: null, error: null };
  if (receipt.version !== 1 || receipt.campaignId !== step.campaignId) fail('AUTOMATION_EVALUATION_OWNER_CHANGED', '评价回执不属于当前批次。');
  await saveStep({ campaignEvaluation: receipt, status: 'evaluating' });
  const runHarness = createStageHarness({ projectId, session, stage: 'experiment', step, signal: runtime.signal,
    beforeEffect: guard, saveStep, campaignEvaluation: true });
  const request = { ...prepared.request, input: { campaignId: step.campaignId, sourceSha256: prepared.source.sourceSha256 },
    context: { automationHandoff: step.handoff }, ...(runtime.adapter ? { adapter: runtime.adapter } : {}),
    ...Object.fromEntries(['fakeResponse', 'fakeError', 'fakeDelayMs'].filter(key => runtime.testInput?.campaign_evaluation?.[key] !== undefined)
      .map(key => [key, runtime.testInput.campaign_evaluation[key]])) };
  let result;
  try { result = await runHarness(request, { requireExisting: !!receipt.runId, onPrepared: async run => {
    if (receipt.runId && receipt.runId !== run.id) fail('AUTOMATION_EVALUATION_OWNER_CHANGED', '原评价Run不得被替换。');
    receipt = { ...receipt, runId: run.id, requestId: run.request.requestId, status: run.status };
    await saveStep({ campaignEvaluation: receipt });
  } }); } catch (error) {
    if (error.code !== 'HARNESS_RUN_NOT_RUNNABLE' || !receipt.runId || runtime.signal?.aborted) throw error;
    const original = await getHarnessRun(projectId, receipt.runId);
    if (!['failed', 'cancelled'].includes(original.status)) throw error;
    result = { runId: original.id }; // Cancellation between receipt and launch remains the original terminal Run.
  }
  await guard();
  const evaluation = await evaluationService.resolve(projectId, step.campaignId, result.runId, receipt.sourceSha256);
  const run = await getHarnessRun(projectId, result.runId);
  if (run.kind !== 'research-stage' || run.parentRunId !== session.coordinatorRunId || run.automationSessionId !== session.id
    || sourceHash(run.request.context?.automationHandoff || null) !== sourceHash(step.handoff)) fail('AUTOMATION_EVALUATION_OWNER_CHANGED', '实际评价Run不属于原阶段调用。');
  await guard();
  receipt = { ...receipt, runId: run.id, requestId: evaluation.requestId, status: evaluation.status, output: evaluation.output, error: evaluation.error };
  await saveStep({ campaignEvaluation: receipt });
  if (receipt.status !== 'completed' || !receipt.output) fail('AUTOMATION_CAMPAIGN_EVALUATION_FAILED', '独立评价未通过原合同，原Run与完整实验结果已保留。');
  return structuredClone(receipt);
}
