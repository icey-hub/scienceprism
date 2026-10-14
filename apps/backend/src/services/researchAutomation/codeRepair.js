import { prepareAutomationTrial } from './trialPreparation.js';
import { prepareAutomationCode } from './codePreparation.js';
import { readAutomation } from './policy.js';
import { sourceHash } from './handoff.js';
import { codePreparationService } from '../experimentRunner/codePreparations.js';
import { getExperimentRun } from '../experimentRunner/index.js';
import { assertRepairableTrial } from '../experimentRunner/trialContext.js';
import { ResearchWorkflowError } from '../researchWorkflow/errors.js';

const fail = (code, message) => { throw new ResearchWorkflowError(409, code, message); };

/** One repair on the original stage ledger. Every resume reuses its persisted
 * producer and each code version has one trial; failures are never overwritten. */
export async function prepareAutomationCodeTrial(options, {
  trial = prepareAutomationTrial, prepareCode = prepareAutomationCode,
  readState = () => readAutomation(options.projectId), readRun = getExperimentRun,
  assertFailure = assertRepairableTrial, service = codePreparationService
} = {}) {
  const { projectId, session, stage, plan, beforeEffect } = options;
  try {
    await trial(options);
    return plan;
  } catch (error) {
    if (error.code !== 'AUTOMATION_TRIAL_FAILED') throw error;
  }
  await beforeEffect(); options.signal?.throwIfAborted();
  const state = await readState(), step = state.session?.steps?.find(item => item.stage === stage);
  const original = step?.codePreparations?.find(item => item.preparationId === plan.execution.codePreparationId);
  const failed = step?.codeTrials?.find(item => sourceHash(item.plan) === sourceHash(plan));
  if (!original || !failed?.runId) fail('AUTOMATION_CODE_REPAIR_SOURCE_REQUIRED', '需要原失败试跑与固定代码记录。');
  if (original.repairOf) fail('AUTOMATION_CODE_REPAIR_LIMIT', '自动修复后的试跑仍未通过，已保留两次运行记录。');
  const run = await readRun(projectId, failed.runId);
  const failure = await assertFailure(projectId, run, { sessionId: session.id, stage, plan });
  const previous = await service.verify(projectId, original.preparationId, original.sha256);
  const repairOf = { trialRunId: run.id, codePreparationId: original.preparationId, repairIndex: 1 };
  const { codePreparationVersion, ...baseInput } = structuredClone(original.input);
  const input = { ...baseInput, engineeringRepair: {
    repairIndex: 1, failure, originalAuthorization: original.authorization,
    sourceFiles: previous.files.map(({ path, content, sha256, baseVersion }) => ({ path, content, sha256, baseVersion }))
  } };
  // A policy change, cancellation, source edit or changed archive must stop the
  // original producer before another effect, including during a cold resume.
  const guard = async () => {
    await beforeEffect(); options.signal?.throwIfAborted();
    const actual = await assertFailure(projectId, await readRun(projectId, run.id), { sessionId: session.id, stage, plan });
    if (sourceHash(actual) !== sourceHash(failure)) fail('AUTOMATION_CODE_REPAIR_SOURCE_CHANGED', '原失败的日志或输入发生变化。');
  };
  const repaired = await prepareCode({ ...options, input, paths: original.paths, repairOf, beforeEffect: guard });
  const repairedPlan = { ...structuredClone(plan), execution: { ...plan.execution, codePreparationId: repaired.preparation.id } };
  await guard();
  await trial({ ...options, plan: repairedPlan });
  return repairedPlan;
}
