import { readAutomation } from './policy.js';
import { sourceHash } from './handoff.js';
import { createTrialAuthorization, assertTrialExperiment, assertCompletedTrial } from '../experimentRunner/trialContext.js';
import { createTrialExperimentRun, automaticallyApproveExperiment, startExperimentRun, getExperimentRun, experimentRunSummary } from '../experimentRunner/index.js';
import { experimentManifestHash } from '../experimentRunner/manifest.js';
import { ResearchWorkflowError } from '../researchWorkflow/errors.js';

const fail = (code, message) => { throw new ResearchWorkflowError(409, code, message); };

/** Engineering checks use the same Runner, but never consume the scientific
 * plan or publish their result as the stage's formal experiment. */
export async function prepareAutomationTrial({ projectId, session, stage, plan, saveStep, beforeEffect, signal, onRun,
  readState = () => readAutomation(projectId), createAuthorization = createTrialAuthorization,
  createRun = createTrialExperimentRun, readRun = getExperimentRun, approve = automaticallyApproveExperiment,
  execute = startExperimentRun, assertRun = assertTrialExperiment, assertCompleted = assertCompletedTrial }) {
  const planSha256 = sourceHash(plan);
  const checkpoint = async () => {
    await beforeEffect(); signal?.throwIfAborted();
    const state = await readState(), step = state.session?.steps?.find(item => item.stage === stage);
    if (state.session?.id !== session.id || state.session.coordinatorRunId !== session.coordinatorRunId
      || state.session.currentStage !== stage || state.session.stopRequested || state.session.status !== 'running' || !step?.handoff) {
      fail('AUTOMATION_TRIAL_OWNER_CHANGED', '工程试跑不属于当前研究阶段。');
    }
    return { state, step };
  };
  const initial = await checkpoint();
  let entry = initial.step.codeTrials?.find(item => sourceHash(item.plan) === planSha256);
  if (initial.step.executionPlanBinding) {
    if (!entry?.runId) fail('AUTOMATION_TRIAL_RECEIPT_REQUIRED', '已消费计划缺少原工程试跑回执，不能重新试跑。');
    const completed = await readRun(projectId, entry.runId);
    await assertCompleted(projectId, completed, { sessionId: session.id, stage, plan });
    return completed;
  }
  if (!entry) {
    if (initial.step.codeTrials?.some(item => item.plan?.execution?.codePreparationId === plan.execution.codePreparationId)) {
      fail('AUTOMATION_TRIAL_INPUT_CHANGED', '同一代码版本已有不同试跑材料，请保留原试跑。');
    }
    const authorization = await createAuthorization(projectId, { sessionId: session.id, stage, plan });
    const { step } = await checkpoint();
    entry = { authorization, plan: structuredClone(plan), runId: null, status: 'prepared' };
    await saveStep({ codeTrials: [...(step.codeTrials || []), entry] });
  }
  const grantSha256 = sourceHash(entry.authorization);
  const guard = async () => {
    const { step } = await checkpoint();
    const saved = step.codeTrials?.find(item => sourceHash(item.authorization) === grantSha256);
    if (!saved || sourceHash(saved.plan) !== planSha256 || entry.runId && saved.runId !== entry.runId) {
      fail('AUTOMATION_TRIAL_INPUT_CHANGED', '原工程试跑授权或材料发生变化。');
    }
    return { step, saved };
  };
  const persist = async patch => {
    const { step, saved } = await guard();
    entry = { ...saved, ...patch };
    await saveStep({ codeTrials: step.codeTrials.map(item => sourceHash(item.authorization) === grantSha256 ? entry : item) });
  };
  let run;
  try {
    await guard();
    run = entry.runId ? await readRun(projectId, entry.runId)
      : await createRun(projectId, { authorization: entry.authorization, plan });
    if (entry.runId && run.id !== entry.runId) fail('AUTOMATION_TRIAL_RUN_CHANGED', '工程试跑不能更换已保存的原Run。');
    await assertRun(projectId, run.manifest);
    if (!entry.runId) await persist({ runId: run.id, status: 'awaiting_execution' });
    if (['running', 'created'].includes(run.status)) fail('AUTOMATION_TRIAL_UNRESOLVED', '工程试跑仍在运行或状态未确定，不会重复启动。');
    if (run.status === 'awaiting_approval') {
      await guard();
      run = await approve(projectId, run.id, session.id);
    }
    if (run.status === 'approved') {
      await guard();
      const manifestSha256 = experimentManifestHash(run.manifest);
      if (entry.manifestSha256 && entry.manifestSha256 !== manifestSha256) fail('AUTOMATION_TRIAL_MANIFEST_CHANGED', '已批准的工程试跑清单发生变化。');
      await persist({ status: 'executing', manifestSha256 });
      const executionBinding = { parentRunId: session.coordinatorRunId,
        policyVersion: String(entry.authorization.policyVersion), manifestSha256 };
      await onRun?.(run.id);
      try {
        run = await execute(projectId, run.id, { wait: true, signal, executionBinding,
          beforeLaunch: async () => { await guard(); await assertRun(projectId, run.manifest, { executionBinding }); },
          allowedPaths: entry.authorization.allowedPaths });
      } finally { await onRun?.(null); }
    }
    const result = experimentRunSummary(run);
    if (!result || result.supportsSuccessfulFinding) fail('AUTOMATION_TRIAL_RESULT_INVALID', '工程试跑不能作为科研成功结果。');
    await persist({ status: run.status, result });
    if (run.status !== 'completed') fail('AUTOMATION_TRIAL_FAILED', '工程试跑失败，实际日志和产物已保留；尚未绑定正式计划。');
    return run;
  } catch (error) {
    try { await persist({ error: { code: error.code || 'AUTOMATION_TRIAL_FAILED', message: error.message } }); } catch {}
    throw error;
  }
}
