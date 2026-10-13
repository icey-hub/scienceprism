import { randomUUID } from 'node:crypto';
import { readAutomation, mutateAutomation, allowsAutomatic, automaticWorkflowDecision, requireAutomatic, AUTOMATION_PARTS, validateAutomationExecution } from './policy.js';
import { RESEARCH_SPECIALISTS, automationRole } from './agents.js';
import { buildAutomationHandoff, assertAutomationHandoff, sourceHash } from './handoff.js';
import { claimAutomationOwner, inspectAutomationOwner } from './owner.js';
import { prepareAutomationStage } from './stages.js';
import { initializeAutomationExecutionPlan, applyAutomationExecutionPlan, bindAutomationExecutionPlan, isAutomationExecutionPlanLocked } from './executionPlan.js';
import { getResearchWorkflow } from '../researchWorkflow/queries.js';
import { initializeResearchWorkflow, updateResearchWorkflow, mutateWorkflow } from '../researchWorkflow/commands.js';
import { getStageReadiness, RESEARCH_WORKFLOW_STAGES } from '../researchWorkflow/stageContracts.js';
import { stageData } from '../researchWorkflow/application.js';
import { createExperimentRun, automaticallyApproveExperiment, startExperimentRun, getExperimentRun, cancelExperimentRun, experimentRunSummary } from '../experimentRunner/index.js';
import { readReplicationContextFromWorkflow, readExperimentContextFromWorkflow } from '../experimentRunner/replicationContext.js';
import { getEvidenceLedger } from '../evidenceLedger/index.js';
import { getHarnessRun, decideHarnessRun, applyHarnessRunPatches, createAutomationCoordinator, recordAutomationCoordinator, listHarnessRuns, recoverHarnessRun } from '../harnessRuntime/index.js';
import { appendAudit } from '../researchWorkflow/audit.js';
import { ResearchWorkflowError } from '../researchWorkflow/errors.js';
import { withWorkflowLock, resolveProjectRoot } from '../researchWorkflow/repository.js';

const workers = new Map();
const heldOwners = new Map();
let queue = Promise.resolve();
const stageIds = RESEARCH_WORKFLOW_STAGES.map(stage => stage.id);
const requireHuman = actor => { if (actor !== 'human') throw new ResearchWorkflowError(403, 'HUMAN_INPUT_REQUIRED', '由用户启动、继续或停止研究链路。'); };
const now = () => new Date().toISOString();
const waiting = part => new ResearchWorkflowError(409, 'AUTOMATION_CONFIRMATION_REQUIRED', '该环节等待人工确认，确认后可继续链路。', { part });

async function claimOwner(projectId, sessionId) {
  const held = heldOwners.get(projectId);
  if (held) {
    if (held.sessionId !== sessionId) throw new ResearchWorkflowError(409, 'AUTOMATION_OWNER_BUSY', '该项目仍保留未结束链路的归属。');
    held.assertOwned(); return held;
  }
  const owner = claimAutomationOwner({ projectRoot: await resolveProjectRoot(projectId), sessionId });
  heldOwners.set(projectId, owner); return owner;
}

async function releaseOwner(projectId, control) {
  if (!control.owner) return;
  const state = await readAutomation(projectId);
  const ids = state.session?.id === control.id ? state.session.steps.flatMap(step => step.runIds || []) : [];
  const retained = (await Promise.all(ids.map(id => getHarnessRun(projectId, id)))).some(run => run.cleanup?.modelSlotRetained);
  if (control.owner.release({ stopConfirmed: !retained }) && heldOwners.get(projectId) === control.owner) heldOwners.delete(projectId);
}

async function recoverStages(projectId, control, runtime) {
  const { state } = await checkpoint(projectId, control);
  control.preparationPolicyVersion = state.version;
  for (const step of state.session.steps.filter(step => step.status !== 'completed')) {
    if (!step.calls?.length) continue;
    if (!step.handoff) throw new ResearchWorkflowError(409, 'AUTOMATION_RUN_UNRESOLVED', '旧步骤没有完整交接，不能自动对账。');
    await handoffCheckpoint(projectId, control, step.stage, step.handoff);
    for (const call of step.calls) {
      const run = await getHarnessRun(projectId, call.runId);
      if (run.kind !== 'research-stage' || run.automationSessionId !== control.id || run.parentRunId !== state.session.coordinatorRunId
        || JSON.stringify(run.request?.context?.automationHandoff) !== JSON.stringify(step.handoff)) throw new ResearchWorkflowError(409, 'AUTOMATION_RUN_OWNER_CHANGED', '中断Run不属于当前阶段交接。');
      if (run.status === 'completed' || run.status === 'created' || run.recovery?.status === 'ready' && !run.cleanup?.modelSlotRetained) continue;
      if (!run.retainedWorkspace || run.adapter !== 'deepseek') throw new ResearchWorkflowError(409, 'AUTOMATION_RUN_UNRESOLVED', '该中断Run没有可对账的持久运行记录。');
      await changeStep(projectId, control.id, step.stage, { status: 'recovering' });
      await recoverHarnessRun(projectId, run.id, { automationSessionId: control.id, signal: control.controller.signal, request: { llmConfig: runtime.llmConfig } });
      await handoffCheckpoint(projectId, control, step.stage, step.handoff);
      await changeStep(projectId, control.id, step.stage, { status: 'preparing', recoveredRunId: run.id });
    }
  }
}

async function ensureCoordinator(projectId, state) {
  let run = state.session.coordinatorRunId ? await getHarnessRun(projectId, state.session.coordinatorRunId)
    : (await listHarnessRuns(projectId, { source: 'research-automation', requestId: state.session.id, limit: 100 })).find(run => run.kind === 'research-coordinator');
  if (!run) run = await createAutomationCoordinator(projectId, state.session.id, state.session.workflowId);
  if (run.kind !== 'research-coordinator' || run.coordinatorSessionId !== state.session.id || run.request.input.workflowId !== state.session.workflowId || run.status !== 'created') throw new ResearchWorkflowError(409, 'AUTOMATION_COORDINATOR_CHANGED', '研究父任务已变化，不能继续派发。');
  return changeSession(projectId, state.session.id, { coordinatorRunId: run.id });
}

export async function getAutomation(projectId) {
  let state = await readAutomation(projectId);
  // A worker can persist its terminal state and leave the map while this read
  // is awaiting I/O. Re-read before interpreting that old snapshot as restart.
  if (state.session && ['running', 'queued', 'stopping'].includes(state.session.status) && !workers.has(projectId)) state = await readAutomation(projectId);
  if (state.session) {
    state.session = initializeAutomationExecutionPlan(state.session);
    state.session.executionPlanLocked = isAutomationExecutionPlanLocked(state.session);
  }
  const owner = inspectAutomationOwner({ projectRoot: await resolveProjectRoot(projectId) });
  if (owner && !owner.released && owner.present !== false && owner.sessionId === state.session?.id && !workers.has(projectId)) {
    return { ...state, session: { ...state.session, message: '该链路仍由另一执行进程持有，请在原进程查看或停止。' }, parts: AUTOMATION_PARTS, agents: RESEARCH_SPECIALISTS };
  }
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
  control.owner?.assertOwned();
  const state = await readAutomation(projectId);
  if (control.stop || state.session?.id !== control.id || state.session.stopRequested) throw new ResearchWorkflowError(409, 'AUTOMATION_STOPPED', '已停止后续步骤。');
  const workflow = await getResearchWorkflow(projectId);
  if (workflow.id !== state.session.workflowId) throw new ResearchWorkflowError(409, 'AUTOMATION_WORKFLOW_CHANGED', '研究流程已被替换。');
  return { state, workflow };
}

async function handoffCheckpoint(projectId, control, stage, handoff, savedWorkflow) {
  const { state, workflow } = await checkpoint(projectId, control);
  if (control.preparationPolicyVersion !== state.version && !allowsAutomatic(state.policy, stage)) throw waiting(stage);
  const step = state.session.steps.find(step => step.stage === stage);
  assertAutomationHandoff(handoff, { projectId, workflow: savedWorkflow || workflow, session: state.session, stage,
    role: step?.status === 'completed' ? handoff.role : automationRole(stage, state.policy.agentMode) });
}

async function bindStageExecutionPlan(projectId, control, stage, plan, origin) {
  await checkpoint(projectId, control);
  return mutateAutomation(projectId, state => {
    control.owner.assertOwned();
    if (control.stop || state.session?.id !== control.id || state.session.stopRequested || state.session.status !== 'running') throw new ResearchWorkflowError(409, 'AUTOMATION_STOPPED', '已停止计划消费。');
    state.session = bindAutomationExecutionPlan(state.session, stage, plan, { origin });
  });
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
    const saved = stageData(workflow, stage);
    const context = (stage === 'replication' ? readReplicationContextFromWorkflow : readExperimentContextFromWorkflow)(projectId, workflow, { expectedVersion: workflow.version });
    const plan = stage === 'replication' ? saved.executionPlan || saved : context.plan;
    const actual = validateAutomationExecution({ ...Object.fromEntries(['dataset', 'datasetVersion', 'protocol', 'execution', 'seed', 'successCriteria', 'artifacts', 'parameters', 'codePaths', 'resources'].filter(key => plan[key] !== undefined).map(key => [key, plan[key]])),
      ...(stage === 'replication' ? { dataset: context.plan.dataset, datasetVersion: context.plan.datasetVersion } : {}) });
    const materials = validateAutomationExecution(state.session.executionPlan || saved.task?.input?.plan || saved.executionPlan || actual);
    for (const evidence of [saved.task?.input?.plan, saved.executionPlan].filter(Boolean)) {
      if (sourceHash(validateAutomationExecution(evidence)) !== sourceHash(materials)) throw new ResearchWorkflowError(409, 'AUTOMATION_EXECUTION_PLAN_CHANGED', '阶段准备使用的实验材料与当前链路计划不同，请保留原任务。');
    }
    // The experiment planner supplies its own saved success criteria; the
    // execution fields, data and resources still belong to the bound input.
    const expected = { ...materials, seed: String(materials.seed), ...(stage === 'experiment' && saved.task?.output?.successCriteria ? { successCriteria: saved.task.output.successCriteria } : {}) };
    if (sourceHash({ ...actual, seed: String(actual.seed) }) !== sourceHash(expected)) throw new ResearchWorkflowError(409, 'AUTOMATION_EXECUTION_PLAN_CHANGED', '实际执行材料已偏离绑定的计划版本。');
    if (stage === 'replication' && saved.task?.output && (context.plan.note !== saved.task.output.objective || context.plan.expectedMetrics !== saved.task.output.expectedOutputs?.join('\n'))) throw new ResearchWorkflowError(409, 'AUTOMATION_EXECUTION_PLAN_CHANGED', '复现协议或预期输出已偏离已记录的模型计划。');
    await bindStageExecutionPlan(projectId, control, stage, materials, state.session.executionPlanOrigin || 'stage');
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
      if (step.handoff) await handoffCheckpoint(projectId, control, stage, step.handoff);
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
          if (step.status === 'preparing' && step.runIds?.length && !step.calls) throw new ResearchWorkflowError(409, 'AUTOMATION_RUN_UNRESOLVED', '旧步骤缺少调用前回执，请检查已保留Run，不能盲重跑。');
          const handoff = step.handoff || buildAutomationHandoff({ projectId, workflow, session: state.session, stage, role: automationRole(stage, state.policy.agentMode) });
          state = await changeStep(projectId, control.id, stage, { handoff, status: 'preparing', startedAt: step.startedAt || now() });
          control.preparationPolicyVersion = state.version;
          workflow = await prepareAutomationStage(projectId, workflow, state.session, state.policy,
            { ...runtime, signal: control.controller.signal, automationCheckpoint: savedWorkflow => handoffCheckpoint(projectId, control, stage, handoff, savedWorkflow),
              automationBindExecutionPlan: (plan, origin) => bindStageExecutionPlan(projectId, control, stage, plan, origin) },
            change => changeStep(projectId, control.id, stage, change));
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
    const stopped = control.stop || error.code === 'AUTOMATION_STOPPED';
    const state = await readAutomation(projectId);
    const ids = state.session?.id === control.id ? state.session.steps.flatMap(step => step.runIds || []) : [];
    const retained = stopped && (await Promise.all(ids.map(id => getHarnessRun(projectId, id)))).some(run => run.cleanup?.modelSlotRetained);
    if (retained) error = new ResearchWorkflowError(409, 'HARNESS_STOP_UNCONFIRMED', '运行器尚未确认停止，已有Run与工作区保留，请核对中断记录。');
    const status = retained ? 'blocked' : stopped ? 'stopped' : error.code === 'AUTOMATION_CONFIRMATION_REQUIRED' ? 'waiting_confirmation' : 'blocked';
    await changeSession(projectId, control.id, { status, message: error.message, error: { code: error.code || 'AUTOMATION_FAILED', message: error.message, details: error.details } });
  } finally {
    try {
      const state = await readAutomation(projectId);
      if (state.session?.id === control.id && state.session.coordinatorRunId) await recordAutomationCoordinator(projectId, state.session.coordinatorRunId,
        { sessionId: control.id, status: state.session.status, currentStage: state.session.currentStage });
    } finally { try { await releaseOwner(projectId, control); } finally { if (workers.get(projectId) === control) workers.delete(projectId); } }
  }
}

export async function startAutomation(projectId, input = {}, runtime = {}) {
  requireHuman(input.actor);
  const executionPlan = validateAutomationExecution(input.executionPlan);
  if (workers.has(projectId)) throw new ResearchWorkflowError(409, 'AUTOMATION_ACTIVE', '该项目已有执行链路。');
  const control = { id: randomUUID(), stop: false, experimentRunId: null, controller: new AbortController() };
  workers.set(projectId, control);
  try {
    control.owner = await claimOwner(projectId, control.id);
    let workflow;
    try { workflow = await getResearchWorkflow(projectId); }
    catch (error) { if (error.code !== 'WORKFLOW_NOT_FOUND') throw error; workflow = await initializeResearchWorkflow(projectId, { actor: 'human', data: { researchQuestion: String(input.question || '').trim() } }); }
    if (workflow.status === 'completed') throw new ResearchWorkflowError(409, 'WORKFLOW_COMPLETED', '当前研究流程已完成，请保留记录或另建研究流程。');
    const targetStage = input.targetStage || 'ideation';
    if (!stageIds.includes(targetStage) || stageIds.indexOf(targetStage) < stageIds.indexOf(workflow.currentStage)) throw new ResearchWorkflowError(400, 'INVALID_AUTOMATION_TARGET', '结束阶段不能早于当前阶段。');
    if (workflow.currentStage === 'direction' && input.question) workflow = await updateResearchWorkflow(projectId, { actor: 'human', stageId: 'direction', expectedVersion: workflow.version, data: { researchQuestion: String(input.question).slice(0, 4000).trim() } });
    const state = await mutateAutomation(projectId, state => {
      if (state.session && !['completed', 'stopped'].includes(state.session.status)) throw new ResearchWorkflowError(409, 'AUTOMATION_SESSION_EXISTS', '请继续或停止已有链路，避免重复执行。');
      state.session = initializeAutomationExecutionPlan({ id: control.id, workflowId: workflow.id, status: 'queued', targetStage, skipReplication: input.skipReplication === true,
        executionPlan, ownerPid: control.owner.pid, createdAt: now(), updatedAt: now(), stopRequested: false,
        ...(executionPlan ? { executionPlanOrigin: 'human' } : {}),
        steps: stageIds.slice(stageIds.indexOf(workflow.currentStage), stageIds.indexOf(targetStage) + 1).map(stage => ({ stage, status: 'pending', runIds: [] })) });
    });
    const prepared = await ensureCoordinator(projectId, state);
    queue = queue.catch(() => {}).then(() => walk(projectId, control, runtime));
    control.settled = queue;
    return prepared;
  } catch (error) { try { await releaseOwner(projectId, control); } finally { workers.delete(projectId); } throw error; }
}

export async function resumeAutomation(projectId, input = {}, runtime = {}) {
  requireHuman(input.actor);
  if (input.recoverExisting !== undefined && typeof input.recoverExisting !== 'boolean') throw new ResearchWorkflowError(400, 'INVALID_AUTOMATION_RECOVERY', '恢复选项必须为开关。');
  const executionPlan = validateAutomationExecution(input.executionPlan);
  const finishing = workers.get(projectId);
  if (finishing) {
    const snapshot = await readAutomation(projectId);
    if (!['completed', 'stopped', 'blocked', 'waiting_confirmation'].includes(snapshot.session?.status) || !finishing.settled) throw new ResearchWorkflowError(409, 'AUTOMATION_ACTIVE', '链路仍在运行。');
    await finishing.settled;
  }
  if (workers.has(projectId)) throw new ResearchWorkflowError(409, 'AUTOMATION_ACTIVE', '链路仍在运行。');
  const control = { id: null, stop: false, experimentRunId: null, controller: new AbortController() };
  workers.set(projectId, control);
  try {
    const state = await readAutomation(projectId);
    if (!state.session || state.session.status === 'completed') throw new ResearchWorkflowError(409, 'AUTOMATION_NOT_RESUMABLE', '没有可继续的研究链路。');
    const planUpdate = { executionPlan, expectedSessionId: input.expectedSessionId, expectedExecutionPlanVersion: input.expectedExecutionPlanVersion };
    applyAutomationExecutionPlan(state.session, planUpdate);
    control.id = state.session.id;
    control.owner = await claimOwner(projectId, control.id);
    const updated = await mutateAutomation(projectId, current => {
      if (current.session?.id !== control.id) throw new ResearchWorkflowError(409, 'AUTOMATION_SESSION_CHANGED', '研究会话已变化。');
      current.session = applyAutomationExecutionPlan(current.session, planUpdate);
      Object.assign(current.session, { status: 'queued', stopRequested: false, message: '', error: null, attempt: (current.session.attempt || 0) + 1, ownerPid: control.owner.pid, updatedAt: now() });
    });
    control.queued = true;
    const prepared = await ensureCoordinator(projectId, updated);
    if (input.recoverExisting) await recoverStages(projectId, control, runtime);
    queue = queue.catch(() => {}).then(() => walk(projectId, control, runtime));
    control.settled = queue;
    return prepared;
  } catch (error) {
    try {
      if (control.queued) await changeSession(projectId, control.id, { status: 'blocked', message: error.message, error: { code: error.code || 'AUTOMATION_RECOVERY_FAILED', message: error.message } });
      await releaseOwner(projectId, control);
    } finally { workers.delete(projectId); }
    throw error;
  }
}

export async function stopAutomation(projectId, { actor } = {}) {
  requireHuman(actor);
  const control = workers.get(projectId);
  const snapshot = await readAutomation(projectId);
  let stoppedControl;
  if (!control && snapshot.session && snapshot.session.status !== 'completed') {
    stoppedControl = { id: snapshot.session.id, owner: await claimOwner(projectId, snapshot.session.id) };
  }
  const runs = snapshot.session ? await Promise.all(snapshot.session.steps.flatMap(step => step.runIds || []).map(id => getHarnessRun(projectId, id))) : [];
  const unresolved = runs.some(run => run.cleanup?.modelSlotRetained);
  if (control) control.stop = true;
  let state;
  try { state = await mutateAutomation(projectId, state => {
    if (state.session && state.session.status !== 'completed') {
      const stopping = control && ['queued', 'running', 'stopping'].includes(state.session.status);
      const retained = unresolved || state.session.error?.code === 'HARNESS_STOP_UNCONFIRMED';
      Object.assign(state.session, { stopRequested: true, status: retained ? 'blocked' : stopping ? 'stopping' : 'stopped',
        message: retained ? '后续步骤已停止；原任务仍需核对进程停止状态。' : stopping ? '正在取消当前任务；已停止后续步骤。' : '已停止。', updatedAt: now() });
    }
  }); } finally { if (stoppedControl) await releaseOwner(projectId, stoppedControl); }
  control?.controller.abort(new ResearchWorkflowError(409, 'AUTOMATION_STOPPED', '已停止研究链路。'));
  if (control?.experimentRunId) await cancelExperimentRun(projectId, control.experimentRunId);
  return state;
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
