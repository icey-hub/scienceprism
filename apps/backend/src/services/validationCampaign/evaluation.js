import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { sourceHash } from '../researchAutomation/handoff.js';
import { experimentManifestHash } from '../experimentRunner/manifest.js';
import { readExperimentRuns, resolveExperimentProjectRoot } from '../experimentRunner/repository.js';

const finite = value => typeof value === 'number' && Number.isFinite(value);
const same = (left, right) => sourceHash(left ?? null) === sourceHash(right ?? null);
const rules = Object.freeze({
  increase: '候选减基线的配对均值改善幅度必须至少达到冻结阈值。',
  decrease: '基线减候选的配对均值改善幅度必须至少达到冻结阈值。',
  target: '候选在全部预定种子上的均值必须严格等于冻结绝对目标；未预设容差时不猜容差。',
  aggregation: '只按全部预定种子的完整配对均值判定；任一失败、缺失或来源不一致均为证据不足。冻结消融也必须完整；其达标与否不替代基线阈值判定。'
});
function metricRows(value) {
  const list = Array.isArray(value) ? value : Array.isArray(value?.metrics) ? value.metrics : value && typeof value === 'object' ? Object.entries(value).map(([name, item]) => ({ name, value: item })) : [];
  return list.filter(item => item && typeof item.name === 'string').map(item => ({ name: item.name.trim(), value: item.value, unit: typeof item.unit === 'string' && item.unit.trim() ? item.unit.trim() : null }));
}
async function readMetricArchive(root, run, artifact) {
  const prefix = `.scienceprism/experiment-runs/${run.id}/artifacts/`;
  if (typeof artifact.path !== 'string' || !artifact.path.startsWith(prefix) || artifact.path.includes('\\') || artifact.path.split('/').some(part => !part || part === '.' || part === '..')
    || !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0 || artifact.bytes > 8 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(artifact.sha256)) throw new Error('指标归档路径、大小或SHA无效。');
  const realRoot = await fs.realpath(root), target = path.join(realRoot, artifact.path);
  if (await fs.realpath(target) !== target) throw new Error('指标归档不能通过符号链接替换。');
  const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size !== artifact.bytes || before.nlink !== 1) throw new Error('指标归档字节与原记录不一致。');
    const bytes = await handle.readFile(), after = await handle.stat();
    if (before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== artifact.bytes
      || createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) throw new Error('指标归档内容或SHA已变化。');
    try { return metricRows(JSON.parse(bytes.toString('utf8'))); } catch { return []; }
  } finally { await handle.close(); }
}
async function source(projectId, root, campaign, trial, run, variant) {
  const issues = [], metrics = new Map(), metricIssues = new Map(), archives = [];
  if (!run) return { runId: null, status: 'missing', issues: ['原运行尚未创建或已不可读取。'], metrics, metricIssues, archives };
  const manifest = run.manifest, base = campaign.baseManifest;
  const expectedBinding = { campaignId: campaign.id, trialId: trial.id, sessionId: campaign.sessionId, baseRunId: campaign.baseRunId, planSha256: campaign.planSha256, variantId: variant.id };
  const command = { ...base.command, ...(base.code.preparation?.id ? { codePreparationId: base.code.preparation.id } : {}), ...(base.environment.preparation?.id ? { environmentId: base.environment.preparation.id } : {}) };
  if (run.id !== trial.runId || run.projectId !== projectId || !manifest || manifest.id !== trial.runId || manifest.projectId !== projectId
    || !same(manifest.campaign, expectedBinding) || !same(manifest.researchPlan, campaign.researchContext)
    || !same(manifest.command, command) || !same(manifest.code, base.code) || !same(manifest.dataset, base.dataset) || !same(manifest.environment, base.environment)
    || manifest.protocol !== base.protocol || manifest.seed !== trial.seed || !same(manifest.parameters, { ...base.parameters, ...variant.parameters })
    || !same(manifest.artifacts, base.artifacts) || !same(manifest.successCriteria, base.successCriteria)
    || !same(manifest.resources, { ...base.resources, timeoutMs: trial.timeoutMs }) || manifest.purpose === 'engineering-trial' || manifest.trial) issues.push('运行未绑定原批次的固定来源、组别、种子或科研材料。');
  if (!trial.manifestSha256 || !manifest || experimentManifestHash(manifest) !== trial.manifestSha256
    || run.executionBinding?.parentRunId !== campaign.id || run.executionBinding?.manifestSha256 !== trial.manifestSha256
    || run.executionBinding?.policyVersion !== String(campaign.policyVersion)) issues.push('原批准清单或实际执行绑定缺失/变化。');
  if (run.status !== 'completed') issues.push(`原运行状态为${run.status}，保留失败或未完成记录。`);
  if (!['node', 'python'].includes(manifest?.command?.adapter) || run.execution?.exitCode !== 0 || run.execution?.signal || run.error
    || run.execution?.process?.stopConfirmed !== true || !Number.isSafeInteger(run.execution?.process?.pid) || run.execution.process.pid < 1) issues.push('缺少真实执行完成和进程停止记录；exit0本身不证明指标条件。');
  const stored = metricRows(run.metrics);
  for (const item of stored) {
    if (metrics.has(item.name)) { metricIssues.set(item.name, [`指标${item.name}存在重复运行记录。`]); metrics.set(item.name, null); }
    else metrics.set(item.name, item);
  }
  if (!(run.artifacts || []).some(artifact => artifact.kind === 'metric')) issues.push('未归档可核对的真实指标文件。');
  const archiveMetrics = new Map();
  for (const artifact of (run.artifacts || []).filter(item => item.kind === 'metric')) {
    try {
      const rows = await readMetricArchive(root, run, artifact);
      archives.push({ runId: run.id, id: artifact.id, path: artifact.path, sha256: artifact.sha256, bytes: artifact.bytes, metricNames: rows.map(item => item.name) });
      for (const item of rows) { const values = archiveMetrics.get(item.name) || []; values.push(item); archiveMetrics.set(item.name, values); }
    } catch (error) { issues.push(`指标归档不可核对：${artifact.name || artifact.id}（${error.message}）`); }
  }
  for (const [name, item] of metrics) {
    const values = archiveMetrics.get(name) || [];
    if (!item || !finite(item.value) || !values.length || values.some(value => !finite(value.value) || value.value !== item.value || value.unit !== item.unit)) {
      metrics.set(name, null); metricIssues.set(name, [...(metricIssues.get(name) || []), `指标${name}缺少一致的有限数值及固定归档来源。`]);
    }
  }
  return { runId: run.id, status: run.status, issues, metrics, metricIssues, archives };
}
const mean = values => values.reduce((sum, value) => sum + value / values.length, 0);

/** Independent read-only projection: never uses client values or edits a Run. */
export async function readValidationCampaignEvaluation(projectId, campaign) {
  const root = await resolveExperimentProjectRoot(projectId), document = await readExperimentRuns(root, projectId);
  const rows = [], summaries = [], sources = new Map(), candidates = campaign.variants.filter(variant => variant.kind === 'candidate');
  const frozenSourceValid = campaign.projectId === projectId && sourceHash(campaign.plan) === campaign.planSha256
    && campaign.plan.revision === campaign.planRevision && campaign.plan.ideaId === campaign.ideaId
    && experimentManifestHash(campaign.baseManifest) === campaign.baseManifestSha256;
  const comparisons = campaign.variants.filter(variant => ['baseline', 'ablation'].includes(variant.kind));
  for (const trial of campaign.trials) {
    const variant = campaign.variants.find(item => item.id === trial.variantId), run = document.runs.find(item => item.id === trial.runId);
    sources.set(trial.id, await source(projectId, root, campaign, trial, run, variant));
  }
  for (const candidate of candidates) for (const comparison of comparisons) for (const metric of campaign.plan.evaluation.metrics) {
    const group = [];
    for (const seed of campaign.seeds) {
      const candidateTrials = campaign.trials.filter(trial => trial.variantId === candidate.id && trial.seed === seed), comparisonTrials = campaign.trials.filter(trial => trial.variantId === comparison.id && trial.seed === seed);
      const candidateTrial = candidateTrials[0], comparisonTrial = comparisonTrials[0];
      const left = sources.get(candidateTrial?.id), right = sources.get(comparisonTrial?.id), actual = left?.metrics.get(metric.name), baseline = right?.metrics.get(metric.name);
      const issues = [...(left?.issues || ['候选运行缺失。']), ...(right?.issues || ['比较运行缺失。']), ...(left?.metricIssues.get(metric.name) || []), ...(right?.metricIssues.get(metric.name) || [])];
      if (candidateTrials.length !== 1 || comparisonTrials.length !== 1) issues.push('同一种子与组别须有唯一原运行。');
      if (!actual || !baseline) issues.push('配对指标缺失或不为有限数值。');
      if (actual && baseline && actual.unit !== baseline.unit) issues.push('配对指标单位不一致。');
      const candidateValue = actual?.value ?? null, comparisonValue = baseline?.value ?? null;
      const delta = finite(candidateValue) && finite(comparisonValue) && actual.unit === baseline.unit ? candidateValue - comparisonValue : null;
      if (delta !== null && !finite(delta)) issues.push('指标差值超出有限数值范围。');
      const row = { candidateVariantId: candidate.id, comparisonVariantId: comparison.id, comparisonKind: comparison.kind,
        metricName: metric.name, direction: metric.direction, threshold: metric.threshold, seed,
        candidateRunId: left?.runId || null, comparisonRunId: right?.runId || null,
        candidateStatus: left?.status || 'missing', comparisonStatus: right?.status || 'missing', candidateValue, comparisonValue,
        unit: actual?.unit ?? baseline?.unit ?? null, delta: finite(delta) ? delta : null, dataStatus: issues.length ? 'insufficient' : 'complete', issues: [...new Set(issues)],
        sourceArtifacts: [...(left?.archives || []), ...(right?.archives || [])].filter(artifact => artifact.metricNames.includes(metric.name)).map(({ metricNames, ...artifact }) => artifact) };
      rows.push(row); group.push(row);
    }
    const issues = [...new Set(group.flatMap(row => row.issues))], complete = group.length === campaign.seeds.length && group.every(row => row.dataStatus === 'complete');
    if (!frozenSourceValid) issues.push('冻结方案或原基准清单自身SHA、版本或项目归属不一致。');
    if (new Set(group.map(row => row.unit)).size > 1) issues.push('预定种子的指标单位不一致，不能混合求均值。');
    if (!finite(metric.threshold) || !['increase', 'decrease', 'target'].includes(metric.direction)) issues.push('冻结指标缺少明确数值阈值或方向。');
    if (['increase', 'decrease'].includes(metric.direction) && metric.threshold < 0) issues.push('改善幅度阈值不能为负数；未猜测旧方案阈值含义。');
    const candidateMean = complete ? mean(group.map(row => row.candidateValue)) : null, comparisonMean = complete ? mean(group.map(row => row.comparisonValue)) : null;
    const meanImprovement = complete ? mean(group.map(row => metric.direction === 'decrease' ? -row.delta : row.delta)) : null;
    if (complete && [candidateMean, comparisonMean, meanImprovement].some(value => !finite(value))) issues.push('配对均值超出有限数值范围。');
    const verdict = issues.length ? 'insufficient' : metric.direction === 'target' ? candidateMean === metric.threshold ? 'supported' : 'refuted' : meanImprovement >= metric.threshold ? 'supported' : 'refuted';
    summaries.push({ candidateVariantId: candidate.id, candidateLabel: candidate.label, comparisonVariantId: comparison.id, comparisonLabel: comparison.label, comparisonKind: comparison.kind,
      metricName: metric.name, direction: metric.direction, threshold: metric.threshold, expectedSeeds: [...campaign.seeds], completeSeeds: group.filter(row => row.dataStatus === 'complete').length,
      candidateMean: finite(candidateMean) ? candidateMean : null, comparisonMean: finite(comparisonMean) ? comparisonMean : null, meanImprovement: finite(meanImprovement) ? meanImprovement : null, verdict, issues });
  }
  const baselines = summaries.filter(item => item.comparisonKind === 'baseline'), counts = { supported: 0, refuted: 0, insufficient: 0 };
  for (const summary of baselines) counts[summary.verdict]++;
  const missingAblation = summaries.some(item => item.comparisonKind === 'ablation' && item.verdict === 'insufficient');
  const verdict = !baselines.length || counts.insufficient || missingAblation ? 'insufficient' : counts.refuted ? 'refuted' : 'supported';
  return { schemaVersion: 1, ruleVersion: 'paired-frozen-metrics-v1', scope: 'frozen-conditions-only', planRevision: campaign.planRevision, planSha256: campaign.planSha256,
    verdict, counts, summaries, rows, rules: { ...rules }, limitations: [
      '这是冻结数据、代码、分割、指标与全部预定种子下的确定性比较，不声称统计显著性、因果关系或普适创新。',
      'increase/decrease的阈值按平均改善幅度解释；target按绝对目标解释。旧方案含义应对照此机器规则确认，不从自然语言猜测。',
      '运行及指标产物仍沿用原Evidence确认状态；此评价不将退出码0、AI猜测或数值达标自动升级为已验证的科研结论。'
    ] };
}
