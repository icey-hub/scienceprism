import { getEnv } from '../../config/constants.js';
import { createHarnessRun, getHarnessRun, startHarnessRun, cancelHarnessRun, readProjectConstraints } from '../harnessRuntime/index.js';
import { readHarnessRuns, resolveHarnessProjectRoot } from '../harnessRuntime/repository.js';
import { runResearchStage } from '../researchResearch/harnessAdapter.js';
import { getResearchStageSchema } from '../researchResearch/schemas.js';
import { datasetService } from '../datasets/index.js';
import { sourceHash } from '../researchAutomation/handoff.js';
import { getResearchWorkflow } from './queries.js';
import { prepareCampaignWritingRequest, assertCampaignWritingContext } from './campaignWritingHandoff.js';
import { validateNextPlanRequest, prepareIdeaPlanRevision, revisionReplay, saveGeneratedNextIdeaPlan, revisionFail, assertIdeaPlanRevisionIdle } from './ideaPlanRevision.js';

const pending = new Map();
export async function generateNextIdeaPlan(projectId, ideaId, input, { actor = 'human', runStage = runResearchStage, beforeEffect = async () => {}, ...runtime } = {}) {
  if (actor !== 'human') revisionFail('HUMAN_INPUT_REQUIRED', '请由人工选择原评价及建议后生成新版。', 403);
  const normalized = validateNextPlanRequest(input), workflow = await getResearchWorkflow(projectId);
  const repeated = revisionReplay(workflow, projectId, ideaId, normalized, 'generate-next-idea-plan'); if (repeated) return repeated;
  if (pending.has(projectId)) revisionFail('IDEA_PLAN_REVISION_BUSY', '新版生成正在执行，请核对原任务，不另起请求。', 409, { runId: pending.get(projectId) || null });
  pending.set(projectId, null);
  try {
    const requestSha256 = sourceHash({ projectId, ideaId, input: normalized }), requestId = `idea-revision-${sourceHash({ projectId, ideaId, key: normalized.idempotencyKey })}`;
    const runs = (await readHarnessRuns(await resolveHarnessProjectRoot(projectId), projectId)).runs.filter(run => run.request?.source === 'idea-plan-revision' && run.request.requestId === requestId);
    if (runs.length > 1) revisionFail('IDEA_PLAN_REVISION_UNRESOLVED', '同一请求存在多个原Run，不会重新派发。');
    let original = runs[0];
    if (original && original.request.revisionIdentity?.requestSha256 !== requestSha256) revisionFail('IDEMPOTENCY_KEY_REUSED', '同一生成请求不能替换输入。');
    if (original && (!['created', 'completed'].includes(original.status) || original.cleanup?.modelSlotRetained)) revisionFail('IDEA_PLAN_REVISION_UNRESOLVED', '原生成尚在执行、已失败/取消或停止状态未知；保留原Run，不能自动重派。', 409, { runId: original.id });
    const prepared = await prepareIdeaPlanRevision(projectId, ideaId, normalized, { allowRunId: original?.id });
    const guard = async () => {
      runtime.signal?.throwIfAborted(); await beforeEffect();
      const current = await prepareIdeaPlanRevision(projectId, ideaId, normalized, { allowRunId: original?.id });
      if (sourceHash(current.revisionSource) !== sourceHash(prepared.revisionSource) || sourceHash(current.previousPlan) !== sourceHash(prepared.previousPlan)
        || sourceHash(current.idea) !== sourceHash(prepared.idea)) revisionFail('IDEA_PLAN_REVISION_SOURCE_CHANGED', '候选、原方案或完整评价来源已变化，模型结果保留。');
    };
    let sourceInput;
    if (original) {
      sourceInput = structuredClone(original.request.input);
      if (sourceHash(sourceInput.revisionSource) !== sourceHash(prepared.revisionSource) || sourceHash(sourceInput.validationCampaign) !== sourceHash(prepared.material)
        || sourceHash(sourceInput.previousPlan) !== sourceHash(prepared.previousPlan) || sourceHash(sourceInput.idea) !== sourceHash(prepared.idea)) revisionFail('IDEA_PLAN_REVISION_SOURCE_CHANGED', '原Run冻结输入与当前指定来源不一致。');
    } else {
      const availableDatasets = [];
      for (const item of (await datasetService.list(projectId)).datasets) { const data = await datasetService.get(projectId, item.id); availableDatasets.push({ id: data.id, sha256: data.sha256, filename: data.filename }); }
      sourceInput = { ideaId, expectedRevision: normalized.expectedRevision, idea: prepared.idea, previousPlan: prepared.previousPlan,
        validationCampaign: prepared.material, revisionSource: prepared.revisionSource, availableDatasets, relatedWork: prepared.previousPlan.relatedWork || null,
        instructions: 'Design a concrete revised hypothesis and evaluation plan from the explicitly selected suggestions and ALL recorded failed, negative and missing results. Do not invent measurements, datasets, papers or new searches; use only available fixed dataset versions. Unknown fields may remain blank/null drafts. Budgets are proposals until the human starts a new attempt. Preserve existing literature limitations; no novelty is verified.' };
    }
    let invoked = false;
    const runHarness = async request => {
      if (invoked) revisionFail('IDEA_PLAN_REVISION_OUTPUT_INVALID', '原结构输出未通过校验，不自动派发第二个模型；原Run保留。', 422, { runId: original?.id });
      invoked = true; await guard();
      const controlled = await prepareCampaignWritingRequest(projectId, { ...request, source: 'idea-plan-revision', requestId, revisionIdentity: { ideaId, requestSha256 },
        capabilities: [], researchSkills: [], researchSkillMetadata: [], role: 'innovation-agent', fallback: false, limits: { retryLimit: 0 },
        llmConfig: { runtime: 'deepseek-harness', endpoint: getEnv('LLM_ENDPOINT'), model: getEnv('LLM_MODEL') }, adapter: runtime.adapter || 'deepseek' });
      if (original && original.request.prompt !== controlled.prompt) revisionFail('IDEA_PLAN_REVISION_SOURCE_CHANGED', '原Run的完整prompt合同发生变化，不重新派发。');
      if (!original) original = await createHarnessRun(projectId, controlled, { ideaPlanRevisionAdmission: true });
      pending.set(projectId, original.id);
      try {
        assertCampaignWritingContext(original, controlled);
        const constraints = await readProjectConstraints(await resolveHarnessProjectRoot(projectId));
        const maxTokens = Number.isFinite(Number(constraints.maxTokens)) ? Math.min(original.limits.maxTokens, Number(constraints.maxTokens)) : original.limits.maxTokens;
        if (original.contextPack.budget.estimatedTokens + 2048 > maxTokens) revisionFail('IDEA_PLAN_REVISION_TOKEN_BUDGET', '原模型总token上限不足以保留完整来源并生成结构方案；未启动模型。', 413);
      } catch (error) { if (original.status === 'created') await cancelHarnessRun(projectId, original.id); throw error; }
      await guard();
      const run = original.status === 'completed' ? await getHarnessRun(projectId, original.id) : await startHarnessRun(projectId, original.id, { wait: true, signal: runtime.signal });
      return { ok: run.status === 'completed', reply: run.reply || '', runId: run.id, patches: run.patches || [], error: run.error, runtime: run.adapter, fallback: false };
    };
    await guard();
    const result = await runStage({ projectId, stage: 'hypothesis_plan', workflowStage: 'ideation', input: sourceInput, role: 'innovation-agent',
      llmConfig: { runtime: 'deepseek-harness', endpoint: getEnv('LLM_ENDPOINT'), model: getEnv('LLM_MODEL') }, adapter: runtime.adapter || 'deepseek',
      fakeResponse: runtime.fakeResponse, fakeError: runtime.fakeError, context: { kind: 'next-plan-version', requestSha256 }, runHarness });
    const parsed = getResearchStageSchema('hypothesis_plan').safeParse(result.output);
    if (!result.ok || !parsed.success || parsed.data.ideaId !== ideaId) revisionFail('IDEA_PLAN_REVISION_OUTPUT_INVALID', '原模型未返回当前候选的结构方案，Run保留且方案未覆盖。', 422, { runId: result.runId || original?.id });
    const proposal = parsed.data; let generationIssue;
    if ((proposal.evaluation.dataset || proposal.evaluation.datasetVersion) && !sourceInput.availableDatasets.some(data => data.id === proposal.evaluation.dataset && data.sha256 === proposal.evaluation.datasetVersion)) {
      proposal.evaluation.dataset = ''; proposal.evaluation.datasetVersion = ''; generationIssue = '模型提出的数据未对应本项目固定版本，已清空；请选真实数据后确认方案。';
    }
    await guard(); await assertIdeaPlanRevisionIdle(projectId);
    return saveGeneratedNextIdeaPlan(projectId, ideaId, { ...normalized, hypothesis: proposal.hypothesis, evaluation: proposal.evaluation },
      { sourceRunId: result.runId, expectedSource: prepared.revisionSource, generationRequest: normalized, generationIssue });
  } finally { pending.delete(projectId); }
}
