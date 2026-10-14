import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { readCampaigns } from '../validationCampaign/repository.js';
import { readValidationCampaignEvaluation } from '../validationCampaign/evaluation.js';
import { sourceHash } from '../researchAutomation/handoff.js';
import { resolveProjectRoot } from '../researchWorkflow/repository.js';
import { ResearchWorkflowError } from '../researchWorkflow/errors.js';
import { runPythonExperiment } from '../experimentRunner/adapters.js';
import { getProjectConstraints } from '../projectHub/dashboard.js';
import { getProjectFeatureFlags } from '../featureFlags.js';
import { applyProjectConstraintPolicy, hasCapability, resolveCapabilityPolicy, isSensitivePath } from '../harnessRuntime/capabilities.js';
import { parseLatexFigureTable } from './tableSource.js';
import { safeJoin } from '../../utils/pathUtils.js';
import { validateNativeSpec } from './nativeSpec.js';
import { readNativeRendererSource, renderNativeWithMcp, validateNativeOutput } from './nativeBackend.js';

const template = fileURLToPath(new URL('./paired_renderer.py', import.meta.url));
const prefix = 'assets/plots';
const fileNames = { svg: 'figure.svg', pdf: 'figure.pdf', png: 'figure.png', source: 'source.json', rendererSource: 'renderer.py' };
const nativeFileNames = { svg: 'figure.svg', pptx: 'figure.pptx', source: 'source.json', rendererSource: 'renderer.mjs' };
const profile = kind => kind === 'diagram' ? nativeFileNames : fileNames;
const fail = (code, message, status = 409) => { throw new ResearchWorkflowError(status, code, message); };
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
export function validateCampaignFigureInput(input) {
  if (!plain(input) || Object.keys(input).some(key => !['candidateVariantId', 'comparisonVariantId', 'metricName', 'style'].includes(key))
    || !['candidateVariantId', 'comparisonVariantId', 'metricName'].every(key => typeof input[key] === 'string' && input[key].trim() === input[key] && input[key].length > 0 && input[key].length <= 200 && input[key].isWellFormed())) fail('CAMPAIGN_FIGURE_INPUT_INVALID', '请选择明确候选、基线与冻结指标。', 400);
  validateFigureStyle(input.style);
  return structuredClone(input);
}
export function validateFigureStyle(value) {
  const style = value === undefined ? {} : value;
  if (!plain(style) || Object.keys(style).some(key => !['title', 'xLabel', 'yLabel', 'palette'].includes(key))
    || ['title', 'xLabel', 'yLabel'].some(key => style[key] !== undefined && (typeof style[key] !== 'string' || style[key].length > 120 || !style[key].isWellFormed() || /[\x00-\x1f\x7f]/.test(style[key])))
    || style.palette !== undefined && !['blue-orange', 'purple-green', 'grayscale'].includes(style.palette)) fail('CAMPAIGN_FIGURE_STYLE_INVALID', '样式只接受120字内的单行标题/轴标签和预设配色，不接受代码或数据修改。', 400);
  return structuredClone(style);
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
  if (figure.projectId !== projectId || campaignId !== undefined && figure.campaignId !== campaignId || figure.id !== directory || !figure.files) fail('CAMPAIGN_FIGURE_SOURCE_CHANGED', '固定图元数据归属发生变化。');
  for (const [kind, name] of Object.entries(profile(figure.kind))) {
    const saved = figure.files[kind], expectedPath = `${prefix}/${directory}/${name}`;
    if (saved?.path !== expectedPath) fail('CAMPAIGN_FIGURE_SOURCE_CHANGED', '图产物路径已变化。');
    const actual = await digest(safeJoin(root, expectedPath));
    if (actual.sha256 !== saved.sha256 || actual.bytes !== saved.bytes) fail('CAMPAIGN_FIGURE_SOURCE_CHANGED', '已生成图的来源或产物SHA发生变化，不会覆盖原文件。');
    saved.url = `/api/projects/${encodeURIComponent(projectId)}/blob?path=${encodeURIComponent(expectedPath)}`;
  }
  const source = JSON.parse((await digest(path.join(absolute, 'source.json'))).content.toString('utf8'));
  const familyScope = figure.kind === 'diagram' && figure.identityVersion === 2 ? { familyId: figure.familyId } : {};
  if (figure.identityVersion === 2 && (figure.kind !== 'diagram' || !/^diagram-figure-[a-f0-9]{64}$/.test(figure.familyId))) fail('CAMPAIGN_FIGURE_SOURCE_CHANGED', '方法图版本缺少固定归属。');
  if (sourceHash(source) !== figure.sourceSha256 || sourceHash(figure.style) !== figure.styleSha256 || figure.files.rendererSource.sha256 !== figure.renderer.sha256
    || directory !== `${figure.kind || 'campaign'}-figure-${sourceHash({ source: figure.sourceSha256, style: figure.styleSha256, renderer: figure.renderer.sha256, ...familyScope })}`) fail('CAMPAIGN_FIGURE_SOURCE_CHANGED', '图来源、样式或固定renderer标识发生变化。');
  figure.kind ||= source.kind || 'campaign';
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
export async function createCampaignFigure(projectId, campaignId, input, options = {}) {
  const prepared = await prepareCampaignFigureSource(projectId, campaignId, input);
  return storeFigure(projectId, 'campaign', { campaignId, metricName: input.metricName, candidateVariantId: input.candidateVariantId, comparisonVariantId: input.comparisonVariantId }, prepared, options,
    () => prepareCampaignFigureSource(projectId, campaignId, input));
}
async function storeFigure(projectId, kind, identity, prepared, { actor = 'human', signal, render = runPythonExperiment, nativeRender = renderNativeWithMcp, parentFigureId } = {}, checkSource = async () => prepared) {
  if (actor !== 'human') fail('HUMAN_INPUT_REQUIRED', '本入口由人工请求固定科学图导出。', 403);
  await admission(projectId); signal?.throwIfAborted();
  const rendererSource = kind === 'diagram' ? await readNativeRendererSource() : await fs.readFile(kind === 'campaign' ? template : fileURLToPath(new URL('./table_renderer.py', import.meta.url))), rendererSha256 = createHash('sha256').update(rendererSource).digest('hex');
  const campaignId = identity.campaignId;
  // A revision may match another diagram's contents without joining its history.
  const familyScope = kind === 'diagram' && identity.familyId ? { familyId: identity.familyId } : {};
  const id = `${kind}-figure-${sourceHash({ source: prepared.sourceSha256, style: prepared.styleSha256, renderer: rendererSha256, ...familyScope })}`;
  const root = await resolveProjectRoot(projectId), directory = safeJoin(root, `${prefix}/${id}`);
  try { await fs.access(directory); return await verifyFigure(root, projectId, campaignId, id); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const work = safeJoin(root, `${prefix}/.figure-work-${randomUUID()}`); await fs.mkdir(work, { recursive: true });
  try {
    await fs.writeFile(path.join(work, profile(kind).rendererSource), rendererSource, { flag: 'wx' });
    await fs.writeFile(path.join(work, 'source.json'), `${JSON.stringify(prepared.source, null, 2)}\n`, { flag: 'wx' });
    await fs.writeFile(path.join(work, 'style.json'), JSON.stringify(prepared.style), { flag: 'wx' });
    let runtime = {}, result, processState, validation;
    if (kind === 'diagram') {
      const request = { spec: prepared.source.spec, style: prepared.style, sourceSha256: prepared.sourceSha256 };
      result = await nativeRender(projectId, request, { signal, beforeRequest: () => admission(projectId) });
      signal?.throwIfAborted();
      if (!result.process?.stopConfirmed || !Number.isInteger(result.process.pid) || result.process.pid < 1) fail('FIGURE_NATIVE_PROCESS_UNCONFIRMED', '原生导出进程必须确认停止后发布。');
      const verified = await validateNativeOutput(result.payload, request); validation = verified.validation; processState = result.process;
      await fs.writeFile(path.join(work, 'figure.svg'), verified.svg, { flag: 'wx' });
      await fs.writeFile(path.join(work, 'figure.pptx'), verified.pptx, { flag: 'wx' });
      runtime = { backend: result.payload.backend, version: result.payload.version, font: validation.fonts };
      if (createHash('sha256').update(await readNativeRendererSource()).digest('hex') !== rendererSha256) fail('FIGURE_RENDERER_CHANGED', '固定renderer来源在生成期间发生变化。');
    } else {
    const configured = process.env.SCIENCEPRISM_FIGURE_PYTHON;
    if (!configured || !path.isAbsolute(configured)) fail('FIGURE_PYTHON_UNAVAILABLE', '请配置可信绝对SCIENCEPRISM_FIGURE_PYTHON及Matplotlib。', 503);
    const interpreter = await fs.realpath(configured).catch(() => null);
    if (!interpreter || !(await fs.stat(interpreter)).isFile()) fail('FIGURE_PYTHON_UNAVAILABLE', '固定Python绘图解释器不可用。', 503);
    const manifest = { id, command: { adapter: 'python', entrypoint: 'renderer.py', args: ['source.json', 'style.json'] },
      code: { preparation: { files: ['renderer.py', 'source.json', 'style.json'].map(path => ({ path })) } }, resources: { timeoutMs: 30000, maxOutputBytes: 512 * 1024 } };
    result = await render(manifest, { workspaceRoot: work, inputPath: path.join(work, 'source.json'), signal, pythonEnvironment: { interpreter: configured }, onProcess: state => { processState = state; } });
    if (result.exitCode !== 0) fail('CAMPAIGN_FIGURE_RENDER_FAILED', `固定Matplotlib渲染失败：${String(result.stderr || result.stdout || result.exitCode).slice(0, 1000)}`, 422);
    runtime = JSON.parse((await digest(path.join(work, 'runtime.json'))).content.toString('utf8'));
    }
    const files = {};
    for (const [fileKind, name] of Object.entries(profile(kind))) {
      const actual = await digest(path.join(work, name));
      if (fileKind === 'svg' && (!actual.content.toString('utf8').includes('<svg') || /<image\b/i.test(actual.content.toString('utf8')))) fail('CAMPAIGN_FIGURE_VECTOR_INVALID', 'SVG须为真实矢量点线及文字，不接受图片占位。');
      files[fileKind] = { path: `${prefix}/${id}/${name}`, sha256: actual.sha256, bytes: actual.bytes };
    }
    await admission(projectId); signal?.throwIfAborted();
    const fresh = await checkSource();
    if (fresh.sourceSha256 !== prepared.sourceSha256) fail('CAMPAIGN_FIGURE_SOURCE_CHANGED', '渲染期间真实来源变化，旧图不会覆盖。');
    const figure = { id, projectId, kind, ...identity, ...(parentFigureId ? { parentFigureId } : {}),
      createdAt: new Date().toISOString(), sourceSha256: prepared.sourceSha256, styleSha256: prepared.styleSha256, style: prepared.style, statistics: prepared.statistics,
      ...(kind === 'diagram' ? { familyId: identity.familyId || id, ...(identity.familyId ? { identityVersion: 2 } : {}), validation } : {}),
      renderer: { name: kind === 'diagram' ? 'native-diagram-mcp-v1' : kind === 'campaign' ? 'matplotlib-paired-v1' : 'matplotlib-table-v1', ...(kind === 'diagram' ? { backend: runtime.backend, version: runtime.version } : {}), sha256: rendererSha256, pythonVersion: runtime.pythonVersion, matplotlibVersion: runtime.matplotlibVersion, font: runtime.font, isolation: result.isolation, process: processState }, files };
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

export async function getFigureArtifact(projectId, figureId) {
  if (typeof figureId !== 'string' || !/^(?:campaign|table|diagram)-figure-[a-f0-9]{64}$/.test(figureId)) fail('FIGURE_NOT_FOUND', '本项目没有该固定图版本。', 404);
  return verifyFigure(await resolveProjectRoot(projectId), projectId, undefined, figureId);
}
export async function getFigureSource(projectId, figureId) {
  const figure = await getFigureArtifact(projectId, figureId), root = await resolveProjectRoot(projectId);
  return JSON.parse((await digest(safeJoin(root, figure.files.source.path))).content.toString('utf8'));
}
export async function listProjectFigures(projectId) {
  const root = await resolveProjectRoot(projectId), directory = safeJoin(root, prefix);
  let entries; try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const figures = [];
  for (const entry of entries.filter(item => item.isDirectory() && /^(?:campaign|table|diagram)-figure-[a-f0-9]{64}$/.test(item.name))) figures.push(await getFigureArtifact(projectId, entry.name));
  return figures.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}
export function validateTableFigureInput(input) {
  if (!plain(input) || Object.keys(input).some(key => !['tableLatex', 'sourcePath', 'chartType', 'layout', 'style', 'unit', 'sampleSize'].includes(key))
    || !['bar', 'line', 'heatmap'].includes(input.chartType) || !['single', 'panels'].includes(input.layout)
    || input.chartType === 'heatmap' && input.layout !== 'single'
    || input.sourcePath !== undefined && (typeof input.sourcePath !== 'string' || !input.sourcePath || input.sourcePath.length > 500 || !input.sourcePath.isWellFormed() || /[\x00-\x1f\x7f]/.test(input.sourcePath) || input.sourcePath.includes('\\') || path.posix.isAbsolute(input.sourcePath) || input.sourcePath.split('/').some(part => !part || ['.', '..'].includes(part)) || isSensitivePath(input.sourcePath))
    || input.unit !== undefined && (typeof input.unit !== 'string' || input.unit.length > 100 || !input.unit.isWellFormed() || /[\x00-\x1f\x7f]/.test(input.unit))
    || input.sampleSize !== undefined && (!Number.isSafeInteger(input.sampleSize) || input.sampleSize < 1 || input.sampleSize > 1e9)) fail('FIGURE_TABLE_INPUT_INVALID', '请选择固定图型与布局、明确表来源；热图为完整矩阵，样本量不能从行数猜测。', 400);
  validateFigureStyle(input.style); parseLatexFigureTable(input.tableLatex);
  return structuredClone(input);
}
export async function prepareTableFigureSource(projectId, input) {
  validateTableFigureInput(input);
  const parsedTable = parseLatexFigureTable(input.tableLatex), root = await resolveProjectRoot(projectId);
  let sourceFileSha256 = null;
  if (input.sourcePath) {
    let file;
    try { file = await digest(safeJoin(root, input.sourcePath)); }
    catch (error) {
      if (error.code === 'ENOENT') fail('FIGURE_TABLE_SOURCE_UNAVAILABLE', '项目内表格来源文件不存在，请核对路径。', 404);
      if (error.statusCode === 400) fail('FIGURE_TABLE_SOURCE_INVALID', '表格来源路径不能经过符号链接或离开项目。', 400);
      throw error;
    }
    if (!file.content.toString('utf8').includes(input.tableLatex)) fail('FIGURE_TABLE_SOURCE_MISMATCH', '项目文件不包含所给同源LaTeX表格，请先核对原表。');
    sourceFileSha256 = file.sha256;
  }
  const unit = input.unit?.trim() || null, sampleSize = input.sampleSize ?? null;
  const source = { schemaVersion: 1, kind: 'table', projectId, tableLatex: input.tableLatex, sourceOrigin: input.sourcePath ? 'project-file' : 'user-paste', sourcePath: input.sourcePath || null,
    sourceFileSha256, parsedTable, chartType: input.chartType, layout: input.layout, unit, sampleSize };
  const style = { title: '', xLabel: parsedTable.headers[0], yLabel: unit || '', palette: 'blue-orange', ...input.style };
  const statistics = { dataRows: parsedTable.rowLabels.length, series: parsedTable.series.length, units: unit, sampleSize, errorBars: 'none',
    caption: `全部${parsedTable.rowLabels.length}行、${parsedTable.series.length}个数值系列均保留原顺序绘制；多面板按每个数值列分面。${sampleSize === null ? '样本量未知，不从表行数推断。' : `样本量${sampleSize}由用户明确提供，不等于表行数。`}无误差条或统计显著性推断；密集组别只按固定间隔显示轴标签，不删除观测。` };
  return { source, style, statistics, sourceSha256: sourceHash(source), styleSha256: sourceHash(style) };
}
export async function createTableFigure(projectId, input, options = {}) {
  const prepared = await prepareTableFigureSource(projectId, input);
  return storeFigure(projectId, 'table', { chartType: input.chartType, layout: input.layout }, prepared, options, () => prepareTableFigureSource(projectId, input));
}
export async function reviseFigureArtifact(projectId, figureId, input, options = {}) {
  if (!plain(input) || Object.keys(input).some(key => key !== 'style')) fail('FIGURE_REVISION_INPUT_INVALID', '新版本仅可调整结构化样式，不能改变来源数据或图型。', 400);
  const style = validateFigureStyle(input.style), parent = await getFigureArtifact(projectId, figureId), source = await getFigureSource(projectId, figureId);
  const prepared = { source, style: { ...parent.style, ...style }, statistics: parent.statistics, sourceSha256: parent.sourceSha256 };
  prepared.styleSha256 = sourceHash(prepared.style);
  if (parent.kind === 'diagram') return createNativeFigure(projectId, { spec: source.spec, style: { ...parent.style, ...style }, parentFigureId: parent.id }, options);
  const identity = parent.kind === 'campaign' ? Object.fromEntries(['campaignId', 'metricName', 'candidateVariantId', 'comparisonVariantId'].map(key => [key, parent[key]])) : { chartType: parent.chartType, layout: parent.layout };
  return storeFigure(projectId, parent.kind, identity, prepared, { ...options, parentFigureId: parent.id });
}

export async function createNativeFigure(projectId, input, options = {}) {
  if (!plain(input) || Object.keys(input).some(key => !['spec', 'style', 'parentFigureId'].includes(key))) fail('FIGURE_NATIVE_INPUT_INVALID', '原生导出只接受固定结构、样式及同项目父版本。', 400);
  const style = { title: '', xLabel: '', yLabel: '', palette: 'blue-orange', ...validateFigureStyle(input.style) };
  let spec; try { spec = validateNativeSpec(input.spec, style); } catch (error) { throw new ResearchWorkflowError(error.statusCode || 400, error.code, error.message); }
  let parent;
  if (input.parentFigureId !== undefined) {
    parent = await getFigureArtifact(projectId, input.parentFigureId);
    if (parent.kind !== 'diagram') fail('FIGURE_NATIVE_PARENT_INVALID', '原生图版本只能继承同项目原生示意图。', 400);
  }
  const caption = '用户编写的原生方法示意图，不是实验结果或已验证科学证据；连线为可编辑原生线形，非随节点自动附着的连接器。字体引用Arial Unicode MS，不嵌入字体。';
  const source = { schemaVersion: 1, kind: 'diagram', projectId, spec, caption };
  const prepared = { source, style, sourceSha256: sourceHash(source), styleSha256: sourceHash(style), statistics: { nodes: spec.nodes.length, edges: spec.edges.length, caption } };
  return storeFigure(projectId, 'diagram', parent ? { familyId: parent.familyId || parent.id } : {}, prepared, { ...options, parentFigureId: parent?.id });
}
