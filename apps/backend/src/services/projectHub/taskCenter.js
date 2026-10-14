import { randomUUID } from 'node:crypto';
import { cancelActiveCompile } from '../compileCancellation.js';
import { listHarnessRuns, getHarnessRun, cancelHarnessRun, replayHarnessRun } from '../harnessRuntime/index.js';
import { cancelExperimentRun, listExperimentRuns, retryExperimentRun } from '../experimentRunner/index.js';
import { getResearchWorkflow } from '../researchWorkflow/index.js';
import { clone, readHubJson, withHubLock, writeHubJson } from './repository.js';

const FILE = 'tasks.json';
const MAX_TASKS = 500;
const TASK_STATUSES = new Set(['queued', 'running', 'paused', 'awaiting_approval', 'approved', 'completed', 'failed', 'cancelled', 'rejected']);

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
    progress: input.progress === null ? null : Number.isFinite(Number(input.progress)) ? Math.max(0, Math.min(100, Number(input.progress))) : (existing.progress ?? 0),
    stage: text(input.stage || existing.stage) || null,
    log: Array.isArray(input.log) ? input.log.map(String).slice(-200) : (existing.log || []),
    error: input.error === undefined ? (existing.error || null) : input.error,
    retryable: input.retryable === undefined ? Boolean(existing.retryable) : Boolean(input.retryable),
    metadata: { ...(existing.metadata || {}), ...(input.metadata || {}) },
    createdAt: existing.createdAt || input.createdAt || at,
    startedAt: input.startedAt !== undefined ? input.startedAt : (existing.startedAt || (status === 'running' ? at : null)),
    // Deliberately its own list, not TERMINAL_HARNESS_RUN_STATUSES: this is the
    // task vocabulary, which also contains rejected, and a finished task is not
    // the same concept as a finished Harness Run. The strings coincide today.
    finishedAt: input.finishedAt !== undefined ? input.finishedAt : (existing.finishedAt || (['approved', 'completed', 'failed', 'cancelled', 'rejected'].includes(status) ? at : null)),
    updatedAt: input.updatedAt || at
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
    title: run.kind === 'codex-worker' ? 'Codex · 编码与检查' : `${run.stage || 'Research'} Harness Run`,
    status: run.status === 'succeeded' ? 'completed' : run.status === 'created' ? 'queued' : run.status,
    progress: ['succeeded', 'completed', 'failed', 'cancelled'].includes(run.status) ? 100 : null,
    stage: run.stage,
    log: (run.events || []).map((event) => event.message || event.type || JSON.stringify(event)),
    error: run.error || null,
    retryable: run.kind !== 'codex-worker' && ['failed', 'paused'].includes(run.status),
    metadata: { runId: run.id, adapter: run.adapter, model: run.model, contextHash: run.contextHash, parentRunId: run.parentRunId || null },
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
  const status = task.status === 'succeeded' ? 'completed'
    : TASK_STATUSES.has(task.status) ? task.status
      : stage.status === 'in_progress' ? 'running'
        : TASK_STATUSES.has(stage.status) ? stage.status : 'failed';
  return normalizeTask({
    id: `stage:${stage.id}:${task.id || stage.updatedAt}`,
    kind: isExperimentPlan ? 'experiment' : 'research-stage',
    title: isExperimentPlan ? `${stage.label} plan` : `${stage.label} task`,
    status,
    progress: ['approved', 'completed', 'failed', 'cancelled', 'rejected', 'awaiting_approval'].includes(status) ? 100 : null,
    stage: stage.id,
    log: [...(task.validation?.errors?.map((error) => error.message || JSON.stringify(error)) || []), ...(isExperimentPlan ? ['This is an Experiment Plan. Create and approve a controlled Experiment Run before execution.'] : [])],
    error: task.error || null,
    retryable: false,
    metadata: { taskId: task.id, humanDecision: task.humanDecision || null, harnessRunId: task.harness?.runId || null, planOnly: isExperimentPlan },
    createdAt: task.createdAt,
    startedAt: task.startedAt,
    finishedAt: ['approved', 'completed', 'failed', 'cancelled', 'rejected'].includes(status) ? task.humanDecision?.at || task.completedAt || task.updatedAt || stage.updatedAt : null,
    updatedAt: stage.updatedAt
  });
}

function experimentRunTask(run) {
  const status = run.status === 'approved' ? 'queued' : run.status;
  const isTrial = run.manifest?.purpose === 'engineering-trial';
  const sourceStage = isTrial ? run.manifest.trial?.authorization?.stage : run.manifest?.replication ? 'replication' : 'experiment';
  const stage = ['replication', 'experiment'].includes(sourceStage) ? sourceStage : 'experiment';
  const log = [
    `phase:${run.phase || 'plan'}`,
    ...(run.approval ? [`approval:${run.approval.decision} by ${run.approval.actor}`] : []),
    ...(run.execution?.error ? [`${run.execution.error.code}: ${run.execution.error.message}`] : []),
    ...(run.evidence?.runId ? [`evidence:${run.evidence.runId}`] : []),
    ...(run.evidenceError ? [`evidence-error:${run.evidenceError.message}`] : [])
  ];
  return normalizeTask({
    id: `experiment-run:${run.id}`,
    kind: 'experiment-run',
    title: `${isTrial ? '工程试跑' : 'Experiment Run'} ${run.id.slice(-8)}`,
    status,
    progress: ['completed', 'failed', 'cancelled', 'rejected'].includes(run.status) ? 100 : null,
    stage,
    log,
    error: run.error || null,
    retryable: !isTrial && !run.manifest?.campaign && run.status === 'failed',
    metadata: { runId: run.id, planId: run.planId, approval: run.approval, phase: run.phase, codeVersion: run.manifest?.code?.version || null, dataset: run.manifest?.dataset || null, evidence: run.evidence || null,
      ...(isTrial ? { purpose: 'engineering-trial', sourceStage: stage } : {}) },
    createdAt: run.createdAt,
    startedAt: run.startedAt || run.execution?.startedAt || null,
    finishedAt: ['completed', 'failed', 'cancelled', 'rejected'].includes(run.status) ? run.execution?.finishedAt || run.updatedAt : null,
    updatedAt: run.updatedAt
  });
}

function paperDownloadTask(job) {
  return normalizeTask({ id: `paper-download:${job.id}`, kind: 'paper-download', title: `下载 PDF · ${job.filename}`,
    status: job.status, progress: job.status === 'completed' ? 100 : job.totalBytes ? Math.min(99, Math.round(job.receivedBytes / job.totalBytes * 100)) : null,
    error: job.error, retryable: ['failed', 'cancelled'].includes(job.status),
    log: [job.sourceUrl, `${job.receivedBytes} bytes received`, ...(job.interrupted ? ['进程中断，可重新下载。'] : [])],
    metadata: { paperId: job.paperId, jobId: job.id, attachmentId: job.attachmentId, sourceUrl: job.sourceUrl, filename: job.filename, receivedBytes: job.receivedBytes, totalBytes: job.totalBytes },
    createdAt: job.createdAt, updatedAt: job.updatedAt, startedAt: job.startedAt, finishedAt: job.finishedAt });
}

function datasetTask(job) {
  const config=job.configuration;
  return normalizeTask({id:`dataset-acquisition:${job.id}`,kind:'dataset-acquisition',title:`取得数据 · ${config.filename}`,
    status:job.status==='interrupted'?'paused':job.status==='committing'?'running':job.status,
    progress:job.status==='completed'?100:job.totalBytes?Math.min(99,Math.round(job.receivedBytes/job.totalBytes*100)):null,
    error:job.error,retryable:config.authority!=='system'&&['failed','cancelled','interrupted'].includes(job.status),
    log:[config.source.url||'本地导入',`${job.receivedBytes} bytes received`,...(job.interrupted?['原任务中断，可核对后继续。']:[])],
    metadata:{jobId:job.id,datasetId:job.datasetId,filename:config.filename,configurationVersion:config.version,configurationSha256:job.configurationSha256,
      source:config.source,receivedBytes:job.receivedBytes,totalBytes:job.totalBytes,authorization:config.authorization||null},createdAt:job.createdAt,startedAt:job.startedAt,finishedAt:job.finishedAt,updatedAt:job.updatedAt});
}

function environmentTask(job) {
  return normalizeTask({id:`environment-preparation:${job.id}`,kind:'environment-preparation',title:'准备 Python 实验环境',
    status:job.status==='ready'?'completed':job.status==='preparing'?'running':job.status==='interrupted'?'paused':job.status,
    progress:job.status==='ready'?100:null,error:job.error,retryable:job.configuration.authority!=='system'&&['failed','cancelled','interrupted'].includes(job.status),
    log:[job.environment?`Python ${job.environment.python.version}`:'准备固定版本的 Python 环境',job.logs?.stderr||job.logs?.stdout||''],
    metadata:{jobId:job.id,configurationSha256:job.configurationSha256,environment:job.environment||null,authorization:job.configuration.authorization||null},
    createdAt:job.createdAt,updatedAt:job.updatedAt,startedAt:job.startedAt,finishedAt:job.finishedAt});
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
  try {
    const runs = await listExperimentRuns(projectId, { limit: 100 });
    for (const run of runs) taskMap.set(`experiment-run:${run.id}`, experimentRunTask(run));
  } catch {}
  const { paperAttachmentService } = await import('../paperAttachments/index.js');
  for (const job of await paperAttachmentService.listJobs(projectId)) taskMap.set(`paper-download:${job.id}`, paperDownloadTask(job));
  const { datasetService } = await import('../datasets/index.js');
  for (const job of await datasetService.listJobs(projectId)) taskMap.set(`dataset-acquisition:${job.id}`, datasetTask(job));
  const {environmentService}=await import('../experimentRunner/environments.js');
  for (const job of await environmentService.listJobs(projectId)) taskMap.set(`environment-preparation:${job.id}`,environmentTask(job));
  const linkedRuns = new Set([...taskMap.values()].map(task => task.metadata?.harnessRunId).filter(Boolean));
  let tasks = [...taskMap.values()].filter(task => task.kind !== 'harness' || !linkedRuns.has(task.metadata?.runId))
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  if (status) tasks = tasks.filter((task) => task.status === status);
  if (kind) tasks = tasks.filter((task) => task.kind === kind);
  return tasks.slice(0, Math.max(1, Math.min(MAX_TASKS, Number(limit) || 100))).map(clone);
}

export async function getTask(projectId, taskId) {
  const tasks = await listTasks(projectId, { limit: MAX_TASKS });
  const task = tasks.find((item) => item.id === taskId);
  if (!task && taskId.startsWith('harness:')) return harnessTask(await getHarnessRun(projectId, taskId.slice('harness:'.length)));
  if (!task) throw new Error('Task not found.');
  return task;
}

export async function retryTask(projectId, taskId) {
  const task = await getTask(projectId, taskId);
  if(task.kind==='environment-preparation'){const {environmentService}=await import('../experimentRunner/environments.js');return {task:environmentTask(await environmentService.retry(projectId,task.metadata.jobId))};}
  if(task.kind==='dataset-acquisition'){
    const {datasetService}=await import('../datasets/index.js');
    const result=await datasetService.resume(projectId,task.metadata.jobId,{expectedConfigurationVersion:task.metadata.configurationVersion});
    return {task:datasetTask(result.job)};
  }
  if (task.kind === 'harness' && task.metadata?.runId) {
    const run = await replayHarnessRun(projectId, task.metadata.runId, { start: true });
    return { task: harnessTask(run), run };
  }
  if (task.kind === 'experiment-run' && task.metadata?.runId) {
    const run = await retryExperimentRun(projectId, task.metadata.runId);
    return { task: experimentRunTask(run), run };
  }
  if (task.kind === 'paper-download') {
    const { paperAttachmentService } = await import('../paperAttachments/index.js');
    const result = await paperAttachmentService.startDownload(projectId, task.metadata.paperId, { url: task.metadata.sourceUrl, filename: task.metadata.filename, refresh: true });
    return { task: paperDownloadTask(result.job) };
  }
  if (task.kind === 'experiment') throw new Error('Experiment Plans require a controlled Experiment Run.');
  if (!task.retryable) throw new Error('Task is not retryable.');
  const updated = await updateTask(projectId, taskId, { status: 'queued', progress: 0, error: null, log: ['Retry requested by human.'], finishedAt: null });
  return { task: updated };
}

export async function cancelTask(projectId, taskId) {
  const task = await getTask(projectId, taskId);
  if(task.kind==='environment-preparation'){const {environmentService}=await import('../experimentRunner/environments.js');return {task:environmentTask(await environmentService.cancel(projectId,task.metadata.jobId))};}
  if(task.kind==='dataset-acquisition'){
    const {datasetService}=await import('../datasets/index.js');
    return {task:datasetTask(await datasetService.cancel(projectId,task.metadata.jobId))};
  }
  if (task.kind === 'harness' && task.metadata?.runId) {
    const run = await cancelHarnessRun(projectId, task.metadata.runId);
    return { task: harnessTask(run), run };
  }
  if (task.kind === 'experiment-run' && task.metadata?.runId) {
    const run = await cancelExperimentRun(projectId, task.metadata.runId);
    return { task: experimentRunTask(run), run };
  }
  if (task.kind === 'paper-download') {
    const { paperAttachmentService } = await import('../paperAttachments/index.js');
    return { task: paperDownloadTask(await paperAttachmentService.cancelDownload(projectId, task.metadata.paperId, task.metadata.jobId)) };
  }
  if (task.kind === 'compile') {
    if (task.status === 'cancelled') return { task };
    if (!['queued', 'running'].includes(task.status)) throw new Error('Task is no longer active.');
    await cancelActiveCompile(projectId, taskId);
    return { task: await getTask(projectId, taskId) };
  }
  if (!['queued', 'running', 'paused'].includes(task.status)) throw new Error('Task is no longer active.');
  return { task: await updateTask(projectId, taskId, { status: 'cancelled', progress: 100, finishedAt: now(), log: [...task.log, 'Cancelled by human.'] }) };
}

export async function getTaskSummary(projectId) {
  const tasks = await listTasks(projectId, { limit: MAX_TASKS });
  return {
    total: tasks.length,
    active: tasks.filter((task) => ['queued', 'running', 'paused', 'awaiting_approval'].includes(task.status)).length,
    failed: tasks.filter((task) => task.status === 'failed').length,
    completed: tasks.filter((task) => ['completed', 'approved'].includes(task.status)).length,
    recent: tasks.slice(0, 8)
  };
}

export { FILE as TASKS_FILE };
