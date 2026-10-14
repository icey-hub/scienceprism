import { sourceHash } from '../researchAutomation/handoff.js';
import { readAutomation } from '../researchAutomation/policy.js';
import { inspectAutomationOwner } from '../researchAutomation/owner.js';
import { readHarnessRuns, resolveHarnessProjectRoot } from '../harnessRuntime/repository.js';
import { getHarnessRun } from '../harnessRuntime/index.js';
import { getResearchStageSchema } from '../researchResearch/schemas.js';
import { readExperimentRuns } from '../experimentRunner/repository.js';
import { readCampaignWritingHandoff } from './campaignWritingHandoff.js';
import { validateIdeaPlanInput, getIdeaPlanReadiness, ideaPlanHistoryFor } from './ideaPlans.js';
import { getResearchWorkflow } from './queries.js';
import { mutateWorkflow, fingerprint } from './commands.js';
import { createWorkflowDocument } from './stateMachine.js';
import { appendAudit } from './audit.js';
import { ResearchWorkflowError } from './errors.js';

export const revisionFail = (code, message, status = 409, details) => { throw new ResearchWorkflowError(status, code, message, details); };
const id = value => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 200 && value.isWellFormed() && !/[\x00-\x1f\x7f]/.test(value);
export function validateNextPlanRequest(input, { manual = false } = {}) {
  const fields = ['expectedVersion', 'expectedRevision', 'campaignId', 'evaluationRunId', 'suggestionIndexes', 'idempotencyKey', ...(manual ? ['hypothesis', 'evaluation'] : [])];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !fields.includes(key))
    || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1 || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1
    || !id(input.campaignId) || !id(input.evaluationRunId) || !id(input.idempotencyKey) || input.idempotencyKey.length > 100
    || !Array.isArray(input.suggestionIndexes) || !input.suggestionIndexes.length || input.suggestionIndexes.length > 20
    || input.suggestionIndexes.some(index => !Number.isSafeInteger(index) || index < 0 || index > 19) || new Set(input.suggestionIndexes).size !== input.suggestionIndexes.length) revisionFail('IDEA_PLAN_REVISION_INPUT_INVALID', '请提供阶段/方案版本、明确批次/评价、所选建议及幂等键；生成来源由服务器绑定。', 400);
  if (manual) validateIdeaPlanInput({ expectedRevision: input.expectedRevision, hypothesis: input.hypothesis, evaluation: input.evaluation });
  return structuredClone(input);
}
export const revisionReceiptKey = (projectId, ideaId, key) => `idea-plan-revision-${sourceHash({ projectId, ideaId, key })}`;
export function revisionReplay(workflow, projectId, ideaId, input, command) {
  const receipt = workflow.commandReceipts?.[revisionReceiptKey(projectId, ideaId, input.idempotencyKey)];
  if (!receipt) return null;
  if (receipt.command !== command || receipt.fingerprint !== fingerprint(command, { ideaId, input })) revisionFail('IDEMPOTENCY_KEY_REUSED', '同一幂等键不能用于不同参数或不同保存方式。');
  const history = ideaPlanHistoryFor(workflow, ideaId), plan = history.find(plan => plan.revisionSource?.idempotencyKey === input.idempotencyKey);
  if (!plan) revisionFail('IDEA_PLAN_REVISION_RECEIPT_INVALID', '已保存命令缺少对应方案版本，不会重复生成。');
  return structuredClone({ plan, history, workflowVersion: workflow.version });
}
export async function assertIdeaPlanRevisionIdle(projectId, { allowRunId } = {}) {
  const root = await resolveHarnessProjectRoot(projectId), state = await readAutomation(projectId), owner = inspectAutomationOwner({ projectRoot: root });
  if (owner && !owner.released || state.session && !['completed', 'stopped'].includes(state.session.status)) revisionFail('IDEA_PLAN_ATTEMPT_ACTIVE', '请先结束或停止原自动链路，并确认进程停止后再形成新版本。');
  const runs = (await readHarnessRuns(root, projectId)).runs;
  if (runs.some(run => run.cleanup?.modelSlotRetained || run.id !== allowRunId && run.kind !== 'research-coordinator' && ['created', 'running', 'paused'].includes(run.status))) revisionFail('IDEA_PLAN_ATTEMPT_ACTIVE', '已有模型任务活动或停止状态未确认，新版本不会并发派发。');
  for (const run of (await readExperimentRuns(root, projectId)).runs) {
    const processState = run.execution?.process;
    if (run.status === 'running' || processState && !processState.stopConfirmed) revisionFail('IDEA_PLAN_ATTEMPT_ACTIVE', '原实验进程未确认停止。');
    if (processState?.pid) { try { process.kill(processState.pid, 0); revisionFail('IDEA_PLAN_ATTEMPT_ACTIVE', '原实验进程仍存在。'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
  }
  return state;
}
export async function prepareIdeaPlanRevision(projectId, ideaId, input, { allowRunId } = {}) {
  const workflow = await getResearchWorkflow(projectId), history = ideaPlanHistoryFor(workflow, ideaId), previousPlan = history.at(-1);
  if (workflow.version !== input.expectedVersion) revisionFail('VERSION_CONFLICT', '研究阶段已更新，请刷新后生成或保存。');
  if (previousPlan?.revision !== input.expectedRevision) revisionFail('IDEA_PLAN_CONFLICT', '方案版本已更新，原版本不会覆盖。');
  if (workflow.currentStage !== 'writing') revisionFail('IDEA_PLAN_REVISION_STAGE_REQUIRED', '请在本轮写作阶段结束或停止链路后形成下一版方案。');
  await assertIdeaPlanRevisionIdle(projectId, { allowRunId });
  let material;
  try { material = await readCampaignWritingHandoff(projectId, input.campaignId, input.evaluationRunId); }
  catch (error) { if (!(error instanceof ResearchWorkflowError) && Number.isInteger(error.statusCode) && typeof error.code === 'string') throw new ResearchWorkflowError(error.statusCode, error.code, error.message, error.details); throw error; }
  if (material.ideaId !== ideaId || material.agentEvaluation?.runId !== input.evaluationRunId) revisionFail('IDEA_PLAN_REVISION_SOURCE_INVALID', '所选评价和批次必须来自当前候选。');
  const suggestions = input.suggestionIndexes.map(index => material.agentEvaluation.output.nextPlanSuggestions[index]);
  if (suggestions.some(value => typeof value !== 'string')) revisionFail('IDEA_PLAN_REVISION_SOURCE_INVALID', '所选建议不在原评价中。');
  const revisionSource = { campaignId: material.campaignId, evaluationRunId: input.evaluationRunId, sourceSha256: material.sourceSha256,
    evaluatedPlanRevision: material.planRevision, suggestionIndexes: [...input.suggestionIndexes], suggestions, idempotencyKey: input.idempotencyKey };
  const idea = workflow.stages.find(stage => stage.id === 'ideation').data.ideas.find(idea => String(idea.id) === ideaId);
  return { workflow, previousPlan, idea: structuredClone(idea), material, revisionSource };
}
async function appendVersion(projectId, ideaId, input, { actor, sourceRunId, expectedSource, generationIssue } = {}) {
  const command = actor === 'ai' ? 'generate-next-idea-plan' : 'next-idea-plan', validated = validateIdeaPlanInput({ expectedRevision: input.expectedRevision, hypothesis: input.hypothesis, evaluation: input.evaluation });
  const payload = { ideaId, input: actor === 'ai' ? input.generationRequest : input };
  const workflow = await mutateWorkflow(projectId, { command, actor, expectedVersion: input.expectedVersion, idempotencyKey: revisionReceiptKey(projectId, ideaId, input.idempotencyKey), payload,
    mutate: async workflow => {
      const prepared = await prepareIdeaPlanRevision(projectId, ideaId, input), history = ideaPlanHistoryFor(workflow, ideaId);
      if (expectedSource && sourceHash(prepared.revisionSource) !== sourceHash(expectedSource)) revisionFail('IDEA_PLAN_REVISION_SOURCE_CHANGED', '生成所依据的完整批次或建议来源已变化，原模型Run保留。');
      if (history.length >= 100) revisionFail('IDEA_PLAN_HISTORY_LIMIT', '已保留100版方案，不会删除旧版腾出空间。');
      if (actor === 'ai') {
        const producer = await getHarnessRun(projectId, sourceRunId), output = getResearchStageSchema('hypothesis_plan').safeParse(producer.outputValidation?.data);
        if (producer.projectId !== projectId || producer.status !== 'completed' || producer.request?.source !== 'idea-plan-revision' || producer.task !== 'research:hypothesis_plan'
          || producer.request.revisionIdentity?.requestSha256 !== sourceHash({ projectId, ideaId, input: input.generationRequest })
          || sourceHash(producer.request.input?.revisionSource || null) !== sourceHash(prepared.revisionSource) || !output.success || output.data.ideaId !== ideaId) revisionFail('IDEA_PLAN_REVISION_PRODUCER_INVALID', 'AI新版缺少真实完成Run、原请求及结构方案来源。');
        const proposed = structuredClone(output.data);
        if ((proposed.evaluation.dataset || proposed.evaluation.datasetVersion) && !(producer.request.input.availableDatasets || []).some(data => data.id === proposed.evaluation.dataset && data.sha256 === proposed.evaluation.datasetVersion)) {
          proposed.evaluation.dataset = ''; proposed.evaluation.datasetVersion = '';
        }
        const expected = validateIdeaPlanInput({ expectedRevision: input.expectedRevision, hypothesis: proposed.hypothesis, evaluation: proposed.evaluation });
        if (sourceHash(expected.hypothesis) !== sourceHash(validated.hypothesis) || sourceHash(expected.evaluation) !== sourceHash(validated.evaluation)) revisionFail('IDEA_PLAN_REVISION_PRODUCER_INVALID', '保存方案不得替换原模型输出。');
      }
      const previous = history.at(-1), plan = { ideaId, revision: input.expectedRevision + 1, createdAt: new Date().toISOString(), actor,
        hypothesis: validated.hypothesis, evaluation: validated.evaluation, readiness: await getIdeaPlanReadiness(projectId, validated.hypothesis, validated.evaluation),
        evidence: structuredClone(previous.evidence || null), revisionSource: prepared.revisionSource };
      if (previous.relatedWork) plan.relatedWork = structuredClone(previous.relatedWork);
      if (actor === 'ai') { plan.sourceRunId = sourceRunId; plan.generationLimitations = ['仅沿用原相关工作与批次来源，没有新检索或新颖性验证。', '预算和下一尝试均为建议，尚未授权执行。']; }
      else if (previous.sourceRunId || previous.generatedFromRunId) plan.generatedFromRunId = previous.sourceRunId || previous.generatedFromRunId;
      if (generationIssue) { plan.generationIssue = generationIssue; plan.readiness.ready = false; plan.readiness.issues.push(generationIssue); }
      workflow.stages.find(stage => stage.id === 'ideation').data.ideaPlans[ideaId] = [...history, plan];
      appendAudit(workflow, 'idea-plan.next-version', { actor, stageId: 'ideation', details: { ideaId, revision: plan.revision, sourceRunId: sourceRunId || null, revisionSource: plan.revisionSource } });
      return workflow;
    } });
  const history = ideaPlanHistoryFor(workflow, ideaId), plan = history.find(plan => plan.revisionSource?.idempotencyKey === input.idempotencyKey);
  return structuredClone({ plan, history, workflowVersion: workflow.version });
}
export async function saveNextIdeaPlan(projectId, ideaId, input, { actor = 'human' } = {}) {
  if (actor !== 'human') revisionFail('HUMAN_INPUT_REQUIRED', '只有人工可保存下一版方案。', 403);
  const normalized = validateNextPlanRequest(input, { manual: true }), workflow = await getResearchWorkflow(projectId);
  const repeated = revisionReplay(workflow, projectId, ideaId, normalized, 'next-idea-plan'); if (repeated) return repeated;
  return appendVersion(projectId, ideaId, normalized, { actor });
}
export async function saveGeneratedNextIdeaPlan(projectId, ideaId, input, { sourceRunId, expectedSource, generationRequest, generationIssue } = {}) {
  return appendVersion(projectId, ideaId, { ...input, generationRequest }, { actor: 'ai', sourceRunId, expectedSource, generationIssue });
}
export async function getIdeaPlanAttempts(projectId, ideaId) {
  const workflow = await getResearchWorkflow(projectId); ideaPlanHistoryFor(workflow, ideaId);
  const attempts = (workflow.planAttempts || []).filter(attempt => attempt.ideaId === ideaId);
  return structuredClone({ attempts, workflowVersion: workflow.version, ...(workflow.activePlanAttempt?.ideaId === ideaId ? { activeAttemptId: workflow.activePlanAttempt.id } : {}) });
}
export async function startIdeaPlanAttempt(projectId, ideaId, revision, input, { actor = 'human' } = {}) {
  if (actor !== 'human') revisionFail('HUMAN_INPUT_REQUIRED', '下一尝试必须由人工明确确认。', 403);
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['expectedVersion', 'idempotencyKey'].includes(key))
    || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1 || !Number.isSafeInteger(revision) || revision < 1 || !id(input.idempotencyKey) || input.idempotencyKey.length > 100) revisionFail('IDEA_PLAN_ATTEMPT_INPUT_INVALID', '请指定当前研究版本和唯一下一尝试请求。', 400);
  const attemptId = `plan-attempt-${sourceHash({ projectId, ideaId, revision, idempotencyKey: input.idempotencyKey }).slice(0, 32)}`;
  const workflow = await mutateWorkflow(projectId, { command: 'start-idea-plan-attempt', actor, expectedVersion: input.expectedVersion, idempotencyKey: `next-attempt-${sourceHash({ ideaId, key: input.idempotencyKey })}`, payload: { ideaId, revision, input },
    mutate: async workflow => {
      const history = ideaPlanHistoryFor(workflow, ideaId), plan = history.at(-1);
      if (plan?.revision !== revision || !plan.revisionSource) revisionFail('IDEA_PLAN_CONFLICT', '仅能明确确认最新、具有真实评价来源的新方案。');
      const sourceInput = { ...plan.revisionSource, expectedVersion: workflow.version, expectedRevision: revision };
      const prepared = await prepareIdeaPlanRevision(projectId, ideaId, sourceInput);
      if (sourceHash(prepared.revisionSource) !== sourceHash(plan.revisionSource)) revisionFail('IDEA_PLAN_REVISION_SOURCE_CHANGED', '原评价来源已变化，请保留旧版而不是替换来源。');
      if (!(await getIdeaPlanReadiness(projectId, plan.hypothesis, plan.evaluation)).ready || !plan.readiness.ready) revisionFail('IDEA_PLAN_ATTEMPT_NOT_READY', '请先补齐并审阅最新假设、固定数据版本及预算。');
      const attempts = workflow.planAttempts || [];
      if (Buffer.byteLength(JSON.stringify({ attempts, stages: workflow.stages.filter(stage => ['method', 'experiment', 'writing'].includes(stage.id)) })) > 20 * 1024 * 1024) revisionFail('IDEA_PLAN_ATTEMPT_HISTORY_LIMIT', '尝试历史超过20MiB，保留旧记录并拒绝继续归档。');
      if (attempts.length >= 100) revisionFail('IDEA_PLAN_ATTEMPT_HISTORY_LIMIT', '已保留100次历史尝试，不能删除旧记录继续。');
      if (attempts.some(attempt => attempt.ideaId === ideaId && attempt.planRevision === revision)) revisionFail('IDEA_PLAN_ATTEMPT_EXISTS', '该方案版本已有明确尝试，请查看原尝试。');
      const old = await assertIdeaPlanRevisionIdle(projectId), defaults = createWorkflowDocument(projectId).stages;
      const attempt = { id: attemptId, ideaId, planRevision: revision, planSha256: sourceHash(plan), source: structuredClone(plan.revisionSource), createdAt: new Date().toISOString(), actor,
        idempotencyKey: input.idempotencyKey, fromWorkflowVersion: workflow.version, previousStages: structuredClone(workflow.stages.filter(stage => ['method', 'experiment', 'writing'].includes(stage.id))),
        previousAutomation: old.session ? { sessionId: old.session.id, coordinatorRunId: old.session.coordinatorRunId || null, status: old.session.status } : null };
      workflow.planAttempts = [...attempts, attempt]; workflow.activePlanAttempt = { id: attempt.id, ideaId, planRevision: revision, planSha256: attempt.planSha256 };
      workflow.stages = workflow.stages.map(stage => ['method', 'experiment', 'writing'].includes(stage.id) ? structuredClone(defaults.find(value => value.id === stage.id)) : stage);
      const method = workflow.stages.find(stage => stage.id === 'method'); method.status = 'in_progress'; method.startedAt = attempt.createdAt;
      workflow.currentStage = 'method'; workflow.status = 'in_progress';
      appendAudit(workflow, 'idea-plan.next-attempt', { actor, stageId: 'method', details: { attemptId, ideaId, planRevision: revision, source: attempt.source, budget: plan.evaluation.budget, permission: 'plan-only-no-execution' } });
      return workflow;
    } });
  return structuredClone({ workflow, attempt: workflow.planAttempts.find(attempt => attempt.id === attemptId) });
}
