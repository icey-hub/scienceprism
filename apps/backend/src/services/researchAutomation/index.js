import { randomUUID } from 'node:crypto';
import { readAutomation, mutateAutomation, allowsAutomatic, automaticWorkflowDecision, requireAutomatic, AUTOMATION_PARTS, validateAutomationExecution } from './policy.js';
import { RESEARCH_SPECIALISTS } from './agents.js';
import { prepareAutomationStage } from './stages.js';
import { getResearchWorkflow } from '../researchWorkflow/queries.js';
import { initializeResearchWorkflow, updateResearchWorkflow, mutateWorkflow } from '../researchWorkflow/commands.js';
import { getStageReadiness, RESEARCH_WORKFLOW_STAGES } from '../researchWorkflow/stageContracts.js';
import { stageData } from '../researchWorkflow/application.js';
import { createExperimentRun, automaticallyApproveExperiment, startExperimentRun, getExperimentRun, cancelExperimentRun, experimentRunSummary } from '../experimentRunner/index.js';
import { getEvidenceLedger } from '../evidenceLedger/index.js';
import { getHarnessRun, decideHarnessRun, applyHarnessRunPatches } from '../harnessRuntime/index.js';
import { appendAudit } from '../researchWorkflow/audit.js';
import { ResearchWorkflowError } from '../researchWorkflow/errors.js';
import { withWorkflowLock } from '../researchWorkflow/repository.js';

const workers = new Map();
let queue = Promise.resolve();
const stageIds = RESEARCH_WORKFLOW_STAGES.map(stage => stage.id);
const requireHuman = actor => { if (actor !== 'human') throw new ResearchWorkflowError(403, 'HUMAN_INPUT_REQUIRED', '由用户启动、继续或停止研究链路。'); };
const now = () => new Date().toISOString();
const waiting = part => new ResearchWorkflowError(409, 'AUTOMATION_CONFIRMATION_REQUIRED', '该环节等待人工确认，确认后可继续链路。', { part });

export async function getAutomation(projectId) {
  const state = await readAutomation(projectId);
  if (state.session?.status === 'stopping' && !workers.has(projectId)) state.session = { ...state.session, status: 'stopped', message: '停止请求已保留；服务重启后没有继续后台链路。' };
  if (state.session && ['running', 'queued'].includes(state.session.status) && !workers.has(projectId)) state.session = { ...state.session, status: 'interrupted', message: '服务已重启；已完成步骤保留，请继续并检查未结束的Run。' };
  return { ...state, parts: AUTOMATION_PARTS, agents: RESEARCH_SPECIALISTS };
}

async function changeSession(projectId, id, change) {
  return mutateAutomation(projectId, state => {
    if (state.session?.id !== id) throw new ResearchWorkflowError(409, 'AUTOMATION_SESSION_CHANGED', '研究会话已变化。');
    Object.assign(state.session, change, { updatedAt: now() });
  });
}

async function changeStep(projectId, id, stage, change) {
  return mutateAutomation(projectId, state => {
    if (state.session?.id !== id) throw new ResearchWorkflowError(409, 'AUTOMATION_SESSION_CHANGED', '研究会话已变化。');
    const step = state.session.steps.find(step => step.stage === stage);
    Object.assign(step, change, { updatedAt: now() });
    state.session.currentStage = stage;
    state.session.updatedAt = now();
  });
}

async function checkpoint(projectId, control) {
  const state = await readAutomation(projectId);
  if (control.stop || state.session?.id !== control.id || state.session.stopRequested) throw new ResearchWorkflowError(409, 'AUTOMATION_STOPPED', '已停止后续步骤。');
  const workflow = await getResearchWorkflow(projectId);
  if (workflow.id !== state.session.workflowId) throw new ResearchWorkflowError(409, 'AUTOMATION_WORKFLOW_CHANGED', '研究流程已被替换。');
  return { state, workflow };
}

async function executeStep(projectId, control, stage) {
  let { state, workflow } = await checkpoint(projectId, control);
  let step = state.session.steps.find(step => step.stage === stage);
  if (step.skipped) return;
  if (step.result) {
    if (step.result.status !== 'completed') throw new ResearchWorkflowError(409, 'AUTOMATION_EXPERIMENT_FAILED', '已保留失败实验，请检查或重试，不能作为已完成结果推进。');
    return;
  }
  if (!step.experimentRunId) {
    const saved = stageData(workflow, stage), plan = saved.executionPlan || saved;
    const run = await createExperimentRun(projectId, { sourceStage: stage, expectedVersion: workflow.version,
      ...(stage === 'replication' ? { plan: { execution: plan.execution, parameters: plan.parameters, seed: plan.seed, resources: plan.resources, artifacts: plan.artifacts } } : {}) }, { actor: 'system' });
    await changeStep(projectId, control.id, stage, { experimentRunId: run.id, status: 'awaiting_execution' });
    step = { ...step, experimentRunId: run.id };
  }
  let run = await getExperimentRun(projectId, step.experimentRunId);
  if (['running', 'created'].includes(run.status)) throw new ResearchWorkflowError(409, 'AUTOMATION_RUN_UNRESOLVED', '实验仍在执行或尚未确定状态；不会重复启动。');
  if (run.status === 'awaiting_approval') {
    ({ state } = await checkpoint(projectId, control));
    if (!allowsAutomatic(state.policy, 'execution')) throw waiting('execution');
    run = await automaticallyApproveExperiment(projectId, run.id, control.id);
  }
  if (run.status === 'approved') {
    await checkpoint(projectId, control);
    control.experimentRunId = run.id;
    await changeStep(projectId, control.id, stage, { status: 'executing' });
    run = await startExperimentRun(projectId, run.id, { wait: true });
    control.experimentRunId = null;
  }
  await changeStep(projectId, control.id, stage, { result: experimentRunSummary(run, (await getEvidenceLedger(projectId)).entries), status: run.status === 'completed' ? 'completed' : 'failed' });
  await recordAutomationRun(projectId, stage, experimentRunSummary(run, (await getEvidenceLedger(projectId)).entries));
  if (run.status !== 'completed') throw new ResearchWorkflowError(409, 'AUTOMATION_EXPERIMENT_FAILED', '实验未完成，日志和产物已保留，请检查后重试实验。');
}

async function walk(projectId, control, runtime) {
  try {
    await checkpoint(projectId, control);
    await changeSession(projectId, control.id, { status: 'running', message: '' });
    for (const stage of stageIds) {
      let { state, workflow } = await checkpoint(projectId, control);
      let step = state.session.steps.find(step => step.stage === stage);
      if (!step) continue;
      if (step.status === 'completed') continue;
      const savedStage = workflow.stages.find(item => item.id === stage);
      if (savedStage.status === 'rejected' || workflow.status === 'blocked') throw new ResearchWorkflowError(409, 'AUTOMATION_REJECTED', '阶段已拒绝，请修订或恢复流程后继续。');
      if (!['approved', 'skipped'].includes(savedStage.status)) {
        if (workflow.currentStage !== stage) throw new ResearchWorkflowError(409, 'AUTOMATION_STAGE_CHANGED', '阶段位置已变化，请检查当前流程。');
        if (stage === 'replication' && state.session.skipReplication) {
          if (!allowsAutomatic(state.policy, stage)) throw waiting(stage);
          workflow = await automaticWorkflowDecision(projectId, { sessionId: control.id, stageId: stage, expectedVersion: workflow.version, decision: 'skip', note: '用户启动时选择跳过论文复现。' });
          await changeStep(projectId, control.id, stage, { skipped: true, status: 'completed' });
          continue;
        }
        if (!step.prepared && !getStageReadiness(workflow, stage).ready) {
          if (step.status === 'preparing' && step.runIds?.length) throw new ResearchWorkflowError(409, 'AUTOMATION_RUN_UNRESOLVED', '上次Agent步骤中断，已保留Run；请检查并在阶段页保存结果后继续，避免重复调用。');
          await changeStep(projectId, control.id, stage, { status: 'preparing', startedAt: now() });
          workflow = await prepareAutomationStage(projectId, workflow, state.session, state.policy, runtime, change => changeStep(projectId, control.id, stage, change));
          await changeStep(projectId, control.id, stage, { prepared: true, status: 'awaiting_confirmation' });
        }
        ({ state, workflow } = await checkpoint(projectId, control));
        if (!allowsAutomatic(state.policy, stage)) throw waiting(stage);
        if (stage === 'selection' && !stageData(workflow, stage).selectedPaperIds?.length) workflow = await automaticWorkflowDecision(projectId, { sessionId: control.id, stageId: stage, expectedVersion: workflow.version, paperIds: stageData(workflow, stage).automaticSelectionProposal?.paperIds });
        if (stage === 'ideation' && stage !== state.session.targetStage) {
          const ideas = stageData(workflow, stage).ideas || [];
          if (!ideas.some(idea => idea.selected)) workflow = await updateResearchWorkflow(projectId, { actor: 'system', stageId: stage, expectedVersion: workflow.version, data: { ideas: ideas.map((idea, index) => ({ ...idea, selected: index === 0 })) } });
        }
        workflow = await automaticWorkflowDecision(projectId, { sessionId: control.id, stageId: stage, expectedVersion: workflow.version });
        await changeStep(projectId, control.id, stage, { approved: true, status: 'approved' });
      }
      if (['replication', 'experiment'].includes(stage) && savedStage.status !== 'skipped') await executeStep(projectId, control, stage);
      await checkpoint(projectId, control);
      await changeStep(projectId, control.id, stage, { status: 'completed', completedAt: now() });
      if (stage === state.session.targetStage) break;
    }
    await checkpoint(projectId, control);
    await changeSession(projectId, control.id, { status: 'completed', message: '已完成所选研究链路。' });
  } catch (error) {
    const status = control.stop || error.code === 'AUTOMATION_STOPPED' ? 'stopped' : error.code === 'AUTOMATION_CONFIRMATION_REQUIRED' ? 'waiting_confirmation' : 'blocked';
    await changeSession(projectId, control.id, { status, message: error.message, error: { code: error.code || 'AUTOMATION_FAILED', message: error.message, details: error.details } });
  } finally { if (workers.get(projectId) === control) workers.delete(projectId); }
}

export async function startAutomation(projectId, input = {}, runtime = {}) {
  requireHuman(input.actor);
  const executionPlan = validateAutomationExecution(input.executionPlan);
  if (workers.has(projectId)) throw new ResearchWorkflowError(409, 'AUTOMATION_ACTIVE', '该项目已有执行链路。');
  const control = { id: randomUUID(), stop: false, experimentRunId: null };
  workers.set(projectId, control);
  try {
    let workflow;
    try { workflow = await getResearchWorkflow(projectId); }
    catch (error) { if (error.code !== 'WORKFLOW_NOT_FOUND') throw error; workflow = await initializeResearchWorkflow(projectId, { actor: 'human', data: { researchQuestion: String(input.question || '').trim() } }); }
    if (workflow.status === 'completed') throw new ResearchWorkflowError(409, 'WORKFLOW_COMPLETED', '当前研究流程已完成，请保留记录或另建研究流程。');
    const targetStage = input.targetStage || 'ideation';
    if (!stageIds.includes(targetStage) || stageIds.indexOf(targetStage) < stageIds.indexOf(workflow.currentStage)) throw new ResearchWorkflowError(400, 'INVALID_AUTOMATION_TARGET', '结束阶段不能早于当前阶段。');
    if (workflow.currentStage === 'direction' && input.question) workflow = await updateResearchWorkflow(projectId, { actor: 'human', stageId: 'direction', expectedVersion: workflow.version, data: { researchQuestion: String(input.question).slice(0, 4000).trim() } });
    const state = await mutateAutomation(projectId, state => {
      if (state.session && !['completed', 'stopped'].includes(state.session.status)) throw new ResearchWorkflowError(409, 'AUTOMATION_SESSION_EXISTS', '请继续或停止已有链路，避免重复执行。');
      state.session = { id: control.id, workflowId: workflow.id, status: 'queued', targetStage, skipReplication: input.skipReplication === true,
        executionPlan, createdAt: now(), updatedAt: now(), stopRequested: false,
        steps: stageIds.slice(stageIds.indexOf(workflow.currentStage), stageIds.indexOf(targetStage) + 1).map(stage => ({ stage, status: 'pending', runIds: [] })) };
    });
    queue = queue.catch(() => {}).then(() => walk(projectId, control, runtime));
    return state;
  } catch (error) { workers.delete(projectId); throw error; }
}

export async function resumeAutomation(projectId, input = {}, runtime = {}) {
  requireHuman(input.actor);
  const executionPlan = validateAutomationExecution(input.executionPlan);
  if (workers.has(projectId)) throw new ResearchWorkflowError(409, 'AUTOMATION_ACTIVE', '链路仍在运行。');
  const state = await readAutomation(projectId);
  if (!state.session || state.session.status === 'completed') throw new ResearchWorkflowError(409, 'AUTOMATION_NOT_RESUMABLE', '没有可继续的研究链路。');
  const control = { id: state.session.id, stop: false, experimentRunId: null };
  workers.set(projectId, control);
  try {
    const updated = await changeSession(projectId, control.id, { status: 'queued', stopRequested: false, message: '', error: null, attempt: (state.session.attempt || 0) + 1,
      ...(executionPlan ? {executionPlan} : {}),
      steps: state.session.steps.map(step => ({...step, ...(state.session.status==='blocked' && step.status==='preparing' ? {status:'pending'} : {})})) });
    queue = queue.catch(() => {}).then(() => walk(projectId, control, runtime));
    return updated;
  } catch (error) { workers.delete(projectId); throw error; }
}

export async function stopAutomation(projectId, { actor } = {}) {
  requireHuman(actor);
  const control = workers.get(projectId);
  if (control) { control.stop = true; if (control.experimentRunId) await cancelExperimentRun(projectId, control.experimentRunId); }
  return mutateAutomation(projectId, state => {
    if (state.session && state.session.status !== 'completed') Object.assign(state.session, { stopRequested: true, status: control ? 'stopping' : 'stopped', message: control ? '当前模型响应结束后停止；正在执行的实验已请求取消。' : '已停止。', updatedAt: now() });
  });
}

export async function automaticallyApplyPatches(projectId, runId) {
  return withWorkflowLock(projectId, async () => {
  const authorization = await requireAutomatic(projectId, 'patches');
  const run = await getHarnessRun(projectId, runId);
  if (run.status !== 'completed' || run.request?.source !== 'editor') throw new ResearchWorkflowError(409, 'AUTOMATION_PATCH_NOT_APPLICABLE', '只能自动应用已完成的项目对话修改。');
  if (run.humanDecision?.status === 'rejected' || Object.values(run.patchDecisions || {}).some(decision => decision.status === 'rejected')) throw new ResearchWorkflowError(409, 'AUTOMATION_PATCH_REJECTED', '已拒绝的修改不会被自动应用。');
  await decideHarnessRun(projectId, runId, { decision: 'accept', actor: 'system', note: `自动文稿应用（策略v${authorization.policyVersion}）` });
  return applyHarnessRunPatches(projectId, runId, { actor: 'system' });
  });
}

export async function recordAutomationRun(projectId, stageId, result) {
  const workflow = await getResearchWorkflow(projectId);
  return mutateWorkflow(projectId, { command: 'record-automation-result', expectedVersion: workflow.version, mutate: workflow => {
    workflow.stages.find(stage => stage.id === stageId).data.automaticResult = result;
    appendAudit(workflow, 'automation.result', { actor: 'system', stageId, details: { runId: result.id } });
    return workflow;
  } });
}
