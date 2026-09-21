import { randomUUID } from 'node:crypto';
import { listHarnessRuns, cancelHarnessRun, replayHarnessRun } from '../harnessRuntime/index.js';
import { getResearchWorkflow } from '../researchWorkflow/index.js';
import { clone, readHubJson, withHubLock, writeHubJson } from './repository.js';

const FILE = 'tasks.json';
const MAX_TASKS = 500;
const TASK_STATUSES = new Set(['queued', 'running', 'paused', 'completed', 'failed', 'cancelled']);

function now() { return new Date().toISOString(); }
function emptyTasks(projectId) { return { schemaVersion: 1, projectId, version: 1, tasks: [], updatedAt: now() }; }
function text(value) { return typeof value === 'string' ? value.trim() : ''; }

function normalizeTask(input, existing = {}) {
  const at = now();
  const status = TASK_STATUSES.has(input.status) ? input.status : (existing.status || 'queued');
  return {
    ...existing,
    ...input,
    id: existing.id || input.id || `task-${randomUUID()}`,
    kind: text(input.kind || existing.kind) || 'generic',
    title: text(input.title || existing.title) || 'Project task',
    status,
    progress: Number.isFinite(Number(input.progress)) ? Math.max(0, Math.min(100, Number(input.progress))) : (existing.progress || 0),
    stage: text(input.stage || existing.stage) || null,
    log: Array.isArray(input.log) ? input.log.map(String).slice(-200) : (existing.log || []),
    error: input.error === undefined ? (existing.error || null) : input.error,
    retryable: input.retryable === undefined ? Boolean(existing.retryable) : Boolean(input.retryable),
    metadata: { ...(existing.metadata || {}), ...(input.metadata || {}) },
    createdAt: existing.createdAt || at,
    startedAt: input.startedAt || existing.startedAt || (status === 'running' ? at : null),
    finishedAt: input.finishedAt || existing.finishedAt || (['completed', 'failed', 'cancelled'].includes(status) ? at : null),
    updatedAt: at
  };
}

async function readTasks(projectId) {
  return readHubJson(projectId, FILE, () => emptyTasks(projectId));
}

export async function createTask(projectId, input) {
  return withHubLock(projectId, async () => {
    const document = await readTasks(projectId);
    const task = normalizeTask(input);
    document.tasks.unshift(task);
    document.tasks = document.tasks.slice(0, MAX_TASKS);
    document.version += 1;
    document.updatedAt = now();
    await writeHubJson(projectId, FILE, document);
    return clone(task);
  });
}

export async function updateTask(projectId, taskId, patch) {
  return withHubLock(projectId, async () => {
    const document = await readTasks(projectId);
    const index = document.tasks.findIndex((task) => task.id === taskId);
    if (index < 0) throw new Error('Task not found.');
    const task = normalizeTask(patch, document.tasks[index]);
    document.tasks[index] = task;
    document.version += 1;
    document.updatedAt = now();
    await writeHubJson(projectId, FILE, document);
    return clone(task);
  });
}

function harnessTask(run) {
  return normalizeTask({
    id: `harness:${run.id}`,
    kind: 'harness',
    title: `${run.stage || 'Research'} Harness Run`,
    status: run.status === 'succeeded' ? 'completed' : run.status === 'created' ? 'queued' : run.status,
    progress: ['succeeded', 'failed', 'cancelled'].includes(run.status) ? 100 : 50,
    stage: run.stage,
    log: (run.events || []).map((event) => event.message || event.type || JSON.stringify(event)),
    error: run.error || null,
    retryable: ['failed', 'paused'].includes(run.status),
    metadata: { runId: run.id, adapter: run.adapter, model: run.model, contextHash: run.contextHash },
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    updatedAt: run.updatedAt
  });
}

function stageTask(stage) {
  const task = stage.data?.task;
  if (!task) return null;
  const isExperimentPlan = stage.id === 'experiment';
  return normalizeTask({
    id: `stage:${stage.id}:${task.id || stage.updatedAt}`,
    kind: isExperimentPlan ? 'experiment' : 'research-stage',
    title: isExperimentPlan ? `${stage.label} plan` : `${stage.label} task`,
    status: isExperimentPlan ? (task.status === 'failed' ? 'failed' : 'queued') : (task.status === 'succeeded' || task.status === 'awaiting_approval' ? 'completed' : task.status === 'failed' ? 'failed' : 'running'),
    progress: task.status === 'failed' ? 100 : task.status === 'awaiting_approval' ? 100 : 50,
    stage: stage.id,
    log: [...(task.validation?.errors?.map((error) => error.message || JSON.stringify(error)) || []), ...(isExperimentPlan ? ['This is an Experiment Plan; controlled execution is not enabled in Phase 7.'] : [])],
    error: task.error || null,
    retryable: task.status === 'failed',
    metadata: { taskId: task.id, humanDecision: task.humanDecision || null, harnessRunId: task.harness?.runId || null, planOnly: isExperimentPlan },
    createdAt: task.createdAt,
    startedAt: task.startedAt,
    finishedAt: task.completedAt,
    updatedAt: stage.updatedAt
  });
}

export async function listTasks(projectId, { status, kind, limit = 100 } = {}) {
  const stored = await readTasks(projectId);
  const taskMap = new Map(stored.tasks.map((task) => [task.id, task]));
  try {
    const runs = await listHarnessRuns(projectId, { limit: 100 });
    for (const run of runs) taskMap.set(`harness:${run.id}`, harnessTask(run));
  } catch {}
  try {
    const workflow = await getResearchWorkflow(projectId);
    for (const stage of workflow.stages || []) {
      const task = stageTask(stage);
      if (task) taskMap.set(task.id, task);
    }
  } catch {}
  let tasks = [...taskMap.values()].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  if (status) tasks = tasks.filter((task) => task.status === status);
  if (kind) tasks = tasks.filter((task) => task.kind === kind);
  return tasks.slice(0, Math.max(1, Math.min(MAX_TASKS, Number(limit) || 100))).map(clone);
}

export async function getTask(projectId, taskId) {
  const tasks = await listTasks(projectId, { limit: MAX_TASKS });
  const task = tasks.find((item) => item.id === taskId);
  if (!task) throw new Error('Task not found.');
  return task;
}

export async function retryTask(projectId, taskId) {
  const task = await getTask(projectId, taskId);
  if (task.kind === 'harness' && task.metadata?.runId) {
    const run = await replayHarnessRun(projectId, task.metadata.runId, { start: true });
    return { task: harnessTask(run), run };
  }
  if (task.kind === 'experiment') throw new Error('Experiment Plans require human approval and a controlled runner.');
  if (!task.retryable) throw new Error('Task is not retryable.');
  const updated = await updateTask(projectId, taskId, { status: 'queued', progress: 0, error: null, log: ['Retry requested by human.'], finishedAt: null });
  return { task: updated };
}

export async function cancelTask(projectId, taskId) {
  const task = await getTask(projectId, taskId);
  if (task.kind === 'harness' && task.metadata?.runId) {
    const run = await cancelHarnessRun(projectId, task.metadata.runId);
    return { task: harnessTask(run), run };
  }
  if (!['queued', 'running', 'paused'].includes(task.status)) throw new Error('Task is no longer active.');
  return { task: await updateTask(projectId, taskId, { status: 'cancelled', progress: 100, finishedAt: now(), log: [...task.log, 'Cancelled by human.'] }) };
}

export async function getTaskSummary(projectId) {
  const tasks = await listTasks(projectId, { limit: MAX_TASKS });
  return {
    total: tasks.length,
    active: tasks.filter((task) => ['queued', 'running', 'paused'].includes(task.status)).length,
    failed: tasks.filter((task) => task.status === 'failed').length,
    completed: tasks.filter((task) => task.status === 'completed').length,
    recent: tasks.slice(0, 8)
  };
}

export { FILE as TASKS_FILE };
