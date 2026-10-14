import { sourceHash } from '../researchAutomation/handoff.js';
import { readAutomation, requireAutomatic } from '../researchAutomation/policy.js';
import { getResearchWorkflow } from '../researchWorkflow/queries.js';
import { getIdeaPlan } from '../researchWorkflow/ideaPlans.js';
import { ResearchWorkflowError } from '../researchWorkflow/errors.js';
import { assertExperimentPlanUnchangedFromWorkflow } from '../experimentRunner/replicationContext.js';
import { experimentManifestHash } from '../experimentRunner/manifest.js';
import { readExperimentRuns, resolveExperimentProjectRoot } from '../experimentRunner/repository.js';
import { createCampaignExperimentRun, automaticallyApproveExperiment, startExperimentRun, cancelExperimentRun, getExperimentRun, experimentRunSummary } from '../experimentRunner/index.js';
import { getEvidenceLedger } from '../evidenceLedger/index.js';
import { readCampaigns, mutateCampaigns } from './repository.js';

const fail = (code, message, status = 409) => { throw new ResearchWorkflowError(status, code, message); };
const terminal = new Set(['completed', 'failed', 'cancelled', 'rejected']);
const text = (value, max) => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= max && value.isWellFormed();
const stamp = () => new Date().toISOString();
export function validateCampaignRequest(input) {
  if (!input || Object.keys(input).some(key => !['ideaId', 'expectedPlanRevision', 'seeds', 'variants'].includes(key))
    || !text(input.ideaId, 200) || !Number.isSafeInteger(input.expectedPlanRevision) || input.expectedPlanRevision < 1
    || !Array.isArray(input.seeds) || !input.seeds.length || input.seeds.length > 20 || input.seeds.some(seed => !text(seed, 100)) || new Set(input.seeds).size !== input.seeds.length
    || !Array.isArray(input.variants) || !input.variants.length || input.variants.length > 20 || input.variants.length * input.seeds.length > 20) fail('VALIDATION_CAMPAIGN_INPUT_INVALID', '请明确方案版本、原运行、种子及最多20项试验。', 400);
  for (const variant of input.variants) {
    if (!variant || Object.keys(variant).some(key => !['id', 'label', 'kind', 'parameters'].includes(key)) || !text(variant.id, 100) || !text(variant.label, 500)
      || !['candidate', 'baseline', 'ablation'].includes(variant.kind) || !variant.parameters || typeof variant.parameters !== 'object' || Array.isArray(variant.parameters)
      || Object.keys(variant.parameters).length > 30 || Object.entries(variant.parameters).some(([key, value]) => !/^[A-Za-z][A-Za-z0-9_.-]{0,99}$/.test(key) || ['constructor', 'prototype', '__proto__'].includes(key)
        || !(value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e100 || typeof value === 'string' && value.isWellFormed() && value.length <= 1000))) fail('VALIDATION_CAMPAIGN_VARIANT_INVALID', '每组必须明确名称、类型及有限的实际参数；标签不会自动实现对照。', 400);
  }
  if (new Set(input.variants.map(variant => variant.id)).size !== input.variants.length || !input.variants.some(variant => variant.kind === 'candidate') || !input.variants.some(variant => variant.kind === 'baseline')) fail('VALIDATION_CAMPAIGN_VARIANT_INVALID', '组别标识须唯一，且至少包含候选方法和比较基线。', 400);
  return structuredClone(input);
}
export async function getValidationCampaign(projectId, campaignId) {
  const campaign = (await readCampaigns(projectId)).campaigns.find(item => item.id === campaignId);
  if (!campaign) fail('VALIDATION_CAMPAIGN_NOT_FOUND', '本项目没有该创新试验批次。', 404);
  return structuredClone(campaign);
}
export async function listValidationCampaigns(projectId, { ideaId } = {}) {
  return structuredClone((await readCampaigns(projectId)).campaigns.filter(item => !ideaId || item.ideaId === ideaId));
}
async function assertSource(projectId, campaign) {
  const authorization = await requireAutomatic(projectId, 'execution', campaign.sessionId), automation = await readAutomation(projectId);
  const step = automation.session.steps.find(item => item.stage === 'experiment');
  if (automation.session.workflowId !== campaign.researchContext.workflowId || step?.experimentRunId !== campaign.baseRunId
    || authorization.policyVersion !== campaign.policyVersion) fail('VALIDATION_CAMPAIGN_OWNER_CHANGED', '原研究链路、执行授权或材料锚点已变化。');
  const current = await getIdeaPlan(projectId, campaign.ideaId);
  if (current.plan?.revision !== campaign.planRevision || sourceHash(current.plan) !== campaign.planSha256) fail('VALIDATION_CAMPAIGN_PLAN_CHANGED', '假设评价方案已更新，请保留原批次并重新评审。');
  const workflow = await getResearchWorkflow(projectId);
  assertExperimentPlanUnchangedFromWorkflow(projectId, workflow, campaign.researchContext);
  const base = (await readExperimentRuns(await resolveExperimentProjectRoot(projectId), projectId)).runs.find(run => run.id === campaign.baseRunId);
  if (!base || !['awaiting_approval', 'approved'].includes(base.status) || base.execution || experimentManifestHash(base.manifest) !== campaign.baseManifestSha256) fail('VALIDATION_CAMPAIGN_BASE_CHANGED', '原材料运行已执行或被修改，不能更换冻结来源。');
  return authorization;
}
export async function ensureValidationCampaign(projectId, input) {
  if (!input || Object.keys(input).some(key => !['sessionId', 'ideaId', 'expectedPlanRevision', 'baseRunId', 'seeds', 'variants'].includes(key)) || !text(input.sessionId, 200) || !text(input.baseRunId, 200)) fail('VALIDATION_CAMPAIGN_INPUT_INVALID', '需绑定原研究链路和材料运行。', 400);
  validateCampaignRequest(Object.fromEntries(['ideaId', 'expectedPlanRevision', 'seeds', 'variants'].map(key => [key, input[key]])));
  return mutateCampaigns(projectId, async document => {
    const id = `validation-campaign-${sourceHash({ projectId, sessionId: input.sessionId, ideaId: input.ideaId, baseRunId: input.baseRunId }).slice(0, 32)}`;
    const existing = document.campaigns.find(item => item.id === id);
    if (existing) {
      if (existing.inputSha256 !== sourceHash(input)) fail('VALIDATION_CAMPAIGN_CHANGED', '原批次组别或种子已冻结，不能在恢复时替换。');
      await assertSource(projectId, existing); return existing;
    }
    const { plan } = await getIdeaPlan(projectId, input.ideaId), base = await getExperimentRun(projectId, input.baseRunId);
    if (!plan?.readiness.ready || plan.revision !== input.expectedPlanRevision || plan.evaluation.researchType === 'theoretical') fail('VALIDATION_CAMPAIGN_PLAN_NOT_READY', '请使用字段齐全且可运行的当前假设评价方案。');
    if (!base.manifest?.researchPlan || base.manifest.purpose || base.manifest.campaign || !['awaiting_approval', 'approved'].includes(base.status) || base.execution) fail('VALIDATION_CAMPAIGN_BASE_INVALID', '需使用当前已批准实验的尚未执行材料运行。');
    if (plan.evaluation.dataset !== base.manifest.dataset.id || plan.evaluation.datasetVersion !== base.manifest.dataset.version) fail('VALIDATION_CAMPAIGN_DATA_MISMATCH', '方案与批准实验必须使用同一真实数据版本。');
    if (input.seeds.length !== plan.evaluation.repetitions || input.seeds[0] !== plan.evaluation.seed || input.variants.length * input.seeds.length > plan.evaluation.budget.maxRuns) fail('VALIDATION_CAMPAIGN_BUDGET_INVALID', '种子须匹配方案重复次数和首个种子，所有组别运行总数不得超过预算。');
    for (const variant of input.variants) {
      if (variant.kind !== 'candidate' && !plan.evaluation[variant.kind === 'baseline' ? 'baselines' : 'ablations'].includes(variant.label)) fail('VALIDATION_CAMPAIGN_GROUP_MISMATCH', '对照与消融名称必须属于冻结评价方案。');
      if (variant.kind !== 'candidate' && input.variants.some(candidate => candidate.kind === 'candidate' && sourceHash({ ...base.manifest.parameters, ...candidate.parameters }) === sourceHash({ ...base.manifest.parameters, ...variant.parameters }))) fail('VALIDATION_CAMPAIGN_GROUP_MISMATCH', '对照或消融必须有明确不同的运行参数，名称本身不实现对照。');
    }
    if (plan.evaluation.baselines.some(label => !input.variants.some(variant => variant.kind === 'baseline' && variant.label === label)) || plan.evaluation.ablations.some(label => !input.variants.some(variant => variant.kind === 'ablation' && variant.label === label))) fail('VALIDATION_CAMPAIGN_GROUP_MISMATCH', '请覆盖冻结方案中的基线与消融组别。');
    const authorization = await requireAutomatic(projectId, 'execution', input.sessionId);
    const campaign = { id, projectId, sessionId: input.sessionId, ideaId: input.ideaId, planRevision: plan.revision, planSha256: sourceHash(plan), plan,
      baseRunId: base.id, baseManifestSha256: experimentManifestHash(base.manifest), baseManifest: structuredClone(base.manifest), researchContext: structuredClone(base.manifest.researchPlan),
      policyVersion: authorization.policyVersion, inputSha256: sourceHash(input), seeds: input.seeds, variants: input.variants,
      budget: structuredClone(plan.evaluation.budget), elapsedSeconds: 0, status: 'prepared', createdAt: stamp(), updatedAt: stamp(), trials: [] };
    for (const variant of input.variants) for (const seed of input.seeds) {
      const trialId = `trial-${campaign.trials.length + 1}`;
      campaign.trials.push({ id: trialId, runId: `experiment-run-${sourceHash({ campaignId: id, trialId })}`, seed, variantId: variant.id, status: 'pending', manifestSha256: null, result: null });
    }
    await assertSource(projectId, campaign); document.campaigns.push(campaign); return campaign;
  });
}
async function change(projectId, campaignId, callback) {
  return mutateCampaigns(projectId, async document => {
    const campaign = document.campaigns.find(item => item.id === campaignId);
    if (!campaign) fail('VALIDATION_CAMPAIGN_NOT_FOUND', '本项目没有该试验批次。', 404);
    await callback(campaign); campaign.updatedAt = stamp(); return campaign;
  });
}
/** Read-only certificate called by the Runner while it already holds its own locks. */
export async function assertCampaignTrial(projectId, campaignId, trialId, { manifest, executionBinding } = {}) {
  const campaign = await getValidationCampaign(projectId, campaignId), authorization = await assertSource(projectId, campaign);
  const trial = campaign.trials.find(item => item.id === trialId), variant = campaign.variants.find(item => item.id === trial?.variantId);
  if (!trial || !variant || !['prepared', 'running'].includes(campaign.status) || !['reserved', 'awaiting_approval', 'approved', 'running'].includes(trial.status)
    || !Number.isInteger(trial.timeoutMs) || trial.timeoutMs < 100 || campaign.trials.length > campaign.budget.maxRuns || campaign.elapsedSeconds >= campaign.budget.maxSeconds) fail('VALIDATION_CAMPAIGN_NOT_EXECUTABLE', '当前批次项未获执行、已结束或预算耗尽。');
  const base = campaign.baseManifest;
  const execution = { ...base.command,
    ...(base.code.preparation?.id ? { codePreparationId: base.code.preparation.id } : {}),
    ...(base.environment.preparation?.id ? { environmentId: base.environment.preparation.id } : {}) };
  if (base.command.codePreparationId && base.command.codePreparationId !== execution.codePreparationId || base.command.environmentId && base.command.environmentId !== execution.environmentId) fail('VALIDATION_CAMPAIGN_BASE_CHANGED', '原代码或环境准备标识不一致。');
  const plan = { dataset: { id: base.dataset.id, version: base.dataset.version }, protocol: base.protocol, execution,
    parameters: { ...base.parameters, ...variant.parameters }, seed: trial.seed, resources: { ...base.resources, timeoutMs: trial.timeoutMs }, artifacts: base.artifacts,
    codePaths: base.code.paths, codeVersion: base.code.version, successCriteria: base.successCriteria };
  if (manifest) {
    const binding = { campaignId, trialId, sessionId: campaign.sessionId, baseRunId: campaign.baseRunId, planSha256: campaign.planSha256, variantId: trial.variantId };
    if (manifest.id !== trial.runId || sourceHash(manifest.campaign) !== sourceHash(binding) || sourceHash(manifest.researchPlan) !== sourceHash(campaign.researchContext)
      || sourceHash(manifest.command) !== sourceHash(execution) || sourceHash(manifest.code) !== sourceHash(base.code) || sourceHash(manifest.dataset) !== sourceHash(base.dataset)
      || sourceHash(manifest.environment) !== sourceHash(base.environment) || manifest.protocol !== base.protocol || manifest.seed !== trial.seed
      || sourceHash(manifest.parameters) !== sourceHash(plan.parameters) || sourceHash(manifest.resources) !== sourceHash(plan.resources)
      || sourceHash(manifest.artifacts) !== sourceHash(base.artifacts) || sourceHash(manifest.successCriteria) !== sourceHash(base.successCriteria)) fail('VALIDATION_CAMPAIGN_MANIFEST_CHANGED', '试验运行已偏离冻结的代码、数据、环境、协议或组别。');
    if (trial.manifestSha256 && experimentManifestHash(manifest) !== trial.manifestSha256) fail('VALIDATION_CAMPAIGN_MANIFEST_CHANGED', '批准后的固定运行清单发生变化。');
    if (executionBinding && (executionBinding.parentRunId !== campaign.id || executionBinding.policyVersion !== String(campaign.policyVersion) || executionBinding.manifestSha256 !== trial.manifestSha256)) fail('VALIDATION_CAMPAIGN_BINDING_CHANGED', '运行必须绑定原批次及批准后的清单。');
  }
  return { campaign, trial, plan, authorization };
}
async function receipt(projectId, campaignId, trialId, run) {
  const result = experimentRunSummary(run, (await getEvidenceLedger(projectId)).entries);
  return change(projectId, campaignId, campaign => {
    const trial = campaign.trials.find(item => item.id === trialId);
    trial.status = run.status; trial.result = result;
    trial.elapsedSeconds = Math.max(0, (Date.parse(run.execution?.finishedAt) - Date.parse(run.execution?.startedAt)) / 1000) || 0;
    campaign.elapsedSeconds = campaign.trials.reduce((sum, item) => sum + (item.elapsedSeconds || 0), 0);
    if (run.status !== 'completed') campaign.status = run.status === 'cancelled' ? 'cancelled' : 'failed';
    else if (campaign.trials.every(item => item.status === 'completed')) campaign.status = 'completed';
  });
}
export async function executeValidationCampaign(projectId, campaignId, { beforeEffect = async () => {}, onRun = () => {}, signal } = {}) {
  try {
    let campaign = await getValidationCampaign(projectId, campaignId);
    if (campaign.status === 'completed') return campaign;
    if (terminal.has(campaign.status) || campaign.status === 'budget_exhausted') fail('VALIDATION_CAMPAIGN_FAILED', '原批次已结束，不会重复运行。');
    await beforeEffect(); signal?.throwIfAborted(); await assertSource(projectId, campaign);
    campaign = await change(projectId, campaignId, next => { next.status = 'running'; delete next.error; });
    for (const original of campaign.trials) {
      await beforeEffect(); signal?.throwIfAborted(); campaign = await getValidationCampaign(projectId, campaignId);
      let trial = campaign.trials.find(item => item.id === original.id);
      if (trial.status === 'completed') continue;
      if (terminal.has(trial.status)) fail('VALIDATION_CAMPAIGN_FAILED', '原失败项已保留，本批次不会自动重跑。');
      let run;
      try { run = await getExperimentRun(projectId, trial.runId); } catch (error) { if (error.code !== 'EXPERIMENT_RUN_NOT_FOUND') throw error; }
      if (run && terminal.has(run.status)) { await assertCampaignTrial(projectId, campaignId, trial.id, { manifest: run.manifest, executionBinding: run.executionBinding }); campaign = await receipt(projectId, campaignId, trial.id, run); if (run.status !== 'completed') fail('VALIDATION_CAMPAIGN_FAILED', '原试验失败，批次已停止。'); continue; }
      if (run?.status === 'running') fail('VALIDATION_CAMPAIGN_RUN_UNRESOLVED', '原试验尚未确认停止，不会重复派发。');
      if (!run) {
        campaign = await change(projectId, campaignId, async next => {
          await assertSource(projectId, next);
          const remaining = Math.floor((next.budget.maxSeconds - next.elapsedSeconds) * 1000);
          if (remaining < 100) { next.status = 'budget_exhausted'; return; }
          const row = next.trials.find(item => item.id === trial.id); row.timeoutMs = Math.min(next.baseManifest.resources.timeoutMs, remaining); row.status = 'reserved'; next.status = 'running';
        });
        if (campaign.status === 'budget_exhausted') fail('VALIDATION_CAMPAIGN_BUDGET_EXHAUSTED', '累计运行时间预算已耗尽。');
        run = await createCampaignExperimentRun(projectId, { campaignId, trialId: trial.id });
      }
      if (run.status === 'awaiting_approval') { await beforeEffect(); signal?.throwIfAborted(); run = await automaticallyApproveExperiment(projectId, run.id, campaign.sessionId); }
      campaign = await change(projectId, campaignId, next => { const row = next.trials.find(item => item.id === trial.id); row.status = run.status; row.manifestSha256 = experimentManifestHash(run.manifest); next.status = 'running'; });
      trial = campaign.trials.find(item => item.id === trial.id); await beforeEffect(); signal?.throwIfAborted();
      await onRun(run.id);
      run = await startExperimentRun(projectId, run.id, { wait: true, signal,
        executionBinding: { parentRunId: campaign.id, policyVersion: String(campaign.policyVersion), manifestSha256: trial.manifestSha256 },
        beforeLaunch: async () => { signal?.throwIfAborted(); await beforeEffect(); await assertCampaignTrial(projectId, campaignId, trial.id, { manifest: run.manifest }); } });
      campaign = await receipt(projectId, campaignId, trial.id, run); await onRun(null);
      if (run.status !== 'completed') fail('VALIDATION_CAMPAIGN_FAILED', '试验失败或取消，真实日志已归档，批次已停止。');
    }
    return getValidationCampaign(projectId, campaignId);
  } catch (error) {
    await change(projectId, campaignId, next => { if (!['completed', 'failed', 'cancelled', 'budget_exhausted'].includes(next.status)) next.status = 'blocked'; next.error = { code: error.code || 'VALIDATION_CAMPAIGN_INTERRUPTED', message: error.message }; });
    throw error;
  } finally { await onRun(null); }
}
export async function cancelValidationCampaign(projectId, campaignId, { sessionId } = {}) {
  const campaign = await getValidationCampaign(projectId, campaignId);
  if (sessionId && campaign.sessionId !== sessionId) fail('VALIDATION_CAMPAIGN_OWNER_CHANGED', '不能取消其它研究链路的试验批次。');
  await change(projectId, campaignId, next => { if (!terminal.has(next.status)) next.status = 'cancelled'; });
  for (const trial of campaign.trials) {
    try { const run = await getExperimentRun(projectId, trial.runId); if (!terminal.has(run.status)) await cancelExperimentRun(projectId, run.id); }
    catch (error) { if (error.code !== 'EXPERIMENT_RUN_NOT_FOUND') throw error; }
  }
  return getValidationCampaign(projectId, campaignId);
}
