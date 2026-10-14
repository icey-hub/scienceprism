import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { readCampaigns } from './repository.js';
import { readValidationCampaignEvaluation } from './evaluation.js';
import { sourceHash } from '../researchAutomation/handoff.js';
import { resolveProjectRoot } from '../researchWorkflow/repository.js';
import { ResearchWorkflowError } from '../researchWorkflow/errors.js';
import { runPythonExperiment } from '../experimentRunner/adapters.js';
import { getProjectConstraints } from '../projectHub/dashboard.js';
import { getProjectFeatureFlags } from '../featureFlags.js';
import { applyProjectConstraintPolicy, hasCapability, resolveCapabilityPolicy } from '../harnessRuntime/capabilities.js';
import { safeJoin } from '../../utils/pathUtils.js';

const template = fileURLToPath(new URL('./figures/paired_renderer.py', import.meta.url));
const prefix = 'assets/plots';
const fileNames = { svg: 'figure.svg', pdf: 'figure.pdf', png: 'figure.png', source: 'source.json', rendererSource: 'renderer.py' };
const fail = (code, message, status = 409) => { throw new ResearchWorkflowError(status, code, message); };
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
export function validateCampaignFigureInput(input) {
  if (!plain(input) || Object.keys(input).some(key => !['candidateVariantId', 'comparisonVariantId', 'metricName', 'style'].includes(key))
    || !['candidateVariantId', 'comparisonVariantId', 'metricName'].every(key => typeof input[key] === 'string' && input[key].trim() === input[key] && input[key].length > 0 && input[key].length <= 200 && input[key].isWellFormed())) fail('CAMPAIGN_FIGURE_INPUT_INVALID', '请选择明确候选、基线与冻结指标。', 400);
  const style = input.style || {};
  if (!plain(style) || Object.keys(style).some(key => !['title', 'xLabel', 'yLabel', 'palette'].includes(key))
    || ['title', 'xLabel', 'yLabel'].some(key => style[key] !== undefined && (typeof style[key] !== 'string' || style[key].length > 120 || !style[key].isWellFormed() || /[\x00-\x1f\x7f]/.test(style[key])))
    || style.palette !== undefined && !['blue-orange', 'purple-green', 'grayscale'].includes(style.palette)) fail('CAMPAIGN_FIGURE_STYLE_INVALID', '样式只接受120字内的单行标题/轴标签和预设配色，不接受代码或数据修改。', 400);
  return structuredClone(input);
}
export async function prepareCampaignFigureSource(projectId, campaignId, input) {
  validateCampaignFigureInput(input);
  const campaign = (await readCampaigns(projectId)).campaigns.find(item => item.id === campaignId);
  if (!campaign) fail('VALIDATION_CAMPAIGN_NOT_FOUND', '本项目没有该创新试验批次。', 404);
  const candidate = campaign.variants.find(item => item.id === input.candidateVariantId && item.kind === 'candidate');
  const comparison = campaign.variants.find(item => item.id === input.comparisonVariantId && item.kind === 'baseline');
  const metric = campaign.plan.evaluation.metrics.find(item => item.name === input.metricName);
  if (!candidate || !comparison || !metric) fail('CAMPAIGN_FIGURE_SELECTION_INVALID', '图只能使用冻结方案中的一个候选、一个真实基线及原指标。', 400);
  const evaluation = await readValidationCampaignEvaluation(projectId, campaign);
  const selected = value => value.candidateVariantId === candidate.id && value.comparisonVariantId === comparison.id && value.metricName === metric.name;
  const rows = evaluation.rows.filter(selected), summary = evaluation.summaries.find(selected);
  if (!summary || summary.issues.length || summary.completeSeeds !== campaign.seeds.length || rows.length !== campaign.seeds.length
    || rows.some(row => row.dataStatus !== 'complete') || new Set(rows.map(row => row.unit)).size !== 1) fail('CAMPAIGN_FIGURE_DATA_INCOMPLETE', '全部预定种子需有同单位、已核对归档的真实配对值；不能丢掉失败、缺失或负结果后出图。');
  const source = { schemaVersion: 1, projectId, campaignId, ideaId: campaign.ideaId, planRevision: campaign.planRevision, planSha256: campaign.planSha256,
    baseRunId: campaign.baseRunId, baseManifestSha256: campaign.baseManifestSha256, candidate, comparison, metric, rows, summary,
    code: campaign.baseManifest.code, dataset: campaign.baseManifest.dataset, environment: campaign.baseManifest.environment, protocol: campaign.baseManifest.protocol,
    evaluationSpec: campaign.plan.evaluation, hypothesis: campaign.plan.hypothesis || null,
    campaignVerdict: evaluation.verdict, rules: evaluation.rules, limitations: evaluation.limitations };
  const style = { title: `${metric.name}: paired seeds`, xLabel: '', yLabel: `${metric.name}${rows[0].unit ? ` (${rows[0].unit})` : ''}`, palette: 'blue-orange', ...input.style };
  const statistics = { n: rows.length, unit: rows[0].unit, seeds: [...campaign.seeds], errorBars: 'none', threshold: metric.threshold, direction: metric.direction,
    caption: `n=${rows.length}为全部预定完整配对种子数；点为每个种子的真实指标，线连接相同种子。保留全部负结果，无误差条，不声称统计显著性。${evaluation.rules[metric.direction]} 本图只展示该指标，批次其它冻结条件见独立评价。` };
  return { source, style, statistics, sourceSha256: sourceHash(source), styleSha256: sourceHash(style) };
}
async function admission(projectId) {
  const constraints = await getProjectConstraints(projectId), policy = applyProjectConstraintPolicy(resolveCapabilityPolicy({ configured: constraints.capabilities }), constraints);
  if (!hasCapability(policy, 'experiment.execute')) fail('CAPABILITY_DENIED', '固定科学图渲染需要项目experiment.execute能力。', 403);
  if ((await getProjectFeatureFlags(projectId)).experimentExecution !== true) fail('FEATURE_FLAG_DISABLED', '项目实验执行功能尚未启用。', 403);
}
async function digest(file) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > 20 * 1024 * 1024) fail('CAMPAIGN_FIGURE_OUTPUT_INVALID', '图产物必须是大小受限的真实文件。');
    const bytes = await handle.readFile(), after = await handle.stat();
    if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) fail('CAMPAIGN_FIGURE_OUTPUT_INVALID', '图产物读取时发生变化。');
    return { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, content: bytes };
  } finally { await handle.close(); }
}
async function verifyFigure(root, projectId, campaignId, directory) {
  const absolute = safeJoin(root, `${prefix}/${directory}`), metadataPath = safeJoin(root, `${prefix}/${directory}/metadata.json`);
  const figure = JSON.parse((await digest(metadataPath)).content.toString('utf8'));
  if (figure.projectId !== projectId || figure.campaignId !== campaignId || figure.id !== directory || !figure.files) fail('CAMPAIGN_FIGURE_SOURCE_CHANGED', '固定图元数据归属发生变化。');
  for (const [kind, name] of Object.entries(fileNames)) {
    const saved = figure.files[kind], expectedPath = `${prefix}/${directory}/${name}`;
    if (saved?.path !== expectedPath) fail('CAMPAIGN_FIGURE_SOURCE_CHANGED', '图产物路径已变化。');
    const actual = await digest(safeJoin(root, expectedPath));
    if (actual.sha256 !== saved.sha256 || actual.bytes !== saved.bytes) fail('CAMPAIGN_FIGURE_SOURCE_CHANGED', '已生成图的来源或产物SHA发生变化，不会覆盖原文件。');
    saved.url = `/api/projects/${encodeURIComponent(projectId)}/blob?path=${encodeURIComponent(expectedPath)}`;
  }
  const source = JSON.parse((await digest(path.join(absolute, 'source.json'))).content.toString('utf8'));
  if (sourceHash(source) !== figure.sourceSha256 || sourceHash(figure.style) !== figure.styleSha256 || figure.files.rendererSource.sha256 !== figure.renderer.sha256
    || directory !== `campaign-figure-${sourceHash({ source: figure.sourceSha256, style: figure.styleSha256, renderer: figure.renderer.sha256 })}`) fail('CAMPAIGN_FIGURE_SOURCE_CHANGED', '图来源、样式或固定renderer标识发生变化。');
  return figure;
}
export async function listCampaignFigures(projectId, campaignId) {
  if (!(await readCampaigns(projectId)).campaigns.some(item => item.id === campaignId)) fail('VALIDATION_CAMPAIGN_NOT_FOUND', '本项目没有该创新试验批次。', 404);
  const root = await resolveProjectRoot(projectId), directory = safeJoin(root, prefix), figures = [];
  let entries; try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  for (const entry of entries.filter(item => item.isDirectory() && /^campaign-figure-[a-f0-9]{64}$/.test(item.name))) {
    const metadata = JSON.parse((await digest(safeJoin(root, `${prefix}/${entry.name}/metadata.json`))).content.toString('utf8'));
    if (metadata.campaignId === campaignId) figures.push(await verifyFigure(root, projectId, campaignId, entry.name));
  }
  return figures.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}
export async function createCampaignFigure(projectId, campaignId, input, { actor = 'human', signal, render = runPythonExperiment } = {}) {
  if (actor !== 'human') fail('HUMAN_INPUT_REQUIRED', '本入口由人工请求固定科学图导出。', 403);
  await admission(projectId); signal?.throwIfAborted();
  const prepared = await prepareCampaignFigureSource(projectId, campaignId, input), rendererSource = await fs.readFile(template), rendererSha256 = createHash('sha256').update(rendererSource).digest('hex');
  const id = `campaign-figure-${sourceHash({ source: prepared.sourceSha256, style: prepared.styleSha256, renderer: rendererSha256 })}`;
  const root = await resolveProjectRoot(projectId), directory = safeJoin(root, `${prefix}/${id}`);
  try { await fs.access(directory); return await verifyFigure(root, projectId, campaignId, id); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const work = safeJoin(root, `${prefix}/.figure-work-${randomUUID()}`); await fs.mkdir(work, { recursive: true });
  try {
    await fs.writeFile(path.join(work, 'renderer.py'), rendererSource, { flag: 'wx' });
    await fs.writeFile(path.join(work, 'source.json'), `${JSON.stringify(prepared.source, null, 2)}\n`, { flag: 'wx' });
    await fs.writeFile(path.join(work, 'style.json'), JSON.stringify(prepared.style), { flag: 'wx' });
    const configured = process.env.SCIENCEPRISM_FIGURE_PYTHON;
    if (!configured || !path.isAbsolute(configured)) fail('FIGURE_PYTHON_UNAVAILABLE', '请配置可信绝对SCIENCEPRISM_FIGURE_PYTHON及Matplotlib。', 503);
    const interpreter = await fs.realpath(configured).catch(() => null);
    if (!interpreter || !(await fs.stat(interpreter)).isFile()) fail('FIGURE_PYTHON_UNAVAILABLE', '固定Python绘图解释器不可用。', 503);
    const manifest = { id, command: { adapter: 'python', entrypoint: 'renderer.py', args: ['source.json', 'style.json'] },
      code: { preparation: { files: ['renderer.py', 'source.json', 'style.json'].map(path => ({ path })) } }, resources: { timeoutMs: 30000, maxOutputBytes: 512 * 1024 } };
    let processState;
    const result = await render(manifest, { workspaceRoot: work, inputPath: path.join(work, 'source.json'), signal, pythonEnvironment: { interpreter: configured }, onProcess: state => { processState = state; } });
    if (result.exitCode !== 0) fail('CAMPAIGN_FIGURE_RENDER_FAILED', `固定Matplotlib渲染失败：${String(result.stderr || result.stdout || result.exitCode).slice(0, 1000)}`, 422);
    const runtime = JSON.parse((await digest(path.join(work, 'runtime.json'))).content.toString('utf8')), files = {};
    for (const [kind, name] of Object.entries(fileNames)) {
      const actual = await digest(path.join(work, name));
      if (kind === 'svg' && (!actual.content.toString('utf8').includes('<svg') || /<image\b/i.test(actual.content.toString('utf8')))) fail('CAMPAIGN_FIGURE_VECTOR_INVALID', 'SVG须为真实矢量点线及文字，不接受图片占位。');
      files[kind] = { path: `${prefix}/${id}/${name}`, sha256: actual.sha256, bytes: actual.bytes };
    }
    const fresh = await prepareCampaignFigureSource(projectId, campaignId, input);
    if (fresh.sourceSha256 !== prepared.sourceSha256) fail('CAMPAIGN_FIGURE_SOURCE_CHANGED', '渲染期间真实来源变化，旧图不会覆盖。');
    const figure = { id, projectId, campaignId, metricName: input.metricName, candidateVariantId: input.candidateVariantId, comparisonVariantId: input.comparisonVariantId,
      createdAt: new Date().toISOString(), sourceSha256: prepared.sourceSha256, styleSha256: prepared.styleSha256, style: prepared.style, statistics: prepared.statistics,
      renderer: { name: 'matplotlib-paired-v1', sha256: rendererSha256, pythonVersion: runtime.pythonVersion, matplotlibVersion: runtime.matplotlibVersion, font: runtime.font, isolation: result.isolation, process: processState }, files };
    await fs.writeFile(path.join(work, 'metadata.json'), JSON.stringify(figure, null, 2), { flag: 'wx' });
    for (const name of ['.experiment-home', '.experiment-tmp', 'style.json', 'runtime.json']) await fs.rm(path.join(work, name), { recursive: true, force: true });
    safeJoin(root, `${prefix}/${id}`); // Recheck parent symlinks immediately before the atomic directory publication.
    try { await fs.rename(work, directory); } catch (error) { if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error; }
    return verifyFigure(root, projectId, campaignId, id);
  } catch (error) {
    if (error instanceof ResearchWorkflowError) throw error;
    if (Number.isInteger(error.statusCode) && typeof error.code === 'string') throw new ResearchWorkflowError(error.statusCode, error.code, error.message);
    throw error;
  } finally { await fs.rm(work, { recursive: true, force: true }); }
}
