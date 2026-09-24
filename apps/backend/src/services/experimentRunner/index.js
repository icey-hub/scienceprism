import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isSensitivePath } from '../harnessRuntime/capabilities.js';
import { upsertEvidence, linkEvidence } from '../evidenceLedger/index.js';
import { getHarnessRun } from '../harnessRuntime/index.js';
import { getResearchWorkflow } from '../researchWorkflow/index.js';
import { artifactDirectory, clone, readExperimentRuns, resolveExperimentProjectRoot, withExperimentRunLock, writeExperimentRuns } from './repository.js';
import { experimentAdapters } from './adapters.js';
import { assertExperimentCodeSnapshot, buildExperimentManifest, manifestSummary } from './manifest.js';
import { ExperimentRunnerError } from './errors.js';
import { getFeatureFlags } from '../featureFlags.js';

const MAX_RUNS = 500;
const MAX_LOG_TAIL = 20_000;
const activeRuns = new Map();

function now() { return new Date().toISOString(); }
function text(value) { return typeof value === 'string' ? value.trim() : ''; }

async function readConstraints(projectRoot) {
  try {
    const value = JSON.parse(await fs.readFile(path.join(projectRoot, '.scienceprism', 'project-constraints.json'), 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    if (error instanceof SyntaxError) throw new ExperimentRunnerError(400, 'INVALID_PROJECT_CONSTRAINTS', 'Project constraints are not valid JSON.');
    throw error;
  }
}

async function getRunDocument(projectId) {
  const root = await resolveExperimentProjectRoot(projectId);
  return { root, document: await readExperimentRuns(root, projectId) };
}

async function updateRun(projectId, runId, updater) {
  const { root } = await getRunDocument(projectId);
  return withExperimentRunLock(projectId, async () => {
    const document = await readExperimentRuns(root, projectId);
    const index = document.runs.findIndex((run) => run.id === runId);
    if (index < 0) throw new ExperimentRunnerError(404, 'EXPERIMENT_RUN_NOT_FOUND', 'Experiment Run not found.', { runId });
    const next = clone(document.runs[index]);
    const value = await updater(next);
    document.runs[index] = value || next;
    document.version += 1;
    document.updatedAt = now();
    await writeExperimentRuns(root, document);
    return clone(document.runs[index]);
  });
}

export async function listExperimentRuns(projectId, { status, limit = 100 } = {}) {
  const { document } = await getRunDocument(projectId);
  const runs = document.runs
    .filter((run) => !status || run.status === status)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  return clone(runs.slice(0, Math.max(1, Math.min(MAX_RUNS, Number(limit) || 100))));
}

export async function getExperimentRun(projectId, runId) {
  const { document } = await getRunDocument(projectId);
  const run = document.runs.find((item) => item.id === runId);
  if (!run) throw new ExperimentRunnerError(404, 'EXPERIMENT_RUN_NOT_FOUND', 'Experiment Run not found.', { runId });
  return clone(run);
}

export async function createExperimentRun(projectId, input = {}, { actor = 'human' } = {}) {
  const root = await resolveExperimentProjectRoot(projectId);
  try {
    const workflow = await getResearchWorkflow(projectId);
    const experimentStage = workflow.stages?.find((stage) => stage.id === 'experiment');
    if (experimentStage && experimentStage.status !== 'approved') {
      throw new ExperimentRunnerError(409, 'EXPERIMENT_PLAN_NOT_APPROVED', 'Approve the Experiment Plan before creating an Experiment Run.');
    }
  } catch (error) {
    if (error instanceof ExperimentRunnerError || error?.code !== 'WORKFLOW_NOT_FOUND') throw error;
  }
  const runId = `experiment-run-${randomUUID()}`;
  const manifest = await buildExperimentManifest(projectId, runId, input, root);
  const run = {
    id: runId,
    projectId,
    planId: manifest.planId,
    status: 'awaiting_approval',
    phase: 'plan',
    manifest,
    manifestSummary: manifestSummary(manifest),
    approval: null,
    attempt: 0,
    retryOf: null,
    execution: null,
    logs: { stdout: '', stderr: '' },
    metrics: [],
    artifacts: [],
    evidence: { runId: null, artifactIds: [] },
    interpretation: null,
    createdBy: text(actor) || 'human',
    createdAt: now(),
    updatedAt: now()
  };
  return withExperimentRunLock(projectId, async () => {
    const document = await readExperimentRuns(root, projectId);
    document.runs.unshift(run);
    document.runs = document.runs.slice(0, MAX_RUNS);
    document.version += 1;
    document.updatedAt = now();
    await writeExperimentRuns(root, document);
    return clone(run);
  });
}

export async function decideExperimentRun(projectId, runId, { decision = 'approve', actor = 'human', note = '' } = {}) {
  if (!['approve', 'reject'].includes(decision)) throw new ExperimentRunnerError(400, 'INVALID_EXPERIMENT_DECISION', 'Experiment Run decision must be approve or reject.');
  return updateRun(projectId, runId, (run) => {
    if (!['awaiting_approval', 'rejected'].includes(run.status)) throw new ExperimentRunnerError(409, 'EXPERIMENT_RUN_NOT_REVIEWABLE', `Experiment Run is ${run.status} and cannot receive an approval decision.`);
    run.status = decision === 'approve' ? 'approved' : 'rejected';
    run.phase = 'approval';
    run.approval = { decision, actor: text(actor) || 'human', note: text(note), at: now() };
    run.updatedAt = now();
    return run;
  });
}

function assertExecutionAllowed(constraints, run) {
  if (!getFeatureFlags({ constraints }).experimentExecution) {
    throw new ExperimentRunnerError(403, 'FEATURE_FLAG_DISABLED', 'Controlled Experiment execution is disabled by the experimentExecution Feature Flag.');
  }
  if (!Array.isArray(constraints.capabilities) || !constraints.capabilities.includes('experiment.execute')) {
    throw new ExperimentRunnerError(403, 'EXPERIMENT_EXECUTION_DENIED', 'Project Constraints do not grant experiment.execute.');
  }
  if (constraints.allowExperimentExecution === false) throw new ExperimentRunnerError(403, 'EXPERIMENT_EXECUTION_DENIED', 'Project Constraints explicitly disable experiment execution.');
  const maxConcurrent = Math.min(Math.max(Number(constraints.maxConcurrent) || 1, 1), 32);
  const activeCount = [...activeRuns.values()].filter((item) => item.projectId === run.projectId).length;
  if (activeCount >= maxConcurrent) throw new ExperimentRunnerError(409, 'EXPERIMENT_CONCURRENCY_LIMIT', 'The project experiment concurrency limit has been reached.', { maxConcurrent });
  const configuredTimeout = Number(constraints.experimentTimeoutMs || constraints.timeoutMs);
  if (Number.isFinite(configuredTimeout) && run.manifest.resources.timeoutMs > configuredTimeout) {
    throw new ExperimentRunnerError(403, 'EXPERIMENT_RESOURCE_LIMIT', 'The Experiment Run timeout exceeds the Project Constraint.', { timeoutMs: configuredTimeout });
  }
  return { maxConcurrent };
}

function copyFilter(source, projectRoot) {
  const relative = path.relative(projectRoot, source).replace(/\\/g, '/');
  if (!relative) return true;
  const first = relative.split('/')[0];
  return !isSensitivePath(relative) && !['.git', '.scienceprism', '.openprism', 'node_modules', '.cache'].includes(first);
}

async function copyProjectWorkspace(projectRoot, workspaceRoot) {
  await fs.cp(projectRoot, workspaceRoot, { recursive: true, filter: (source) => copyFilter(source, projectRoot) });
}

async function writeExperimentInput(workspaceRoot, run) {
  const inputPath = path.join(workspaceRoot, '.scienceprism-experiment-input.json');
  await fs.writeFile(inputPath, `${JSON.stringify({
    runId: run.id,
    dataset: run.manifest.dataset,
    parameters: run.manifest.parameters,
    seed: run.manifest.seed,
    successCriteria: run.manifest.successCriteria
  }, null, 2)}\n`, 'utf8');
  return inputPath;
}

async function hashFile(filePath) {
  const content = await fs.readFile(filePath);
  return { sha256: createHash('sha256').update(content).digest('hex'), bytes: content.byteLength };
}

async function saveArtifact(root, run, sourcePath, relativeOutput, kind, name, maxBytes) {
  const stat = await fs.stat(sourcePath);
  if (!stat.isFile()) throw new ExperimentRunnerError(400, 'INVALID_ARTIFACT', `Artifact is not a file: ${sourcePath}`);
  if (stat.size > maxBytes) throw new ExperimentRunnerError(413, 'ARTIFACT_LIMIT_EXCEEDED', `Artifact exceeds the configured size limit: ${name}.`);
  const target = path.join(artifactDirectory(root, run.id), relativeOutput);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(sourcePath, target);
  const digest = await hashFile(target);
  return { id: `artifact-${run.id}-${createHash('sha1').update(relativeOutput).digest('hex').slice(0, 16)}`, name, kind, path: path.posix.join('.scienceprism/experiment-runs', run.id, 'artifacts', relativeOutput), sourcePath: sourcePath.startsWith(root) ? path.relative(root, sourcePath).replace(/\\/g, '/') : null, ...digest, createdAt: now() };
}

async function assertWorkspaceFile(workspaceRoot, sourcePath) {
  const workspaceRealPath = await fs.realpath(workspaceRoot);
  const sourceRealPath = await fs.realpath(sourcePath);
  if (sourceRealPath !== workspaceRealPath && !sourceRealPath.startsWith(`${workspaceRealPath}${path.sep}`)) {
    throw new ExperimentRunnerError(403, 'ARTIFACT_PATH_DENIED', 'An Artifact must remain inside the isolated workspace.');
  }
}

async function saveTextArtifact(root, run, relativeOutput, content, kind, name, maxBytes) {
  const temporary = path.join(os.tmpdir(), `scienceprism-experiment-artifact-${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, content, 'utf8');
    return await saveArtifact(root, run, temporary, relativeOutput, kind, name, maxBytes);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

function normalizeMetrics(value) {
  const source = Array.isArray(value) ? value : Array.isArray(value?.metrics) ? value.metrics : value && typeof value === 'object' ? Object.entries(value).map(([name, metric]) => ({ name, value: metric })) : [];
  return source.map((metric) => {
    if (!metric || typeof metric !== 'object') return null;
    const name = text(metric.name || metric.metric);
    if (!name) return null;
    return { name, value: metric.value ?? null, unit: text(metric.unit) || null, uncertainty: metric.uncertainty ?? null };
  }).filter(Boolean);
}

async function collectArtifacts(root, workspaceRoot, run, result) {
  const maxBytes = run.manifest.resources.maxArtifactBytes;
  const artifacts = [];
  artifacts.push(await saveTextArtifact(root, run, 'stdout.log', result.stdout || '', 'log', 'stdout.log', maxBytes));
  artifacts.push(await saveTextArtifact(root, run, 'stderr.log', result.stderr || '', 'log', 'stderr.log', maxBytes));
  artifacts.push(await saveTextArtifact(root, run, 'environment.json', `${JSON.stringify(run.manifest.environment, null, 2)}\n`, 'environment', 'environment.json', maxBytes));
  artifacts.push(await saveTextArtifact(root, run, 'manifest.json', `${JSON.stringify(run.manifest, null, 2)}\n`, 'environment', 'manifest.json', maxBytes));

  for (const declaration of run.manifest.artifacts) {
    const source = path.resolve(workspaceRoot, declaration.path);
    const relative = path.relative(workspaceRoot, source).replace(/\\/g, '/');
    if (!relative || relative.startsWith('../') || isSensitivePath(relative)) throw new ExperimentRunnerError(403, 'ARTIFACT_PATH_DENIED', `Artifact path is outside the experiment workspace: ${declaration.path}.`);
    try {
      await assertWorkspaceFile(workspaceRoot, source);
      artifacts.push(await saveArtifact(root, run, source, declaration.path, declaration.kind, declaration.name, maxBytes));
    } catch (error) {
      if (error?.code === 'ENOENT') throw new ExperimentRunnerError(424, 'ARTIFACT_MISSING', `Declared artifact was not produced: ${declaration.path}.`);
      throw error;
    }
  }
  if (Array.isArray(result.metrics)) {
    const metricArtifact = await saveTextArtifact(root, run, 'metrics.json', `${JSON.stringify({ metrics: result.metrics }, null, 2)}\n`, 'metric', 'metrics.json', maxBytes);
    artifacts.push(metricArtifact);
  }
  let metrics = normalizeMetrics(result.metrics);
  for (const artifact of artifacts.filter((item) => item.kind === 'metric')) {
    try {
      metrics = [...metrics, ...normalizeMetrics(JSON.parse(await fs.readFile(path.join(root, artifact.path), 'utf8')))];
    } catch {}
  }
  const uniqueMetrics = [...new Map(metrics.map((metric) => [metric.name, metric])).values()];
  return { artifacts, metrics: uniqueMetrics };
}

async function persistRunEvidence(projectId, run) {
  const runEvidenceId = `experiment-run-${run.id}`;
  const runResult = await upsertEvidence(projectId, {
    id: runEvidenceId,
    kind: 'experiment-run',
    title: `Experiment Run ${run.id}`,
    summary: run.status === 'completed' ? `Completed controlled Experiment Run with ${run.metrics.length} recorded metrics.` : `Controlled Experiment Run ended with status ${run.status}.`,
    sourcePath: path.posix.join('.scienceprism/experiment-runs', run.id, 'manifest.json'),
    verificationStatus: run.status === 'completed' ? 'pending' : 'unverified',
    version: run.manifest.code.snapshotHash,
    metadata: {
      runId: run.id,
      status: run.status,
      codeVersion: run.manifest.code.version,
      dataset: run.manifest.dataset,
      metrics: run.metrics,
      attempt: run.attempt
    }
  }, { actor: 'experiment-runner' });
  const artifactIds = [];
  for (const artifact of run.artifacts) {
    const artifactEvidenceId = `experiment-artifact-${run.id}-${artifact.id.split('-').at(-1)}`;
    await upsertEvidence(projectId, {
      id: artifactEvidenceId,
      kind: artifact.kind === 'metric' ? 'table' : 'artifact',
      title: artifact.name,
      summary: `${artifact.kind} produced by Experiment Run ${run.id}.`,
      sourcePath: artifact.path,
      verificationStatus: run.status === 'completed' ? 'pending' : 'unverified',
      version: artifact.sha256,
      sha256: artifact.sha256,
      metadata: { runId: run.id, artifactId: artifact.id, kind: artifact.kind, bytes: artifact.bytes }
    }, { actor: 'experiment-runner' });
    await linkEvidence(projectId, { type: 'produces', fromId: runEvidenceId, toId: artifactEvidenceId }, { actor: 'experiment-runner' });
    artifactIds.push(artifactEvidenceId);
  }
  if (run.manifest.dataset.evidenceId) {
    try { await linkEvidence(projectId, { type: 'uses', fromId: runEvidenceId, toId: run.manifest.dataset.evidenceId }, { actor: 'experiment-runner' }); } catch {}
  }
  return { runId: runResult.entry.id, artifactIds };
}

async function executeRun(projectId, runId, control) {
  const { root } = await getRunDocument(projectId);
  const run = await getExperimentRun(projectId, runId);
  const adapter = experimentAdapters[run.manifest.command.adapter];
  if (!adapter) throw new ExperimentRunnerError(500, 'EXPERIMENT_ADAPTER_NOT_FOUND', `Experiment Runner Adapter not found: ${run.manifest.command.adapter}.`);
  const runRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'scienceprism-experiment-'));
  const workspaceRoot = path.join(runRoot, 'workspace');
  const inputPath = path.join(workspaceRoot, '.scienceprism-experiment-input.json');
  try {
  let result;
  let executionError = null;
  const startedAt = now();
  try {
    await copyProjectWorkspace(root, workspaceRoot);
    await assertExperimentCodeSnapshot(workspaceRoot, run.manifest);
    await writeExperimentInput(workspaceRoot, run);
    const task = adapter(run.manifest, { workspaceRoot, inputPath, signal: control.controller.signal });
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        control.timedOut = true;
        control.controller.abort(new Error('Experiment Run timed out.'));
        reject(new ExperimentRunnerError(504, 'EXPERIMENT_TIMEOUT', 'Experiment Run exceeded its configured timeout.'));
      }, run.manifest.resources.timeoutMs);
    });
    try { result = await Promise.race([task, timeout]); }
    finally { clearTimeout(timer); }
  } catch (error) {
    executionError = error instanceof ExperimentRunnerError ? error : new ExperimentRunnerError(500, error?.code === 'ABORT_ERR' ? 'EXPERIMENT_CANCELLED' : 'EXPERIMENT_FAILED', error?.message || String(error));
    result = { exitCode: null, signal: control.timedOut ? 'SIGTERM' : null, stdout: '', stderr: executionError.message };
  }

  let artifacts = [];
  let metrics = [];
  if (!executionError || result?.stdout || result?.stderr) {
    try { ({ artifacts, metrics } = await collectArtifacts(root, workspaceRoot, run, result || {})); }
    catch (error) {
      if (!executionError) executionError = error instanceof ExperimentRunnerError ? error : new ExperimentRunnerError(500, 'ARTIFACT_ARCHIVE_FAILED', error?.message || String(error));
    }
  }
  const cancelled = control.cancelRequested || control.controller.signal.aborted && !control.timedOut;
  const status = cancelled ? 'cancelled' : executionError || result?.exitCode !== 0 ? 'failed' : 'completed';
  const finishedAt = now();
  const updated = await updateRun(projectId, runId, (current) => {
    current.status = status;
    current.phase = status === 'completed' ? 'archive' : 'execution';
    current.execution = {
      startedAt,
      finishedAt,
      isolation: result?.isolation || null,
      exitCode: result?.exitCode ?? null,
      signal: result?.signal || null,
      error: executionError ? { code: executionError.code, message: executionError.message } : null
    };
    current.logs = { stdout: String(result?.stdout || '').slice(-MAX_LOG_TAIL), stderr: String(result?.stderr || '').slice(-MAX_LOG_TAIL) };
    current.metrics = metrics;
    current.artifacts = artifacts;
    current.error = executionError
      ? { code: executionError.code, message: executionError.message, retryable: status === 'failed' && executionError.code !== 'EXPERIMENT_SANDBOX_UNAVAILABLE' }
      : status === 'failed'
        ? { code: 'EXPERIMENT_EXIT_NONZERO', message: `Experiment process exited with code ${result?.exitCode ?? 'unknown'}.`, retryable: true }
        : null;
    current.updatedAt = finishedAt;
    return current;
  });
  if (artifacts.length) {
    try {
      const evidence = await persistRunEvidence(projectId, updated);
      return updateRun(projectId, runId, (current) => {
        current.evidence = evidence;
        current.phase = current.status === 'completed' ? 'interpret' : current.phase;
        current.evidenceError = null;
        return current;
      });
    } catch (error) {
      return updateRun(projectId, runId, (current) => ({ ...current, evidenceError: { code: error.code || 'EVIDENCE_WRITE_FAILED', message: error.message || String(error) } }));
    }
  }
  return updated;
  } finally {
    await fs.rm(runRoot, { recursive: true, force: true }).catch(() => {});
  }
}

export async function startExperimentRun(projectId, runId, { wait = false } = {}) {
  const { root } = await getRunDocument(projectId);
  const current = await getExperimentRun(projectId, runId);
  if (current.status !== 'approved') throw new ExperimentRunnerError(409, 'EXPERIMENT_APPROVAL_REQUIRED', 'An Experiment Run must be explicitly approved before execution.');
  const constraints = await readConstraints(root);
  const controller = new AbortController();
  const control = { projectId, controller, cancelRequested: false, timedOut: false };
  assertExecutionAllowed(constraints, current);
  activeRuns.set(runId, { projectId, control, promise: null });
  let run;
  try {
    run = await updateRun(projectId, runId, (next) => {
      if (next.status !== 'approved') throw new ExperimentRunnerError(409, 'EXPERIMENT_APPROVAL_REQUIRED', 'An Experiment Run must be explicitly approved before execution.');
      next.status = 'running';
      next.phase = 'execution';
      next.attempt = Number(next.attempt || 0) + 1;
      next.startedAt = now();
      next.updatedAt = now();
      return next;
    });
  } catch (error) {
    activeRuns.delete(runId);
    throw error;
  }
  const promise = executeRun(projectId, runId, control).finally(() => activeRuns.delete(runId));
  activeRuns.set(runId, { projectId, control, promise });
  if (wait) return promise;
  return run;
}

export async function cancelExperimentRun(projectId, runId) {
  const current = await getExperimentRun(projectId, runId);
  if (['completed', 'failed', 'cancelled', 'rejected'].includes(current.status)) return current;
  const active = activeRuns.get(runId);
  if (active) {
    active.control.cancelRequested = true;
    active.control.controller.abort(new Error('Experiment Run cancelled by human.'));
    return updateRun(projectId, runId, (run) => ({ ...run, status: 'cancelled', error: { code: 'EXPERIMENT_CANCELLED', message: 'Experiment Run was cancelled by human.', retryable: false }, updatedAt: now() }));
  }
  return updateRun(projectId, runId, (run) => ({ ...run, status: 'cancelled', phase: 'execution', error: { code: 'EXPERIMENT_CANCELLED', message: 'Experiment Run was cancelled before execution.', retryable: false }, updatedAt: now() }));
}

export async function retryExperimentRun(projectId, runId, { actor = 'human' } = {}) {
  const current = await getExperimentRun(projectId, runId);
  if (current.status !== 'failed') throw new ExperimentRunnerError(409, 'EXPERIMENT_RUN_NOT_RETRYABLE', 'Only failed Experiment Runs can be retried.');
  const root = await resolveExperimentProjectRoot(projectId);
  const id = `experiment-run-${randomUUID()}`;
  const manifest = await buildExperimentManifest(projectId, id, {
    plan: {
      planId: current.manifest.planId,
      dataset: current.manifest.dataset,
      protocol: current.manifest.protocol,
      execution: current.manifest.command,
      command: current.manifest.commandNote,
      parameters: current.manifest.parameters,
      seed: current.manifest.seed,
      resources: current.manifest.resources,
      successCriteria: current.manifest.successCriteria,
      artifacts: current.manifest.artifacts,
      codePaths: current.manifest.code?.paths || []
    }
  }, root);
  const run = {
    ...current,
    id,
    status: 'awaiting_approval',
    phase: 'plan',
    manifest,
    manifestSummary: manifestSummary(manifest),
    approval: null,
    attempt: 0,
    retryOf: current.id,
    execution: null,
    logs: { stdout: '', stderr: '' },
    metrics: [],
    artifacts: [],
    evidence: { runId: null, artifactIds: [] },
    interpretation: null,
    createdBy: text(actor) || 'human',
    createdAt: now(),
    updatedAt: now()
  };
  return withExperimentRunLock(projectId, async () => {
    const document = await readExperimentRuns(root, projectId);
    document.runs.unshift(run);
    document.runs = document.runs.slice(0, MAX_RUNS);
    document.version += 1;
    document.updatedAt = now();
    await writeExperimentRuns(root, document);
    return clone(run);
  });
}

export async function recordExperimentInterpretation(projectId, runId, input = {}, { actor = 'human' } = {}) {
  const sourceRun = await getExperimentRun(projectId, runId);
  if (sourceRun.status !== 'completed') throw new ExperimentRunnerError(409, 'EXPERIMENT_RESULT_UNAVAILABLE', 'Only a completed Experiment Run can be interpreted.');
  const summary = text(input.summary);
  if (!summary) throw new ExperimentRunnerError(400, 'INTERPRETATION_REQUIRED', 'An interpretation summary is required.');
  const sourceArtifactIds = Array.isArray(input.sourceArtifactIds) ? [...new Set(input.sourceArtifactIds.map(String))] : [];
  if (!sourceArtifactIds.length) throw new ExperimentRunnerError(400, 'INTERPRETATION_SOURCE_REQUIRED', 'An interpretation must reference at least one produced Artifact.');
  const known = new Set(sourceRun.artifacts.map((item) => item.id));
  if (sourceArtifactIds.some((id) => !known.has(id))) throw new ExperimentRunnerError(400, 'INTERPRETATION_SOURCE_REQUIRED', 'Interpretations may reference only artifacts produced by this Experiment Run.');
  const metricFindings = Array.isArray(input.metricFindings) ? input.metricFindings.map((item) => ({ metric: text(item?.metric), observation: text(item?.observation) })).filter((item) => item.metric && item.observation) : [];
  const origin = text(input.origin) || 'human';
  if (!['human', 'harness'].includes(origin)) throw new ExperimentRunnerError(400, 'INVALID_INTERPRETATION_ORIGIN', 'Interpretation origin must be human or harness.');
  if (origin === 'harness') {
    const harnessRunId = text(input.harnessRunId);
    if (!harnessRunId) throw new ExperimentRunnerError(400, 'INTERPRETATION_SOURCE_REQUIRED', 'A Harness interpretation must identify its Harness Run.');
    const harnessRun = await getHarnessRun(projectId, harnessRunId);
    if (!['completed', 'succeeded'].includes(harnessRun.status)) throw new ExperimentRunnerError(409, 'HARNESS_INTERPRETATION_NOT_READY', 'The Harness Run must be completed before it can interpret an Experiment Run.');
  }
  return updateRun(projectId, runId, (run) => {
    run.interpretation = { summary, metricFindings, limitations: Array.isArray(input.limitations) ? input.limitations.map(String).filter(Boolean) : [], sourceArtifactIds, origin, ...(origin === 'harness' ? { harnessRunId: text(input.harnessRunId) } : {}), actor: text(actor) || 'human', at: now() };
    run.phase = 'interpreted';
    run.updatedAt = now();
    return run;
  });
}

export async function compareExperimentRuns(projectId, runIds = []) {
  const ids = [...new Set((Array.isArray(runIds) ? runIds : String(runIds || '').split(',')).map(String).map((id) => id.trim()).filter(Boolean))];
  if (ids.length < 2) throw new ExperimentRunnerError(400, 'COMPARISON_REQUIRES_RUNS', 'Provide at least two Experiment Run IDs to compare.');
  const runs = await Promise.all(ids.map((id) => getExperimentRun(projectId, id)));
  if (runs.some((run) => run.status !== 'completed')) throw new ExperimentRunnerError(409, 'COMPARISON_REQUIRES_COMPLETED_RUNS', 'Only completed Experiment Runs can be compared.');
  const metricNames = [...new Set(runs.flatMap((run) => run.metrics.map((metric) => metric.name)))];
  const metrics = metricNames.map((name) => {
    const values = runs.map((run) => {
      const metric = run.metrics.find((item) => item.name === name);
      return { runId: run.id, value: metric?.value ?? null, uncertainty: metric?.uncertainty ?? null, unit: metric?.unit ?? null };
    });
    const numeric = values.map((item) => Number(item.value)).every((value) => Number.isFinite(value));
    return { name, values, deltaFromFirst: numeric ? values.slice(1).map((item) => ({ runId: item.runId, delta: Number(item.value) - Number(values[0].value) })) : [] };
  });
  return { runIds: runs.map((run) => run.id), runs: runs.map((run) => ({ id: run.id, codeVersion: run.manifest.code.version, dataset: run.manifest.dataset, seed: run.manifest.seed, createdAt: run.createdAt })), metrics, generatedAt: now() };
}

export function activeExperimentRunCount(projectId) {
  return [...activeRuns.values()].filter((item) => item.projectId === projectId).length;
}
