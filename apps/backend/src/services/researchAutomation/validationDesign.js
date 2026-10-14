import { getResearchWorkflow } from '../researchWorkflow/queries.js';
import { getIdeaPlan } from '../researchWorkflow/ideaPlans.js';
import { ResearchWorkflowError } from '../researchWorkflow/errors.js';
import { resolveProjectRoot } from '../researchWorkflow/repository.js';
import { getHarnessRun, listHarnessRuns } from '../harnessRuntime/index.js';
import { snapshotExperimentCode } from '../experimentRunner/manifest.js';
import { runResearchStage } from '../researchResearch/harnessAdapter.js';
import { getResearchStageSchema } from '../researchResearch/schemas.js';
import { validateCampaignRequest } from '../validationCampaign/index.js';
import { sourceHash } from './handoff.js';
import { requireAutomatic } from './policy.js';
import { automationRole } from './agents.js';
import { createAutomationStageHarness } from './stageHarness.js';

const fail = (code, message, status = 409) => { throw new ResearchWorkflowError(status, code, message); };
export function validateValidationDesignInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['ideaId', 'expectedPlanRevision'].includes(key))
    || typeof input.ideaId !== 'string' || !input.ideaId || input.ideaId !== input.ideaId.trim() || input.ideaId.length > 200 || !input.ideaId.isWellFormed()
    || !Number.isSafeInteger(input.expectedPlanRevision) || input.expectedPlanRevision < 1) fail('VALIDATION_DESIGN_INPUT_INVALID', '请明确创新候选和当前方案版本；条件与参数由原阶段设计。', 400);
  return structuredClone(input);
}
function validateOutput(value, input) {
  const parsed = getResearchStageSchema('validation_design').safeParse(value);
  if (!parsed.success || parsed.data.ideaId !== input.ideaId) fail('VALIDATION_DESIGN_INVALID', '条件设计不符合固定候选或结构约束。');
  const output = parsed.data, evaluation = input.plan.evaluation;
  if (output.blockers.length && !output.seeds.length && !output.variants.length) return output;
  if (!output.implementationNotes.length) fail('VALIDATION_DESIGN_IMPLEMENTATION_REQUIRED', '请说明入口如何实际读取参数并实现各对照算法，名称不是实现证明。');
  validateCampaignRequest({ ideaId: input.ideaId, expectedPlanRevision: input.expectedPlanRevision, seeds: output.seeds, variants: output.variants });
  if (output.seeds.length !== evaluation.repetitions || output.seeds[0] !== evaluation.seed || output.seeds.length * output.variants.length > evaluation.budget.maxRuns) fail('VALIDATION_DESIGN_BUDGET_INVALID', '种子、重复次数或全部组别运行数偏离冻结方案。');
  for (const variant of output.variants) {
    if (variant.kind !== 'candidate' && !evaluation[variant.kind === 'baseline' ? 'baselines' : 'ablations'].includes(variant.label)) fail('VALIDATION_DESIGN_GROUP_INVALID', '设计组别不属于冻结基线或消融名单。');
    if (variant.kind !== 'candidate' && output.variants.some(candidate => candidate.kind === 'candidate'
      && sourceHash({ ...(input.executionPlan?.parameters || {}), ...candidate.parameters }) === sourceHash({ ...(input.executionPlan?.parameters || {}), ...variant.parameters }))) fail('VALIDATION_DESIGN_GROUP_INVALID', '对照或消融需明确不同参数，不能只更换标签。');
  }
  if (evaluation.baselines.some(label => !output.variants.some(variant => variant.kind === 'baseline' && variant.label === label))
    || evaluation.ablations.some(label => !output.variants.some(variant => variant.kind === 'ablation' && variant.label === label))) fail('VALIDATION_DESIGN_GROUP_INVALID', '设计未覆盖冻结方案的基线或消融。');
  return output;
}
function assertOwner(run, session, step, sourceInput) {
  if (run.projectId !== sourceInput.projectId || run.kind !== 'research-stage' || run.automationSessionId !== session.id || run.parentRunId !== session.coordinatorRunId
    || run.request?.task !== 'research:validation_design' || sourceHash(run.request.input) !== sourceHash(sourceInput)
    || sourceHash(run.request.context?.automationHandoff) !== sourceHash(step.handoff)) fail('VALIDATION_DESIGN_SOURCE_CHANGED', '原条件设计Run不属于当前候选、链路或交接。');
}
/** One original stage producer, with its inputs frozen across normal material preparation. */
export async function prepareValidationDesign({ projectId, session, policy, runtime = {}, beforeEffect = async () => {}, saveStep }) {
  const requested = validateValidationDesignInput(session.validationCampaignDesign), step = session.steps.find(item => item.stage === 'experiment');
  if (!step || !step.handoff || typeof saveStep !== 'function') fail('VALIDATION_DESIGN_HANDOFF_REQUIRED', '条件设计需要原实验阶段交接和保存入口。');
  const { plan } = await getIdeaPlan(projectId, requested.ideaId);
  if (plan && plan.revision !== requested.expectedPlanRevision) fail('VALIDATION_DESIGN_PLAN_CHANGED', '假设评价方案版本已变化。');
  if (!plan?.readiness.ready || plan.evaluation.researchType === 'theoretical') fail('VALIDATION_DESIGN_PLAN_NOT_READY', '需使用当前完整且可执行的假设评价方案。');
  const planSha256 = sourceHash(plan), guard = async () => {
    runtime.signal?.throwIfAborted(); await beforeEffect(); await requireAutomatic(projectId, 'experiment', session.id);
    const current = await getIdeaPlan(projectId, requested.ideaId);
    if (current.plan?.revision !== requested.expectedPlanRevision || sourceHash(current.plan) !== planSha256) fail('VALIDATION_DESIGN_PLAN_CHANGED', '原假设评价方案已变更，不能悄悄替换设计输入。');
  };
  await guard();
  if (step.validationDesign) {
    const saved = step.validationDesign;
    if (saved.ideaId !== requested.ideaId || saved.expectedPlanRevision !== requested.expectedPlanRevision || saved.planSha256 !== planSha256) fail('VALIDATION_DESIGN_PLAN_CHANGED', '已保存设计的方案版本发生变化。');
    const producer = await getHarnessRun(projectId, saved.sourceRunId); assertOwner(producer, session, step, saved.sourceInput);
    if (producer.status !== 'completed' || !step.calls?.some(call => call.runId === producer.id)) fail('VALIDATION_DESIGN_SOURCE_CHANGED', '已保存设计缺少原完成Run与阶段收据。');
    const output = validateOutput(producer.outputValidation?.data, saved.sourceInput);
    if (sourceHash(output) !== sourceHash(Object.fromEntries(['stage', 'ideaId', 'seeds', 'variants', 'implementationNotes', 'blockers'].map(key => [key, saved[key]])))) fail('VALIDATION_DESIGN_SOURCE_CHANGED', '已保存设计与原模型输出不一致。');
    return structuredClone(saved);
  }
  // Reuse persisted original inputs even if normal code/environment preparation has since filled material IDs.
  const listed = await listHarnessRuns(projectId, { parentRunId: session.coordinatorRunId, limit: 100 });
  if (listed.length === 100) fail('VALIDATION_DESIGN_UNRESOLVED', '原阶段Run列表不完整，不能重复设计。');
  const producers = listed.filter(run => run.automationSessionId === session.id && run.request?.task === 'research:validation_design');
  const inputs = new Set(producers.map(run => sourceHash(run.request.input)));
  if (inputs.size > 1) fail('VALIDATION_DESIGN_UNRESOLVED', '同一原阶段有多份不同设计输入，请先保留并对账。');
  let sourceInput;
  if (producers.length) {
    sourceInput = structuredClone(producers[0].request.input);
    if (sourceInput.ideaId !== requested.ideaId || sourceInput.expectedPlanRevision !== requested.expectedPlanRevision || sourceInput.planSha256 !== planSha256 || sourceHash(sourceInput.plan) !== planSha256) fail('VALIDATION_DESIGN_PLAN_CHANGED', '原模型设计输入中的方案版本已变化。');
    for (const producer of producers) assertOwner(producer, session, step, sourceInput);
  } else {
    const workflow = await getResearchWorkflow(projectId), experiment = workflow.stages.find(item => item.id === 'experiment')?.data || {};
    const executionPlan = session.executionPlan || experiment.executionPlan || experiment.experiment || experiment;
    const snapshot = await snapshotExperimentCode(await resolveProjectRoot(projectId), executionPlan.codePaths || []);
    sourceInput = { projectId, ...requested, planSha256, plan: structuredClone(plan), method: structuredClone(workflow.stages.find(item => item.id === 'method')?.data?.method || {}),
      executionPlan: structuredClone(executionPlan), codePreparation: { available: !!policy.codeScope, allowedPaths: policy.codeScope?.allowedPaths || [] },
      availableCode: { snapshotHash: snapshot.hash, files: snapshot.files.slice(0, 100).map(file => ({ path: file.path, sha256: file.sha256, bytes: file.bytes })) } };
  }
  const runHarness = createAutomationStageHarness({ projectId, session, stage: 'experiment', step, signal: runtime.signal, beforeEffect: guard, saveStep });
  const result = await runResearchStage({ projectId, stage: 'validation_design', workflowStage: 'experiment', input: sourceInput,
    role: automationRole('experiment', policy.agentMode), llmConfig: runtime.llmConfig, adapter: runtime.adapter,
    context: { automationHandoff: step.handoff }, ...runtime.testInput?.validation_design, runHarness });
  if (!result.ok) fail('VALIDATION_DESIGN_MODEL_FAILED', '条件设计模型未通过校验，原Run已保留。');
  const output = validateOutput(result.output, sourceInput), producer = await getHarnessRun(projectId, result.runId);
  assertOwner(producer, session, step, sourceInput);
  if (producer.status !== 'completed') fail('VALIDATION_DESIGN_SOURCE_CHANGED', '条件设计需来自原已完成模型Run。');
  const saved = { ...output, expectedPlanRevision: requested.expectedPlanRevision, planSha256, plan: structuredClone(plan), sourceRunId: producer.id,
    sourceInput, createdAt: new Date().toISOString() };
  await guard(); await saveStep({ validationDesign: saved }); return structuredClone(saved);
}
