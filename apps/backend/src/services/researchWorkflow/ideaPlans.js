import { getResearchWorkflow } from './queries.js';
import { updateResearchWorkflow } from './commands.js';
import { ResearchWorkflowError } from './errors.js';
import { getExperimentRun } from '../experimentRunner/index.js';
import { datasetService } from '../datasets/index.js';
import { getHarnessRun } from '../harnessRuntime/index.js';
import { sourceHash } from '../researchAutomation/handoff.js';

const fail = (code, message, status = 400) => { throw new ResearchWorkflowError(status, code, message); };
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const string = (value, max = 4000) => typeof value === 'string' && value.isWellFormed() && value.length <= max;
function object(value, keys) { if (!plain(value) || Object.keys(value).some(key => !keys.includes(key))) fail('IDEA_PLAN_INPUT_INVALID', '方案字段无效。'); }
function text(value, max) { if (!string(value, max)) fail('IDEA_PLAN_INPUT_INVALID', '请使用合理长度的方案文字。'); return value.trim(); }
function list(value) {
  if (!Array.isArray(value) || value.length > 30 || value.some(item => !string(item, 500))) fail('IDEA_PLAN_INPUT_INVALID', '基线和消融各最多30条，每条不超过500字。');
  return [...new Set(value.map(item => item.trim()).filter(Boolean))];
}
function optionalNumber(value, max, integer = false) {
  if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > max || integer && !Number.isInteger(value))) fail('IDEA_PLAN_INPUT_INVALID', '重复次数及预算需为有效正数，未知时使用null。');
  return value;
}
function validate(input) {
  object(input, ['expectedRevision', 'hypothesis', 'evaluation', 'replicationRunId']);
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) fail('IDEA_PLAN_REVISION_REQUIRED', '请提供当前方案版本。');
  object(input.hypothesis, ['problem', 'prediction', 'priorWork', 'conditions', 'falsificationCondition']);
  const hypothesis = Object.fromEntries(['problem', 'prediction', 'priorWork', 'conditions', 'falsificationCondition'].map(key => [key, text(input.hypothesis[key], 4000)]));
  const value = input.evaluation;
  object(value, ['researchType', 'dataset', 'datasetVersion', 'seed', 'split', 'baselines', 'metrics', 'repetitions', 'ablations', 'budget']);
  if (!['empirical', 'computational', 'theoretical'].includes(value.researchType) || !Array.isArray(value.metrics) || value.metrics.length > 30) fail('IDEA_PLAN_INPUT_INVALID', '请选择研究类型，指标最多30条。');
  const metrics = value.metrics.map(metric => {
    object(metric, ['name', 'direction', 'threshold']);
    if (!['increase', 'decrease', 'target'].includes(metric.direction) || metric.threshold !== null && (typeof metric.threshold !== 'number' || !Number.isFinite(metric.threshold) || Math.abs(metric.threshold) > 1e100)) fail('IDEA_PLAN_INPUT_INVALID', '指标方向和数值阈值无效。');
    return { name: text(metric.name, 200), direction: metric.direction, threshold: metric.threshold };
  });
  const names = metrics.map(metric => metric.name).filter(Boolean);
  if (new Set(names).size !== names.length) fail('IDEA_PLAN_INPUT_INVALID', '评价指标名称不能重复。');
  object(value.budget, ['maxRuns', 'maxSeconds']);
  const evaluation = { researchType: value.researchType, dataset: text(value.dataset, 500), datasetVersion: text(value.datasetVersion, 500), seed: text(value.seed ?? '', 100),
    split: text(value.split, 4000), baselines: list(value.baselines), metrics, repetitions: optionalNumber(value.repetitions, 1000, true), ablations: list(value.ablations),
    budget: { maxRuns: optionalNumber(value.budget.maxRuns, 10000, true), maxSeconds: optionalNumber(value.budget.maxSeconds, 86400) } };
  if (input.replicationRunId !== undefined && (!string(input.replicationRunId, 200) || !input.replicationRunId.trim())) fail('IDEA_PLAN_SOURCE_INVALID', '请选择明确的复现运行。');
  return { ...input, hypothesis, evaluation };
}
function historyFor(workflow, ideaId) {
  if (!string(ideaId, 200) || !ideaId || ['__proto__', 'prototype', 'constructor'].includes(ideaId)) fail('IDEA_PLAN_ID_INVALID', '创新候选标识无效。');
  const stage = workflow.stages.find(item => item.id === 'ideation');
  const matches = (stage?.data?.ideas || []).filter(idea => String(idea.id) === ideaId);
  if (matches.length !== 1) fail('IDEA_PLAN_NOT_FOUND', '请选择原创新阶段中的唯一候选。', 404);
  const history = stage.data.ideaPlans && Object.hasOwn(stage.data.ideaPlans, ideaId) ? stage.data.ideaPlans[ideaId] : [];
  if (!Array.isArray(history) || history.some((plan, index) => plan.ideaId !== ideaId || plan.revision !== index + 1)) fail('IDEA_PLAN_HISTORY_CORRUPT', '方案历史版本不一致，请保留原数据。', 500);
  return history;
}
async function readiness(projectId, hypothesis, evaluation) {
  const issues = [];
  for (const [key, label] of Object.entries({ problem: '问题', prediction: '可检验预测', priorWork: '已有工作与区别', conditions: '适用条件', falsificationCondition: '反例或证伪条件' })) if (!hypothesis[key]) issues.push(`请补充${label}。`);
  if (!evaluation.dataset || !evaluation.datasetVersion) issues.push('请选择本项目的固定数据及版本。');
  else {
    try { const data = await datasetService.get(projectId, evaluation.dataset); if (data.sha256 !== evaluation.datasetVersion) issues.push('数据版本与本项目固定SHA不一致。'); }
    catch { issues.push('本项目尚无可读取的固定数据版本。'); }
  }
  if (!evaluation.seed) issues.push('请填写随机种子，0也是有效种子。');
  if (!evaluation.split) issues.push('请写明数据划分或评价样本范围。');
  if (!evaluation.baselines.length) issues.push('请填写比较基线。');
  if (!evaluation.metrics.length || evaluation.metrics.some(metric => !metric.name || metric.threshold === null)) issues.push('请为评价指标填写名称、方向和数值阈值。');
  if (evaluation.repetitions === null) issues.push('请填写重复次数。');
  if (evaluation.budget.maxRuns === null || evaluation.budget.maxSeconds === null) issues.push('请填写运行次数和时间预算。');
  if (evaluation.repetitions !== null && evaluation.budget.maxRuns !== null && evaluation.budget.maxRuns < evaluation.repetitions) issues.push('运行次数预算少于重复次数。');
  if (evaluation.researchType === 'theoretical') issues.push('理论研究方案当前不能直接在Experiment Runner执行。');
  return { ready: issues.length === 0, issues };
}

export async function getIdeaPlan(projectId, ideaId) {
  const history = historyFor(await getResearchWorkflow(projectId), ideaId);
  return structuredClone({ plan: history.at(-1) || null, history });
}

export async function saveIdeaPlan(projectId, ideaId, input, { actor = 'human' } = {}) {
  if (actor !== 'human') fail('HUMAN_INPUT_REQUIRED', '本入口只保存人工方案。', 403);
  return persistIdeaPlan(projectId, ideaId, input, { actor });
}

export async function saveGeneratedIdeaPlan(projectId, ideaId, input, { sourceRunId, relatedWork, candidateSha256, generationIssue, beforeEffect = async () => {} } = {}) {
  return persistIdeaPlan(projectId, ideaId, input, { actor: 'ai', sourceRunId, relatedWork, candidateSha256, generationIssue, beforeEffect });
}

async function persistIdeaPlan(projectId, ideaId, input, { actor, sourceRunId, relatedWork, candidateSha256, generationIssue, beforeEffect = async () => {} }) {
  const validated = validate(input);
  const options = { actor, stageId: 'ideation', data: {}, beforeCommit: async workflow => {
    await beforeEffect();
    const history = historyFor(workflow, ideaId), previous = history.at(-1);
    if (validated.expectedRevision !== (previous?.revision || 0)) fail('IDEA_PLAN_CONFLICT', '方案已更新，请刷新后保存；原版本不会被覆盖。', 409);
    if (history.length >= 100) fail('IDEA_PLAN_HISTORY_LIMIT', '已保留100个方案版本，请保留历史后使用新候选。', 409);
    let producer;
    if (actor === 'ai') {
      const idea = workflow.stages.find(stage => stage.id === 'ideation').data.ideas.find(idea => String(idea.id) === ideaId);
      if (workflow.currentStage !== 'ideation' || workflow.status === 'completed' || sourceHash(idea) !== candidateSha256) fail('IDEA_PLAN_CANDIDATE_CHANGED', '创新候选或当前阶段已变化，模型结果已保留。', 409);
      producer = await getHarnessRun(projectId, sourceRunId);
      if (producer.projectId !== projectId || producer.status !== 'completed' || producer.request?.task !== 'research:hypothesis_plan'
        || sourceHash(producer.request?.input?.idea) !== candidateSha256 || producer.request?.input?.ideaId !== ideaId || producer.request.input.expectedRevision !== validated.expectedRevision
        || sourceHash(producer.request.input.relatedWork) !== sourceHash(relatedWork)) fail('IDEA_PLAN_GENERATION_SOURCE_INVALID', '生成方案缺少本项目已完成的原模型来源。', 409);
    }
    let evidence = previous?.evidence || null;
    if (validated.replicationRunId !== undefined) {
      let run;
      try { run = await getExperimentRun(projectId, validated.replicationRunId); }
      catch { fail('IDEA_PLAN_SOURCE_INVALID', '本项目没有可读取的所选复现记录。', 409); }
      if (run.status !== 'completed' || run.manifest?.purpose === 'engineering-trial' || run.purpose === 'engineering-trial'
        || run.manifest?.replication?.projectId !== projectId || run.manifest.replication.sourceStage !== 'replication' || !run.paperComparison) fail('IDEA_PLAN_SOURCE_INVALID', '需选择本项目已完成的正式复现及其论文对比记录。', 409);
      const comparison = run.paperComparison;
      if (evidence && (evidence.runId !== run.id || JSON.stringify(evidence.paper) !== JSON.stringify(comparison.paper))) fail('IDEA_PLAN_SOURCE_CHANGED', '此候选已有固定复现来源，请保留原来源并另建候选讨论其它来源。', 409);
      evidence = { runId: run.id, comparisonRevision: comparison.revision, paper: structuredClone(comparison.paper), rows: structuredClone(comparison.rows) };
    }
    if (actor === 'ai' && sourceHash(producer.request.input.replicationEvidence ?? null) !== sourceHash(evidence)) fail('IDEA_PLAN_SOURCE_CHANGED', '复现对比已更新，原模型结果已保留，请使用最新证据重新生成。', 409);
    const plan = { ideaId, revision: validated.expectedRevision + 1, createdAt: new Date().toISOString(), actor,
      hypothesis: validated.hypothesis, evaluation: validated.evaluation, readiness: await readiness(projectId, validated.hypothesis, validated.evaluation), evidence };
    if (actor === 'ai') {
      plan.sourceRunId = sourceRunId; plan.relatedWork = structuredClone(relatedWork);
      if (generationIssue || relatedWork.status === 'failed') {
        plan.generationIssue = generationIssue || '相近工作检索全部失败，未确认新颖性。';
        plan.readiness.ready = false; plan.readiness.issues.push(plan.generationIssue);
      }
    } else if (previous?.relatedWork) {
      plan.relatedWork = structuredClone(previous.relatedWork);
      if (previous.sourceRunId || previous.generatedFromRunId) plan.generatedFromRunId = previous.sourceRunId || previous.generatedFromRunId;
    }
    options.data = { ideaPlans: { [ideaId]: [...history, plan] } };
  } };
  const workflow = await updateResearchWorkflow(projectId, options), history = historyFor(workflow, ideaId);
  return structuredClone({ plan: history.at(-1), history });
}

export { validate as validateIdeaPlanInput, readiness as getIdeaPlanReadiness, historyFor as ideaPlanHistoryFor };
