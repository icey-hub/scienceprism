import { getResearchWorkflow } from './queries.js';
import { getIdeaPlan, saveGeneratedIdeaPlan } from './ideaPlans.js';
import { ResearchWorkflowError } from './errors.js';
import { searchProjectPapers } from '../paperSearch.js';
import { listResearchSourceAdapters } from '../researchSources/index.js';
import { isSourcePolicyFailure } from '../researchSources/sourceAdapter.js';
import { runResearchStage } from '../researchResearch/harnessAdapter.js';
import { getResearchStageSchema } from '../researchResearch/schemas.js';
import { runHarnessRequest } from '../harnessRuntime/index.js';
import { datasetService } from '../datasets/index.js';
import { getExperimentRun } from '../experimentRunner/index.js';
import { sourceHash } from '../researchAutomation/handoff.js';

const fail = (code, message, status = 409) => { throw new ResearchWorkflowError(status, code, message); };
function candidate(workflow, ideaId) {
  if (workflow.currentStage !== 'ideation' || workflow.status === 'completed') fail('STAGE_GATE', '只能在当前创新阶段生成方案。');
  const ideas = (workflow.stages.find(stage => stage.id === 'ideation')?.data?.ideas || []).filter(idea => String(idea.id) === ideaId);
  if (ideas.length !== 1) fail('IDEA_PLAN_NOT_FOUND', '请选择原创新阶段中的唯一候选。', 404);
  return ideas[0];
}

/** Search and generate through the existing Harness, then append under the original workflow CAS. */
export async function generateIdeaPlan(projectId, ideaId, input, { search = searchProjectPapers, runStage = runResearchStage, beforeEffect = async () => {}, ...runtime } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['expectedRevision', 'query', 'replicationRunId'].includes(key))
    || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0
    || input.query !== undefined && (typeof input.query !== 'string' || !input.query.isWellFormed() || !input.query.trim() || input.query.length > 1000)
    || input.replicationRunId !== undefined && (typeof input.replicationRunId !== 'string' || !input.replicationRunId.trim() || input.replicationRunId.length > 200)) fail('IDEA_PLAN_INPUT_INVALID', '请提供当前版本及合理长度的检索词或复现来源；模型运行配置只能由服务器设置。', 400);
  const workflow = await getResearchWorkflow(projectId), idea = structuredClone(candidate(workflow, ideaId));
  const { plan: previousPlan } = await getIdeaPlan(projectId, ideaId), candidateSha256 = sourceHash(idea);
  if ((previousPlan?.revision || 0) !== input.expectedRevision) fail('IDEA_PLAN_CONFLICT', '方案已更新，请刷新后生成。');
  const guard = async () => {
    runtime.signal?.throwIfAborted(); await beforeEffect();
    if (sourceHash(candidate(await getResearchWorkflow(projectId), ideaId)) !== candidateSha256) fail('IDEA_PLAN_CANDIDATE_CHANGED', '创新候选已变化，生成结果不会覆盖新候选。');
    if (((await getIdeaPlan(projectId, ideaId)).plan?.revision || 0) !== input.expectedRevision) fail('IDEA_PLAN_CONFLICT', '人工方案已更新，生成结果不会覆盖人工修改。');
  };
  let replicationEvidence = previousPlan?.evidence || null;
  if (input.replicationRunId !== undefined) {
    const run = await getExperimentRun(projectId, input.replicationRunId);
    if (run.status !== 'completed' || run.manifest?.purpose === 'engineering-trial' || run.purpose === 'engineering-trial'
      || run.manifest?.replication?.projectId !== projectId || run.manifest.replication.sourceStage !== 'replication' || !run.paperComparison) fail('IDEA_PLAN_SOURCE_INVALID', '需选择本项目已完成的正式复现及其论文对比。');
    const comparison = run.paperComparison;
    if (replicationEvidence && (replicationEvidence.runId !== run.id || sourceHash(replicationEvidence.paper) !== sourceHash(comparison.paper))) fail('IDEA_PLAN_SOURCE_CHANGED', '此候选已有固定复现来源，请保留原来源。');
    replicationEvidence = { runId: run.id, comparisonRevision: comparison.revision, paper: structuredClone(comparison.paper), rows: structuredClone(comparison.rows) };
  }
  const availableDatasets = [];
  for (const listed of (await datasetService.list(projectId)).datasets) {
    try { const value = await datasetService.get(projectId, listed.id); availableDatasets.push({ id: value.id, sha256: value.sha256, filename: value.filename, split: value.split || 'unknown' }); }
    catch { /* Unreadable versions cannot be proposed as available fixed data. */ }
  }
  const direction = workflow.stages.find(stage => stage.id === 'direction')?.data || {};
  const query = input.query?.trim() || [idea.title, ...(Array.isArray(direction.keywords) ? direction.keywords : []), direction.question].filter(value => typeof value === 'string' && value.trim()).join(' ').slice(0, 1000) || ideaId;
  const sources = listResearchSourceAdapters().map(value => value.id).filter(id => ['arxiv', 'openalex'].includes(id));
  await guard();
  let session;
  try { session = await search(projectId, { query, sources, pageSize: 5 }, { signal: runtime.signal, beforeRequest: guard, beforePersist: guard }); }
  catch (error) {
    runtime.signal?.throwIfAborted();
    if (error instanceof ResearchWorkflowError || isSourcePolicyFailure(error)) throw error;
    session = { id: null, projectId, createdAt: new Date().toISOString(), status: 'failed', candidates: [], failures: [{ code: error.code || 'SEARCH_FAILED', message: String(error.message).slice(0, 2000) }] };
  }
  if (session.projectId !== projectId) fail('IDEA_PLAN_SEARCH_SOURCE_INVALID', '检索记录不属于当前项目。');
  const relatedWork = { searchSessionId: session.id, query, sources, searchedAt: session.createdAt, status: session.status,
    failures: structuredClone(session.failures || []), candidates: (session.candidates || []).slice(0, 10).map(paper => ({ id: paper.id, title: paper.title, year: paper.year ?? null,
      ...Object.fromEntries(['doi', 'url', 'source'].filter(key => typeof paper[key] === 'string' && paper[key]).map(key => [key, paper[key]])) })) };
  await guard();
  const result = await runStage({ stage: 'hypothesis_plan', workflowStage: 'ideation', projectId,
    input: { ideaId, expectedRevision: input.expectedRevision, idea, previousPlan, replicationEvidence, availableDatasets, relatedWork },
    role: runtime.role, llmConfig: runtime.llmConfig, adapter: runtime.adapter, context: runtime.context,
    fakeResponse: runtime.fakeResponse, fakeError: runtime.fakeError,
    runHarness: request => (runtime.runHarness || runHarnessRequest)({ ...request, signal: runtime.signal }) });
  runtime.signal?.throwIfAborted();
  const parsed = getResearchStageSchema('hypothesis_plan').safeParse(result.output);
  if (!result.ok || !parsed.success || parsed.data.ideaId !== ideaId) fail('IDEA_PLAN_GENERATION_INVALID', '模型未返回符合当前候选的有效方案；原运行及检索已保留，当前方案不会被覆盖。', 422);
  const proposal = parsed.data;
  let generationIssue;
  if (proposal.evaluation.dataset || proposal.evaluation.datasetVersion) {
    if (!availableDatasets.some(data => data.id === proposal.evaluation.dataset && data.sha256 === proposal.evaluation.datasetVersion)) {
      proposal.evaluation.dataset = ''; proposal.evaluation.datasetVersion = '';
      generationIssue = '模型建议的数据未对应本项目可读取的固定版本，已清空；请明确选择真实数据。';
    }
  }
  return saveGeneratedIdeaPlan(projectId, ideaId, { expectedRevision: input.expectedRevision, hypothesis: proposal.hypothesis, evaluation: proposal.evaluation,
    ...(input.replicationRunId !== undefined ? { replicationRunId: input.replicationRunId } : {}) },
  { sourceRunId: result.runId, relatedWork, candidateSha256, generationIssue, beforeEffect });
}
