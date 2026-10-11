import { runUiAction, stageData } from '../researchWorkflow/application.js';
import { updateResearchWorkflow } from '../researchWorkflow/commands.js';
import { runResearchStage } from '../researchResearch/index.js';
import { createStageTask } from '../researchWorkflow/stageTask.js';
import { snapshotExperimentCode } from '../experimentRunner/manifest.js';
import { resolveProjectRoot } from '../researchWorkflow/repository.js';
import { ResearchWorkflowError } from '../researchWorkflow/errors.js';
import { automationRole } from './agents.js';

export async function prepareAutomationStage(projectId, workflow, session, policy, runtime, saveStep) {
  const stage = workflow.currentStage, role = automationRole(stage, policy.agentMode);
  const direction = stageData(workflow, 'direction');
  const body = { expectedVersion: workflow.version, role, llmConfig: runtime.llmConfig, adapter: runtime.adapter,
    idempotencyKey: `${session.id}:${stage}:prepare:${session.attempt || 0}`, ...runtime.testInput?.[stage] };
  const humanInstructions = Object.entries(workflow.humanInstructions || {}).map(([stage, value]) => `${stage}: ${value}`).join('\n');
  const run = async (contract, input) => {
    const result = await runResearchStage({ stage: contract, workflowStage: stage, projectId, input, role, humanInstructions, llmConfig: runtime.llmConfig, adapter: runtime.adapter, ...runtime.testInput?.[contract] });
    if (result.runId) await saveStep({ runIds: [...new Set([...(session.steps.find(step => step.stage === stage)?.runIds || []), result.runId])] });
    if (!result.ok || !result.output) throw new ResearchWorkflowError(409, 'AUTOMATION_MODEL_FAILED', 'Agent输出未通过校验，已保留Run供检查。', result.validation);
    return result;
  };
  const update = data => updateResearchWorkflow(projectId, { actor: 'system', stageId: stage, data, expectedVersion: workflow.version, idempotencyKey: `${session.id}:${stage}:prepare:${session.attempt || 0}` });

  if (stage === 'direction') {
    if (!String(direction.researchQuestion || direction.topic || '').trim()) throw new ResearchWorkflowError(409, 'RESEARCH_QUESTION_REQUIRED', '请先填写研究问题。');
    return workflow;
  }
  if (stage === 'search') {
    const next = await runUiAction(projectId, { ...body, action: 'search', direction: { question: direction.researchQuestion || direction.topic }, query: direction.researchQuestion || direction.topic, maxResults: 10 }, 'system');
    const task = stageData(next, stage).task;
    if (task.harness?.runId) await saveStep({ runIds: [task.harness.runId] });
    if (!stageData(next, stage).papers?.length || task.validation?.ok === false) throw new ResearchWorkflowError(409, 'AUTOMATION_NO_PAPERS', '检索没有得到可用论文，请检查来源与检索条件。');
    return next;
  }
  if (stage === 'selection') {
    const candidates = (stageData(workflow, 'search').evaluations || []).filter(item => item.decision === 'accept').map(item => item.candidate);
    if (!candidates.length) throw new ResearchWorkflowError(409, 'AUTOMATION_QUALITY_GATE', '论文尚未通过质量门禁，请补充来源信息或调整检索条件。');
    const result = await run('paper_selection', { candidates });
    if (result.output.paperIds.some(id => !candidates.some(paper => String(paper.id) === id))) throw new ResearchWorkflowError(409, 'AUTOMATION_UNKNOWN_PAPER', '筛选Agent引用了候选列表以外的论文。');
    return update({ automaticSelectionProposal: result.output, task: createStageTask({ stage, harness: result, input: { candidates }, output: result.output }) });
  }
  if (stage === 'replication' || stage === 'experiment') {
    const files = (await snapshotExperimentCode(await resolveProjectRoot(projectId))).files.map(file => file.path);
    const papers = stageData(workflow, 'selection').selectedPapers || [];
    const saved = stageData(workflow, stage);
    let plan = session.executionPlan || saved.executionPlan;
    if (!plan) {
      const result = await run('execution_proposal', { papers, savedPlan: saved, method: stageData(workflow, 'method'), availableFiles: files, instructions: 'Choose an existing code entrypoint and a real recorded dataset/version. If data or code is missing, return plan:null and list missing materials. Do not fabricate a runnable reproduction.' });
      if (!result.output.plan || result.output.missing.length) throw new ResearchWorkflowError(409, 'AUTOMATION_MATERIALS_REQUIRED', `需要补充复现/实验材料：${result.output.missing.join('；') || '代码入口、数据及版本'}`);
      plan = result.output.plan;
    }
    if (!files.includes(plan.execution?.entrypoint) || !plan.dataset || !plan.datasetVersion) throw new ResearchWorkflowError(409, 'AUTOMATION_MATERIALS_REQUIRED', '项目内需要可运行的代码入口、真实数据和数据版本。');
    // The Runner validates paths, resources and snapshots again before dispatch.
    if (stage === 'replication') {
      const result = await run('reproduction_plan', { papers, paperId: papers[0]?.id, executionPlan: plan });
      if (!papers.some(paper => String(paper.id) === result.output.paperId)) throw new ResearchWorkflowError(409, 'AUTOMATION_UNKNOWN_PAPER', '复现计划必须引用已选论文。');
      return update({ executionPlan: plan, replication: { repository: papers[0]?.codeUrl || 'project-workspace', environment: `${process.platform}; node ${process.version}`, dataset: plan.dataset, datasetVersion: plan.datasetVersion, note: result.output.objective, expectedMetrics: result.output.expectedOutputs.join('\n'), aiPlan: result.output }, task: createStageTask({ stage, harness: result, input: { papers, plan }, output: result.output }) });
    }
    const method = stageData(workflow, 'method').method || {};
    const result = await run('experiment_plan', { method, methodId: method.id || method.title, datasetIds: [plan.dataset], baselineIds: method.baselines || [] });
    if (result.output.methodId !== (method.id || method.title) || !result.output.datasetIds.includes(plan.dataset)) throw new ResearchWorkflowError(409, 'AUTOMATION_PLAN_MISMATCH', '实验计划不属于当前方法或数据。');
    return update({ ...plan, methodId: method.id || method.title, seed: String(plan.seed ?? 0), repetitions: result.output.repetitions, budget: result.output.computeBudget || '既有运行器资源上限', successCriteria: result.output.successCriteria, task: createStageTask({ stage, harness: result, input: { method, plan }, output: result.output }) });
  }
  const action = { ideation: 'generate-ideas', method: 'generate-method', writing: 'handoff-writing' }[stage];
  if (!action) throw new ResearchWorkflowError(409, 'AUTOMATION_STAGE_UNSUPPORTED', '该阶段没有执行器。');
  const results = session.steps.filter(step => step.result).map(step => step.result);
  const next = await runUiAction(projectId, { ...body, action, replicationResults: results,
    ...(session.steps.find(step => step.stage === 'replication')?.experimentRunId ? { replicationRunId: session.steps.find(step => step.stage === 'replication').experimentRunId } : {}),
    ...(session.steps.find(step => step.stage === 'experiment')?.experimentRunId ? { experimentRunId: session.steps.find(step => step.stage === 'experiment').experimentRunId } : {}) }, 'system');
  const task = stageData(next, stage).task;
  if (task?.harness?.runId) await saveStep({ runIds: [task.harness.runId] });
  if (task?.validation?.ok === false || task?.status === 'failed') throw new ResearchWorkflowError(409, 'AUTOMATION_MODEL_FAILED', '当前阶段Agent输出未通过校验。');
  return next;
}
