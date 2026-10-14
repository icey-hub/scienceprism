import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { requireAutomatic } from '../researchAutomation/policy.js';
import { isSensitivePath, isPathAllowed } from '../harnessRuntime/capabilities.js';
import { intersectPaths } from '../harnessRuntime/currentToolPolicy.js';
import { upsertEvidence, linkEvidence } from '../evidenceLedger/index.js';
import { getHarnessRun } from '../harnessRuntime/index.js';
import { getResearchWorkflow } from '../researchWorkflow/index.js';
import { withWorkflowLock } from '../researchWorkflow/repository.js';
import { artifactDirectory, clone, readExperimentRuns, resolveExperimentProjectRoot, withExperimentRunLock, writeExperimentRuns } from './repository.js';
import { experimentAdapters } from './adapters.js';
import { environmentService } from './environments.js';
import { prepareExperimentDataset, assertExperimentDatasetInput } from './datasetInput.js';
import { codePreparationService } from './codePreparations.js';
import { assertExperimentCodeSnapshot, buildExperimentManifest, manifestSummary, experimentManifestHash } from './manifest.js';
import { ExperimentRunnerError } from './errors.js';
import { getFeatureFlags } from '../featureFlags.js';
import { isConstraintEnabled, readConstraintPolicy } from '../constraintRegistry/index.js';
import { assertReplicationPreparationUnchangedFromWorkflow, isReplicationRequest, readReplicationContextFromWorkflow, readExperimentContextFromWorkflow, assertExperimentPlanUnchangedFromWorkflow } from './replicationContext.js';
import { isDeepStrictEqual } from 'node:util';
import { safeJoin } from '../../utils/pathUtils.js';
import { assertTrialAuthorization, assertTrialExperiment, trialRunId } from './trialContext.js';

const MAX_RUNS = 500;
const MAX_LOG_TAIL = 20_000;
const activeRuns = new Map();
let shuttingDown = false;

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

const CONFIRMED_EVIDENCE_STATUSES = new Set(['verified', 'human-confirmed', 'approved']);

function isTrialRun(run) {
  const trial = run.purpose === 'engineering-trial' || run.manifest?.purpose === 'engineering-trial' || !!run.manifest?.trial;
  if (trial && (run.purpose !== 'engineering-trial' || run.manifest?.purpose !== 'engineering-trial' || !run.manifest.trial)) {
    throw new ExperimentRunnerError(409, 'EXPERIMENT_TRIAL_PROVENANCE_INVALID', 'Engineering trial classification and provenance cannot be removed or replaced.');
  }
  return trial;
}

export function replicationRunSummary(run, evidenceEntries = []) {
  if (!run?.manifest?.replication) return null;
  return experimentRunSummary(run, evidenceEntries);
}

export function experimentRunSummary(run, evidenceEntries = []) {
  if (!run?.manifest) return null;
  const artifacts = Array.isArray(run.artifacts) ? run.artifacts : [];
  const artifactEvidenceIds = Array.isArray(run.evidence?.artifactIds) ? run.evidence.artifactIds : [];
  const runEvidenceId = run.evidence?.runId || `experiment-run-${run.id}`;
  const evidenceById = new Map((Array.isArray(evidenceEntries) ? evidenceEntries : []).map((entry) => [entry.id, entry]));
  const runEvidence = evidenceById.get(runEvidenceId);
  const fallbackStatus = run.status === 'completed' && artifacts.length > 0 ? 'pending' : 'unverified';
  const evidenceStatus = runEvidence?.verificationStatus || fallbackStatus;
  const artifactRows = artifacts.map((artifact, index) => {
    const evidenceId = artifactEvidenceIds[index] || null;
    const artifactEvidence = evidenceId ? evidenceById.get(evidenceId) : null;
    return {
      id: artifact.id,
      evidenceId,
      evidenceStatus: artifactEvidence?.verificationStatus || evidenceStatus,
      name: artifact.name,
      kind: artifact.kind,
      path: artifact.path,
      sha256: artifact.sha256
    };
  });
  const evidenceConfirmed = CONFIRMED_EVIDENCE_STATUSES.has(evidenceStatus)
    && artifactRows.every((artifact) => CONFIRMED_EVIDENCE_STATUSES.has(artifact.evidenceStatus));
  const engineeringTrial = run.purpose === 'engineering-trial' || run.manifest.purpose === 'engineering-trial' || !!run.manifest.trial;
  const supportsSuccessfulFinding = !engineeringTrial && run.status === 'completed' && evidenceConfirmed;
  return {
    id: run.id,
    status: run.status,
    evidenceId: runEvidence?.id || runEvidenceId,
    evidenceStatus,
    evidenceConfirmed,
    supportsSuccessfulFinding,
    ...(engineeringTrial ? { purpose: 'engineering-trial' } : {}),
    verificationNote: engineeringTrial ? 'Engineering trial only; it cannot support a scientific finding even when its Evidence is confirmed.' : supportsSuccessfulFinding
      ? 'Run and all archived artifact Evidence are confirmed.'
      : run.status === 'completed'
        ? 'Run completed, but its Evidence is pending or unverified; human verification is required before treating findings as successful.'
        : `Run status is ${run.status}; it cannot support a successful finding.`,
    provenance: run.manifest.replication || run.manifest.researchPlan || run.manifest.trial || null,
    codeVersion: run.manifest.code?.version || '',
    codeSnapshotHash: run.manifest.code?.snapshotHash || '',
    dataset: run.manifest.dataset,
    environment: run.manifest.environment,
    protocol: run.manifest.protocol || '',
    seed: run.manifest.seed ?? null,
    successCriteria: Array.isArray(run.manifest.successCriteria) ? run.manifest.successCriteria : [],
    exitCode: run.execution?.exitCode ?? null,
    errorMessage: run.error?.message || run.execution?.error?.message || '',
    ...(run.manifest.replication ? { paperBinding: run.manifest.replication.paper ? 'bound' : 'unbound', ...(run.manifest.replication.paper ? { paper: run.manifest.replication.paper } : {}) } : {}),
    ...(run.manifest.evaluationProtocol ? { evaluationProtocol: run.manifest.evaluationProtocol } : {}),
    metrics: Array.isArray(run.metrics) ? run.metrics : [],
    artifacts: artifactRows
  };
}

export async function listExperimentRuns(projectId, { status, limit = 100 } = {}) {
  const document = await recoverInterruptedExperiments(projectId);
  const runs = document.runs
    .filter((run) => !status || run.status === status)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  return clone(runs.slice(0, Math.max(1, Math.min(MAX_RUNS, Number(limit) || 100))));
}

export async function getExperimentRun(projectId, runId) {
  const document = await recoverInterruptedExperiments(projectId);
  const run = document.runs.find((item) => item.id === runId);
  if (!run) throw new ExperimentRunnerError(404, 'EXPERIMENT_RUN_NOT_FOUND', 'Experiment Run not found.', { runId });
  return clone(run);
}

async function recoverInterruptedExperiments(projectId) {
  const { root, document } = await getRunDocument(projectId);
  if (!document.runs.some((run) => run.status === 'running' && !activeRuns.has(run.id))) return document;
  const recovered = [];
  await withExperimentRunLock(projectId, async () => {
    const latest = await readExperimentRuns(root, projectId);
    for (const run of latest.runs) {
      if (run.status !== 'running' || activeRuns.has(run.id)) continue;
      const processState = run.execution?.process;
      let stopped = processState?.stopConfirmed === true;
      if (processState?.pid) {
        stopped = false;
        try { process.kill(processState.pid, 0); } catch (error) { stopped = error.code === 'ESRCH'; }
      }
      if (!stopped) throw new ExperimentRunnerError(409, 'EXPERIMENT_STOP_UNCONFIRMED', 'The previous experiment process has not confirmed stopping; execution cannot be retried.');
      run.status = 'failed';
      run.error = { code: 'EXPERIMENT_INTERRUPTED', message: 'Experiment execution was interrupted by a server restart.', retryable: true };
      run.execution = { ...run.execution, finishedAt: now(), error: { code: run.error.code, message: run.error.message } };
      run.updatedAt = now();
      recovered.push(clone(run));
    }
    if (recovered.length) {
      latest.version += 1;
      latest.updatedAt = now();
      await writeExperimentRuns(root, latest);
    }
  });
  for (const run of recovered) {
    try {
      const evidence = await persistRunEvidence(projectId, run);
      await updateRun(projectId, run.id, (current) => ({ ...current, evidence }));
    } catch (error) {
      await updateRun(projectId, run.id, (current) => ({ ...current, evidenceError: { code: error.code || 'EVIDENCE_WRITE_FAILED', message: error.message } }));
    }
  }
  return readExperimentRuns(root, projectId);
}

function makeRun(projectId, manifest, actor, { retryOf = null, attempt = 0 } = {}) {
  const timestamp = now();
  return {
    id: manifest.id,
    projectId,
    planId: manifest.planId,
    status: 'awaiting_approval',
    phase: 'plan',
    manifest,
    ...(manifest.purpose === 'engineering-trial' ? { purpose: manifest.purpose } : {}),
    manifestSummary: manifestSummary(manifest),
    approval: null,
    attempt,
    retryOf,
    execution: null,
    logs: { stdout: '', stderr: '' },
    metrics: [],
    artifacts: [],
    evidence: { runId: null, artifactIds: [] },
    interpretation: null,
    createdBy: text(actor) || 'human',
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

async function persistNewRun(projectId, root, run) {
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

export async function createExperimentRun(projectId, input = {}, { actor = 'human' } = {}) {
  if ([input, input?.plan, input?.experiment].some(value => value && typeof value === 'object'
    && ['purpose', 'trial', 'authorization'].some(key => Object.hasOwn(value, key)))) {
    throw new ExperimentRunnerError(403, 'EXPERIMENT_TRIAL_INTERNAL_ONLY', 'Engineering trial provenance is owned by the original research automation.');
  }
  const isReplication = isReplicationRequest(input);
  const root = await resolveExperimentProjectRoot(projectId);
  const runId = `experiment-run-${randomUUID()}`;
  if (isReplication) {
    return withWorkflowLock(projectId, async () => {
      const workflow = await getResearchWorkflow(projectId);
      const replicationContext = readReplicationContextFromWorkflow(projectId, workflow, { expectedVersion: input.expectedVersion });
      const allowed = { sourceStage: input.sourceStage, plan: input.plan };
      const manifest = await buildExperimentManifest(projectId, runId, allowed, root, { replicationContext });
      return persistNewRun(projectId, root, makeRun(projectId, manifest, actor));
    });
  }
  try {
    return await withWorkflowLock(projectId, async () => {
      const workflow = await getResearchWorkflow(projectId);
      const experimentContext = readExperimentContextFromWorkflow(projectId, workflow, { expectedVersion: input.expectedVersion ?? (input.sourceStage === 'experiment' ? undefined : workflow.version) });
      const manifest = await buildExperimentManifest(projectId, runId, {}, root, { researchContext: experimentContext });
      const requestedPlan = input.plan || input.experiment;
      if (requestedPlan) {
        const requested = await buildExperimentManifest(projectId, runId, input, root);
        const fields = ['dataset', 'protocol', 'command', 'commandNote', 'parameters', 'seed', 'resources', 'successCriteria', 'artifacts'];
        if (fields.some((field) => !isDeepStrictEqual(requested[field], manifest[field]))
          || !isDeepStrictEqual(requested.code.paths, manifest.code.paths)
          || (requestedPlan.codeVersion && requested.code.version !== manifest.code.version)) {
          throw new ExperimentRunnerError(409, 'EXPERIMENT_PLAN_MISMATCH', 'The requested Run differs from the approved experiment plan. Reload the approved plan before creating a Run.');
        }
      } else if (input.sourceStage !== 'experiment') {
        throw new ExperimentRunnerError(400, 'EXPERIMENT_SOURCE_REQUIRED', 'Use sourceStage=experiment and the current workflow version, or provide the approved plan.');
      }
      return persistNewRun(projectId, root, makeRun(projectId, manifest, actor));
    });
  } catch (error) {
    if (error?.code !== 'WORKFLOW_NOT_FOUND') throw error;
    if (input.sourceStage === 'experiment' || input.expectedVersion !== undefined) {
      throw new ExperimentRunnerError(409, 'EXPERIMENT_WORKFLOW_REQUIRED', 'A research workflow is required for a version-bound experiment plan.');
    }
  }
  const manifest = await buildExperimentManifest(projectId, runId, input, root);
  return persistNewRun(projectId, root, makeRun(projectId, manifest, actor));
}

/** The original automation persists a grant before this sole draft Runner
 * entry. A stable identity closes the creation-to-step-save restart window. */
export async function createTrialExperimentRun(projectId, { authorization, plan } = {}) {
  return withWorkflowLock(projectId, async () => {
    const { draft } = await assertTrialAuthorization(projectId, authorization, plan);
    const root = await resolveExperimentProjectRoot(projectId), runId = trialRunId(authorization);
    const manifest = await buildExperimentManifest(projectId, runId, { plan: draft }, root);
    manifest.purpose = 'engineering-trial';
    manifest.trial = { authorization: clone(authorization), plan: clone(draft) };
    await assertTrialExperiment(projectId, manifest);
    return withExperimentRunLock(projectId, async () => {
      // Recheck the grant after all asynchronous preparation, before publish.
      await assertTrialExperiment(projectId, manifest);
      const document = await readExperimentRuns(root, projectId);
      const existing = document.runs.find(run => run.id === runId);
      if (existing) {
        isTrialRun(existing);
        await assertTrialExperiment(projectId, existing.manifest);
        if (!isDeepStrictEqual(existing.manifest.trial, manifest.trial)) throw new ExperimentRunnerError(409, 'EXPERIMENT_TRIAL_IDENTITY_CHANGED', 'The original trial identity has different provenance.');
        return clone(existing);
      }
      const run = makeRun(projectId, manifest, 'system');
      document.runs.unshift(run);
      document.runs = document.runs.slice(0, MAX_RUNS);
      document.version += 1;
      document.updatedAt = now();
      await writeExperimentRuns(root, document);
      return clone(run);
    });
  });
}

export async function decideExperimentRun(projectId, runId, { decision, actor = 'human', note = '' } = {}) {
  if (!text(actor)) throw new ExperimentRunnerError(400, 'ACTOR_REQUIRED', 'An Experiment Run decision must identify its human actor.');
  if (!['human', 'researcher'].includes(actor)) throw new ExperimentRunnerError(403, 'HUMAN_APPROVAL_REQUIRED', 'Only an explicit human decision may approve or reject an Experiment Run.');
  if (!['approve', 'reject'].includes(decision)) throw new ExperimentRunnerError(400, 'INVALID_EXPERIMENT_DECISION', 'Experiment Run decision must be approve or reject.');
  return updateRun(projectId, runId, (run) => {
    if (isTrialRun(run) && decision === 'approve') throw new ExperimentRunnerError(403, 'EXPERIMENT_TRIAL_INTERNAL_ONLY', 'The original automatic execution grant must approve engineering trials.');
    if (!['awaiting_approval', 'rejected'].includes(run.status)) throw new ExperimentRunnerError(409, 'EXPERIMENT_RUN_NOT_REVIEWABLE', `Experiment Run is ${run.status} and cannot receive an approval decision.`);
    run.status = decision === 'approve' ? 'approved' : 'rejected';
    run.phase = 'approval';
    run.approval = { decision, actor: text(actor) || 'human', note: text(note), at: now() };
    run.updatedAt = now();
    return run;
  });
}

export function automaticallyApproveExperiment(projectId, runId, sessionId) {
  return withWorkflowLock(projectId, async () => {
    const authorization = await requireAutomatic(projectId, 'execution', sessionId);
    return updateRun(projectId, runId, async run => {
      if (isTrialRun(run)) {
        const grant = await assertTrialExperiment(projectId, run.manifest);
        if (grant.sessionId !== sessionId) throw new ExperimentRunnerError(409, 'EXPERIMENT_TRIAL_EXECUTION_OWNER_CHANGED', 'The original research session must approve this trial.');
        Object.assign(authorization, grant.executionAuthorization);
      }
      if (run.status !== 'awaiting_approval') throw new ExperimentRunnerError(409, 'EXPERIMENT_RUN_NOT_REVIEWABLE', '实验已被处理。');
      run.status = 'approved';
      run.phase = 'approval';
      run.approval = { decision: 'approve', actor: 'system', authorization, at: now(), note: '按项目自动研究授权执行。' };
      run.manifest.permissions.approval = 'user-policy-authorized';
      run.manifest.permissions.execution = 'user-policy-and-project-capability';
      run.manifestSummary = manifestSummary(run.manifest);
      run.updatedAt = now();
      return run;
    });
  });
}

function assertExecutionAllowed(constraints, run, rolloutEnabled = true) {
  if (!getFeatureFlags({ constraints: rolloutEnabled ? constraints : {} }).experimentExecution) {
    throw new ExperimentRunnerError(403, 'FEATURE_FLAG_DISABLED', 'Controlled Experiment execution is disabled by the experimentExecution Feature Flag.');
  }
  if (!Array.isArray(constraints.capabilities) || !constraints.capabilities.includes('experiment.execute')) {
    throw new ExperimentRunnerError(403, 'EXPERIMENT_EXECUTION_DENIED', 'Project Constraints do not grant experiment.execute.');
  }
  if (constraints.allowExperimentExecution === false) throw new ExperimentRunnerError(403, 'EXPERIMENT_EXECUTION_DENIED', 'Project Constraints explicitly disable experiment execution.');
  const allowedPaths = constraints.allowedPaths ?? constraints.fileScope ?? [];
  if (!Array.isArray(allowedPaths) || allowedPaths.some(value => typeof value !== 'string')) throw new ExperimentRunnerError(400, 'EXPERIMENT_PATH_SCOPE_INVALID', 'The project experiment file scope is invalid.');
  const files = [...(run.manifest.code.files || []).map(file => file.path), run.manifest.command.entrypoint, run.manifest.dataset.input?.path, ...(run.manifest.artifacts || []).map(artifact => artifact.path)].filter(Boolean);
  if (files.some(file => !isPathAllowed(file, { allowedPaths }))) throw new ExperimentRunnerError(403, 'EXPERIMENT_PATH_DENIED', 'The fixed experiment inputs or outputs exceed the project file scope.');
  const maxConcurrent = Math.min(Math.max(Number(constraints.maxConcurrent) || 1, 1), 32);
  const activeCount = [...activeRuns].filter(([id, item]) => id !== run.id && item.projectId === run.projectId).length;
  if (activeCount >= maxConcurrent) throw new ExperimentRunnerError(409, 'EXPERIMENT_CONCURRENCY_LIMIT', 'The project experiment concurrency limit has been reached.', { maxConcurrent });
  const configuredTimeout = Number(constraints.experimentTimeoutMs || constraints.timeoutMs);
  if (Number.isFinite(configuredTimeout) && run.manifest.resources.timeoutMs > configuredTimeout) {
    throw new ExperimentRunnerError(403, 'EXPERIMENT_RESOURCE_LIMIT', 'The Experiment Run timeout exceeds the Project Constraint.', { timeoutMs: configuredTimeout });
  }
  return { maxConcurrent };
}

function copyFilter(source, projectRoot, allowedPaths = []) {
  const relative = path.relative(projectRoot, source).replace(/\\/g, '/');
  if (!relative) return true;
  const first = relative.split('/')[0];
  return !isSensitivePath(relative) && !['.git', '.scienceprism', '.openprism', 'node_modules', '.cache'].includes(first)
    && (isPathAllowed(relative, { allowedPaths }) || allowedPaths.some(path => path.startsWith(`${relative}/`)));
}

function assertPreparedCodeScope(manifest, allowedPaths) {
  if (manifest.command.codePreparationId && manifest.code.preparation.files.some(file => !isPathAllowed(file.path, { allowedPaths }))) throw new ExperimentRunnerError(403, 'EXPERIMENT_PATH_DENIED', 'Prepared code exceeds the parent execution file scope.');
}

async function copyProjectWorkspace(projectRoot, workspaceRoot, allowedPaths) {
  await fs.cp(projectRoot, workspaceRoot, { recursive: true, filter: (source) => copyFilter(source, projectRoot, allowedPaths) });
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

async function archiveExperimentInputs(root, workspaceRoot, run, artifacts) {
  const limit = run.manifest.resources.maxArtifactBytes;
  artifacts.push(await saveArtifact(root, run, path.join(workspaceRoot, '.scienceprism-experiment-input.json'), 'input.json', 'environment', 'input.json', limit));
  const outputs = new Set(run.manifest.artifacts.map((item) => item.path));
  const files = [];
  let bytes = 0;
  for (const file of run.manifest.code.files || []) {
    if (outputs.has(file.path)) { files.push({ ...file, status: 'declared-output' }); continue; }
    if (!file.sha256 || bytes + file.bytes > limit) {
      files.push({ ...file, status: 'not-archived', reason: file.skipped || 'snapshot-budget' });
      continue;
    }
    const source = safeJoin(workspaceRoot, file.path);
    await assertWorkspaceFile(workspaceRoot, source);
    const relative = path.posix.join('inputs', file.path);
    const artifact = await saveArtifact(root, run, source, relative, 'environment', relative, limit);
    if (artifact.sha256 !== file.sha256) throw new ExperimentRunnerError(409, 'EXPERIMENT_CODE_CHANGED', 'Experiment inputs changed before execution.');
    artifacts.push(artifact);
    files.push({ ...file, status: 'archived', artifactId: artifact.id });
    bytes += artifact.bytes;
  }
  let dataset = null;
  if (run.manifest.dataset.input) {
    const input = await assertExperimentDatasetInput(workspaceRoot, run.manifest.dataset);
    if (bytes + input.byteLength > limit) throw new ExperimentRunnerError(413, 'EXPERIMENT_DATASET_BUDGET', 'The fixed data and code exceed the input archive budget.');
    const relative = path.posix.join('inputs', input.path);
    const artifact = await saveArtifact(root, run, safeJoin(workspaceRoot, input.path), relative, 'environment', relative, limit);
    if (artifact.sha256 !== input.sha256) throw new ExperimentRunnerError(409, 'EXPERIMENT_DATASET_CHANGED', 'Dataset changed before input archival.');
    artifacts.push(artifact); bytes += artifact.bytes;
    dataset = { ...input, id: run.manifest.dataset.id, version: run.manifest.dataset.version, artifactId: artifact.id, status: 'archived' };
  }
  const snapshot = { runId: run.id, codeSnapshotHash: run.manifest.code.snapshotHash, complete: files.every((file) => file.status !== 'not-archived'), maxBytes: limit, bytes, files, ...(dataset ? { dataset } : {}) };
  artifacts.push(await saveTextArtifact(root, run, 'input-snapshot.json', `${JSON.stringify(snapshot, null, 2)}\n`, 'environment', 'input-snapshot.json', limit));
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

async function collectArtifacts(root, workspaceRoot, run, result, inputArtifacts = []) {
  const maxBytes = run.manifest.resources.maxArtifactBytes;
  const artifacts = [...inputArtifacts];
  artifacts.push(await saveTextArtifact(root, run, 'stdout.log', result.stdout || '', 'log', 'stdout.log', maxBytes));
  artifacts.push(await saveTextArtifact(root, run, 'stderr.log', result.stderr || '', 'log', 'stderr.log', maxBytes));
  artifacts.push(await saveTextArtifact(root, run, 'environment.json', `${JSON.stringify(run.manifest.environment, null, 2)}\n`, 'environment', 'environment.json', maxBytes));
  artifacts.push(await saveTextArtifact(root, run, 'manifest.json', `${JSON.stringify(run.manifest, null, 2)}\n`, 'environment', 'manifest.json', maxBytes));

  let archiveError = null;
  for (const declaration of run.manifest.artifacts) {
    const source = path.resolve(workspaceRoot, declaration.path);
    const relative = path.relative(workspaceRoot, source).replace(/\\/g, '/');
    if (!relative || relative.startsWith('../') || isSensitivePath(relative)) throw new ExperimentRunnerError(403, 'ARTIFACT_PATH_DENIED', `Artifact path is outside the experiment workspace: ${declaration.path}.`);
    try {
      await assertWorkspaceFile(workspaceRoot, source);
      artifacts.push(await saveArtifact(root, run, source, declaration.path, declaration.kind, declaration.name, maxBytes));
    } catch (error) {
      archiveError ||= error?.code === 'ENOENT'
        ? new ExperimentRunnerError(424, 'ARTIFACT_MISSING', `Declared artifact was not produced: ${declaration.path}.`)
        : error;
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
  return { artifacts, metrics: uniqueMetrics, error: archiveError };
}

async function persistRunEvidence(projectId, run) {
  const runEvidenceId = `experiment-run-${run.id}`;
  const runResult = await upsertEvidence(projectId, {
    id: runEvidenceId,
    kind: 'experiment-run',
    title: `${run.manifest.purpose === 'engineering-trial' ? 'Engineering trial' : 'Experiment Run'} ${run.id}`,
    summary: run.manifest.purpose === 'engineering-trial' ? `Engineering trial ended with status ${run.status}; this run cannot support a scientific finding.`
      : run.status === 'completed' ? `Completed controlled Experiment Run with ${run.metrics.length} recorded metrics.` : `Controlled Experiment Run ended with status ${run.status}.`,
    sourcePath: path.posix.join('.scienceprism/experiment-runs', run.id, 'manifest.json'),
    verificationStatus: run.status === 'completed' ? 'pending' : 'unverified',
    version: run.manifest.code.snapshotHash,
    metadata: {
      ...(run.manifest.purpose === 'engineering-trial' ? { purpose: 'engineering-trial', supportsSuccessfulFinding: false, trial: run.manifest.trial } : {}),
      runId: run.id,
      status: run.status,
      codeVersion: run.manifest.code.version,
      dataset: run.manifest.dataset,
      ...(run.manifest.replication ? { replication: run.manifest.replication } : {}),
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
      metadata: {
        ...(run.manifest.purpose === 'engineering-trial' ? { purpose: 'engineering-trial', supportsSuccessfulFinding: false } : {}),
        runId: run.id,
        artifactId: artifact.id,
        kind: artifact.kind,
        bytes: artifact.bytes,
        ...(run.manifest.replication ? { replication: run.manifest.replication } : {})
      }
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
  const inputArtifacts = [];
  let result;
  let executionError = null;
  const startedAt = now();
  try {
    if (run.manifest.purpose === 'engineering-trial') { await assertTrialExperiment(projectId, run.manifest, { executionBinding: control.executionBinding }); await control.beforeLaunch(); }
    await copyProjectWorkspace(root, workspaceRoot, control.allowedPaths);
    await assertExperimentCodeSnapshot(workspaceRoot, run.manifest, { original: true });
    if (run.manifest.command.codePreparationId) {
      assertPreparedCodeScope(run.manifest, control.allowedPaths);
      const code = run.manifest.code.preparation;
      await codePreparationService.prepareWorkspace(projectId, code.id, code.sha256, workspaceRoot, { signal: control.controller.signal, beforeEffect: control.beforeLaunch });
      await assertExperimentCodeSnapshot(workspaceRoot, run.manifest);
    }
    if (run.manifest.dataset.input && !isPathAllowed(run.manifest.dataset.input.path, { allowedPaths: control.allowedPaths })) throw new ExperimentRunnerError(403, 'EXPERIMENT_PATH_DENIED', 'The fixed dataset exceeds the parent execution file scope.');
    // Declared outputs must be produced by this Run, not inherited from the project.
    for (const artifact of run.manifest.artifacts) {
      if (artifact.path === run.manifest.command.entrypoint) throw new ExperimentRunnerError(400, 'ARTIFACT_INPUT_COLLISION', 'An execution entrypoint cannot also be a declared output.');
      const target = safeJoin(workspaceRoot, artifact.path);
      try { await fs.unlink(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    await writeExperimentInput(workspaceRoot, run);
    await prepareExperimentDataset(projectId, workspaceRoot, run.manifest.dataset, { signal: control.controller.signal, beforeEffect: control.beforeLaunch });
    await archiveExperimentInputs(root, workspaceRoot, run, inputArtifacts);
    const beforeLaunch = async () => {
      control.controller.signal.throwIfAborted();
      const latest = await getExperimentRun(projectId, runId);
      if (latest.status !== 'running' || experimentManifestHash(latest.manifest) !== experimentManifestHash(run.manifest)) throw new ExperimentRunnerError(409, 'EXPERIMENT_MANIFEST_CHANGED', 'The fixed execution manifest or state changed before launch.');
      const constraints = await readConstraints(root);
      const latestScope = constraints.allowedPaths ?? constraints.fileScope ?? [];
      if (!Array.isArray(latestScope) || latestScope.some(value => typeof value !== 'string')
        || !isDeepStrictEqual(intersectPaths(control.allowedPaths, latestScope), control.allowedPaths)) throw new ExperimentRunnerError(403, 'EXPERIMENT_PATH_SCOPE_CHANGED', 'The copied workspace scope changed before launch.');
      const policy = await readConstraintPolicy(projectId);
      assertExecutionAllowed(constraints, latest, isConstraintEnabled(policy, 'C-16'));
      assertPreparedCodeScope(latest.manifest, control.allowedPaths);
      if (latest.manifest.dataset.input && !isPathAllowed(latest.manifest.dataset.input.path, { allowedPaths: control.allowedPaths })) throw new ExperimentRunnerError(403, 'EXPERIMENT_PATH_DENIED', 'The fixed dataset exceeds the parent execution file scope.');
      if (latest.approval?.authorization) await requireAutomatic(projectId, 'execution', latest.approval.authorization.sessionId);
      if (latest.manifest.researchPlan || latest.manifest.replication) {
        const workflow = await getResearchWorkflow(projectId);
        if (latest.manifest.researchPlan) assertExperimentPlanUnchangedFromWorkflow(projectId, workflow, latest.manifest.researchPlan);
        if (latest.manifest.replication) assertReplicationPreparationUnchangedFromWorkflow(projectId, workflow, latest.manifest.replication);
      }
      if (latest.manifest.purpose === 'engineering-trial') await assertTrialExperiment(projectId, latest.manifest, { executionBinding: control.executionBinding });
      await control.beforeLaunch?.();
      if (run.manifest.command.environmentId) await environmentService.verify(projectId, run.manifest.command.environmentId, run.manifest.environment.preparation?.sha256);
      await assertExperimentDatasetInput(workspaceRoot, run.manifest.dataset);
      if (run.manifest.command.codePreparationId) await codePreparationService.assertWorkspace(projectId, run.manifest.code.preparation.id, run.manifest.code.preparation.sha256, workspaceRoot);
      control.controller.signal.throwIfAborted();
    };
    const onProcess = async state => {
      control.process = state;
      await updateRun(projectId, runId, current => { current.execution = { ...current.execution, process: state }; return current; });
    };
    const pythonEnvironment = run.manifest.command.environmentId ? await environmentService.verify(projectId, run.manifest.command.environmentId, run.manifest.environment.preparation?.sha256) : undefined;
    const task = adapter(run.manifest, { workspaceRoot, inputPath, signal: control.controller.signal, beforeLaunch, onProcess, pythonEnvironment });
    const timer = setTimeout(() => {
      control.timedOut = true;
      control.controller.abort(new Error('Experiment Run timed out.'));
    }, run.manifest.resources.timeoutMs);
    try {
      result = await task;
      await assertExperimentDatasetInput(workspaceRoot, run.manifest.dataset);
      if (run.manifest.command.codePreparationId) await codePreparationService.assertWorkspace(projectId, run.manifest.code.preparation.id, run.manifest.code.preparation.sha256, workspaceRoot);
      if (control.timedOut) executionError = new ExperimentRunnerError(504, 'EXPERIMENT_TIMEOUT', 'Experiment Run exceeded its configured timeout.');
    }
    finally { clearTimeout(timer); }
  } catch (error) {
    executionError = error instanceof ExperimentRunnerError ? error : new ExperimentRunnerError(500, error?.code === 'ABORT_ERR' ? 'EXPERIMENT_CANCELLED' : 'EXPERIMENT_FAILED', error?.message || String(error));
    result = { exitCode: null, signal: control.timedOut ? 'SIGTERM' : null, stdout: error.stdout || '', stderr: error.stderr || executionError.message };
  }

  let artifacts = inputArtifacts;
  let metrics = [];
  if (!executionError || result?.stdout || result?.stderr) {
    try {
      const collected = await collectArtifacts(root, workspaceRoot, run, result || {}, inputArtifacts);
      ({ artifacts, metrics } = collected);
      if (!executionError && collected.error) executionError = collected.error instanceof ExperimentRunnerError ? collected.error : new ExperimentRunnerError(500, 'ARTIFACT_ARCHIVE_FAILED', collected.error.message);
      if (!executionError && run.manifest.purpose === 'engineering-trial' && run.manifest.artifacts.some(item => item.kind === 'metric') && !metrics.length) {
        executionError = new ExperimentRunnerError(424, 'EXPERIMENT_TRIAL_METRICS_REQUIRED', 'The engineering trial produced no extractable declared metrics.');
      }
    }
    catch (error) {
      if (!executionError) executionError = error instanceof ExperimentRunnerError ? error : new ExperimentRunnerError(500, 'ARTIFACT_ARCHIVE_FAILED', error?.message || String(error));
    }
  }
  if (control.interrupted) executionError = new ExperimentRunnerError(503, 'EXPERIMENT_INTERRUPTED', 'Experiment execution was interrupted by server shutdown.');
  const cancelled = control.cancelRequested || control.controller.signal.aborted && !control.timedOut && !control.interrupted;
  const status = cancelled ? 'cancelled' : executionError || result?.exitCode !== 0 ? 'failed' : 'completed';
  const finishedAt = now();
  const updated = await updateRun(projectId, runId, (current) => {
    current.status = status;
    current.phase = status === 'completed' ? 'archive' : 'execution';
    current.execution = {
      startedAt,
      finishedAt,
      isolation: result?.isolation || null,
      process: control.process || { pid: null, stopConfirmed: true },
      exitCode: result?.exitCode ?? null,
      signal: result?.signal || null,
      error: executionError ? { code: executionError.code, message: executionError.message } : null
    };
    current.logs = { stdout: String(result?.stdout || '').slice(-MAX_LOG_TAIL), stderr: String(result?.stderr || '').slice(-MAX_LOG_TAIL) };
    current.metrics = metrics;
    current.artifacts = artifacts;
    current.error = cancelled
      ? { code: 'EXPERIMENT_CANCELLED', message: 'Experiment Run was cancelled.', retryable: false }
      : executionError
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

async function transitionRunToRunning(projectId, runId, root, control, constraints, rolloutEnabled, workflow = null) {
  return withExperimentRunLock(projectId, async () => {
    control.controller.signal.throwIfAborted();
    if (shuttingDown) throw new ExperimentRunnerError(503, 'EXPERIMENT_RUNNER_STOPPING', 'The server is shutting down. Retry after restart.');
    const document = await readExperimentRuns(root, projectId);
    const index = document.runs.findIndex((run) => run.id === runId);
    if (index < 0) throw new ExperimentRunnerError(404, 'EXPERIMENT_RUN_NOT_FOUND', 'Experiment Run not found.', { runId });
    if (activeRuns.has(runId)) throw new ExperimentRunnerError(409, 'EXPERIMENT_RUN_ACTIVE', 'The Experiment Run is already executing.');
    const next = clone(document.runs[index]);
    if (isTrialRun(next)) {
      if (!control.executionBinding || typeof control.beforeLaunch !== 'function') throw new ExperimentRunnerError(403, 'EXPERIMENT_TRIAL_INTERNAL_ONLY', 'The original coordinator must start its engineering trial.');
      await assertTrialExperiment(projectId, next.manifest, { workflow, executionBinding: control.executionBinding });
    }
    if (next.status !== 'approved') throw new ExperimentRunnerError(409, 'EXPERIMENT_APPROVAL_REQUIRED', 'An Experiment Run must be explicitly approved before execution.');
    if (control.executionBinding) {
      if (experimentManifestHash(next.manifest) !== control.executionBinding.manifestSha256) throw new ExperimentRunnerError(409, 'EXPERIMENT_MANIFEST_CHANGED', 'The approved manifest changed before execution.');
      if (next.executionBinding && !isDeepStrictEqual(next.executionBinding, control.executionBinding)) throw new ExperimentRunnerError(409, 'EXPERIMENT_OWNER_CHANGED', 'This Experiment Run belongs to another parent execution.');
      next.executionBinding = clone(control.executionBinding);
    } else if (next.executionBinding) throw new ExperimentRunnerError(409, 'EXPERIMENT_OWNER_CHANGED', 'This Experiment Run must be started by its bound parent.');
    if (next.approval?.authorization) await requireAutomatic(projectId, 'execution', next.approval.authorization.sessionId);
    assertExecutionAllowed(constraints, next, rolloutEnabled);
    assertPreparedCodeScope(next.manifest, control.allowedPaths);
    if (next.manifest.dataset.input && !isPathAllowed(next.manifest.dataset.input.path, { allowedPaths: control.allowedPaths })) throw new ExperimentRunnerError(403, 'EXPERIMENT_PATH_DENIED', 'The fixed dataset exceeds the parent execution file scope.');
    if (next.manifest?.replication) {
      if (!workflow) throw new ExperimentRunnerError(409, 'REPLICATION_WORKFLOW_REQUIRED', 'The replication workflow must be available before execution.');
      assertReplicationPreparationUnchangedFromWorkflow(projectId, workflow, next.manifest.replication);
    }
    if (next.manifest?.researchPlan) {
      if (!workflow) throw new ExperimentRunnerError(409, 'EXPERIMENT_WORKFLOW_REQUIRED', 'The research workflow must be available before execution.');
      assertExperimentPlanUnchangedFromWorkflow(projectId, workflow, next.manifest.researchPlan);
    }
    next.status = 'running';
    next.execution = { ...next.execution, process: { pid: null, stopConfirmed: false } };
    next.phase = 'execution';
    next.attempt = Number(next.attempt || 0) + 1;
    next.startedAt = now();
    next.updatedAt = now();
    document.runs[index] = next;
    document.version += 1;
    document.updatedAt = now();
    activeRuns.set(runId, { projectId, control, promise: control.settled });
    await writeExperimentRuns(root, document);
    return clone(next);
  });
}

export async function startExperimentRun(projectId, runId, { wait = false, signal, beforeLaunch, executionBinding, allowedPaths = [] } = {}) {
  signal?.throwIfAborted();
  if (!Array.isArray(allowedPaths) || allowedPaths.length > 200 || allowedPaths.some(value => typeof value !== 'string' || !value || value.includes('\\') || path.posix.isAbsolute(value) || value.split('/').some(part => !part || ['.', '..'].includes(part)) || isSensitivePath(value))) throw new ExperimentRunnerError(400, 'EXPERIMENT_PATH_SCOPE_INVALID', 'The trusted experiment file scope is invalid.');
  if (beforeLaunch !== undefined && typeof beforeLaunch !== 'function' || executionBinding && (typeof executionBinding !== 'object' || Array.isArray(executionBinding)
    || Object.keys(executionBinding).some(key => !['parentRunId', 'policyVersion', 'manifestSha256'].includes(key))
    || typeof executionBinding.parentRunId !== 'string' || !executionBinding.parentRunId || executionBinding.parentRunId.length > 200
    || typeof executionBinding.policyVersion !== 'string' || !executionBinding.policyVersion || executionBinding.policyVersion.length > 200
    || !/^[a-f0-9]{64}$/.test(executionBinding.manifestSha256))) throw new ExperimentRunnerError(400, 'EXPERIMENT_BINDING_INVALID', 'A trusted parent execution binding is required.');
  if (shuttingDown) throw new ExperimentRunnerError(503, 'EXPERIMENT_RUNNER_STOPPING', 'The server is shutting down. Retry after restart.');
  const { root } = await getRunDocument(projectId);
  if (activeRuns.has(runId)) throw new ExperimentRunnerError(409, 'EXPERIMENT_RUN_ACTIVE', 'The Experiment Run is already executing.');
  const current = await getExperimentRun(projectId, runId);
  if (current.status !== 'approved') throw new ExperimentRunnerError(409, 'EXPERIMENT_APPROVAL_REQUIRED', 'An Experiment Run must be explicitly approved before execution.');
  if (isTrialRun(current) && (!executionBinding || typeof beforeLaunch !== 'function'
    || !isDeepStrictEqual([...allowedPaths].sort(), current.manifest.trial.authorization.allowedPaths))) {
    throw new ExperimentRunnerError(403, 'EXPERIMENT_TRIAL_INTERNAL_ONLY', 'The original coordinator, effect guard and exact fixed trial file scope are required.');
  }
  const constraints = await readConstraints(root);
  const projectPaths = constraints.allowedPaths ?? constraints.fileScope ?? [];
  if (!Array.isArray(projectPaths) || projectPaths.some(value => typeof value !== 'string')) throw new ExperimentRunnerError(400, 'EXPERIMENT_PATH_SCOPE_INVALID', 'The project experiment file scope is invalid.');
  const fileScope = intersectPaths(allowedPaths, projectPaths);
  if (allowedPaths.length && projectPaths.length && !fileScope.length) throw new ExperimentRunnerError(403, 'EXPERIMENT_PATH_DENIED', 'The parent and project file scopes do not intersect.');
  const constraintPolicy = await readConstraintPolicy(projectId);
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(signal.reason || new Error('Parent execution stopped.'));
  signal?.addEventListener('abort', forwardAbort, { once: true });
  if (signal?.aborted) forwardAbort();
  const trialBeforeEffect = current.manifest.purpose === 'engineering-trial' ? async () => {
    controller.signal.throwIfAborted();
    await assertTrialExperiment(projectId, current.manifest, { executionBinding });
    await beforeLaunch?.();
    controller.signal.throwIfAborted();
  } : beforeLaunch;
  const control = { projectId, controller, cancelRequested: false, timedOut: false, beforeLaunch: trialBeforeEffect, executionBinding, allowedPaths: [...fileScope] };
  let settle;
  control.settled = new Promise(resolve => { settle = resolve; });
  const rolloutEnabled = isConstraintEnabled(constraintPolicy, 'C-16');
  let run;
  try {
    if (current.manifest?.replication || current.manifest?.researchPlan || current.manifest?.purpose === 'engineering-trial') {
      run = await withWorkflowLock(projectId, async () => {
        const workflow = await getResearchWorkflow(projectId);
        return transitionRunToRunning(projectId, runId, root, control, constraints, rolloutEnabled, workflow);
      });
    } else {
      run = await transitionRunToRunning(projectId, runId, root, control, constraints, rolloutEnabled);
    }
  } catch (error) {
    settle();
    signal?.removeEventListener('abort', forwardAbort);
    if (activeRuns.get(runId)?.control === control) activeRuns.delete(runId);
    throw error;
  }
  const promise = executeRun(projectId, runId, control).finally(() => { settle(); activeRuns.delete(runId); signal?.removeEventListener('abort', forwardAbort); });
  activeRuns.set(runId, { projectId, control, promise });
  if (wait) return promise;
  return run;
}

export async function shutdownExperimentRuns() {
  shuttingDown = true;
  while (activeRuns.size) {
    const entries = [...activeRuns.values()];
    for (const { control } of entries) {
      control.interrupted = true;
      control.controller.abort(new Error('Server shutdown.'));
    }
    await Promise.allSettled(entries.map((entry) => entry.promise || new Promise((resolve) => setTimeout(resolve, 10))));
  }
}

export async function cancelExperimentRun(projectId, runId) {
  const current = await getExperimentRun(projectId, runId);
  if (['completed', 'failed', 'cancelled', 'rejected'].includes(current.status)) return current;
  const active = activeRuns.get(runId);
  if (active) {
    active.control.cancelRequested = true;
    active.control.controller.abort(new Error('Experiment Run cancelled by human.'));
    // The executor owns the final status and archive. Await its cleanup before
    // reporting cancellation or allowing the caller's next execution attempt.
    if (active.promise) await active.promise;
    return getExperimentRun(projectId, runId);
  }
  return updateRun(projectId, runId, (run) => ({ ...run, status: 'cancelled', phase: 'execution', error: { code: 'EXPERIMENT_CANCELLED', message: 'Experiment Run was cancelled before execution.', retryable: false }, updatedAt: now() }));
}

export async function retryExperimentRun(projectId, runId, { actor = 'human' } = {}) {
  const current = await getExperimentRun(projectId, runId);
  if (isTrialRun(current)) throw new ExperimentRunnerError(403, 'EXPERIMENT_TRIAL_INTERNAL_ONLY', 'A failed engineering trial remains fixed; only the original bounded code repair may create its next version.');
  if (current.status !== 'failed') throw new ExperimentRunnerError(409, 'EXPERIMENT_RUN_NOT_RETRYABLE', 'Only failed Experiment Runs can be retried.');
  const root = await resolveExperimentProjectRoot(projectId);
  const id = `experiment-run-${randomUUID()}`;
  const executionPlan = {
    execution: current.manifest.command,
    parameters: current.manifest.parameters,
    seed: current.manifest.seed,
    resources: current.manifest.resources,
    artifacts: current.manifest.artifacts
  };

  if (current.manifest?.replication) {
    if (current.manifest.replication.projectId !== projectId || current.manifest.replication.sourceStage !== 'replication') {
      throw new ExperimentRunnerError(409, 'REPLICATION_PROVENANCE_INVALID', 'The failed Run has replication provenance for a different project or stage.');
    }
    return withWorkflowLock(projectId, async () => {
      const workflow = await getResearchWorkflow(projectId);
      const replicationContext = readReplicationContextFromWorkflow(projectId, workflow, { expectedVersion: workflow.version });
      const manifest = await buildExperimentManifest(projectId, id, { plan: executionPlan }, root, { replicationContext });
      return persistNewRun(projectId, root, makeRun(projectId, manifest, actor, { retryOf: current.id }));
    });
  }

  if (current.manifest?.researchPlan) {
    return withWorkflowLock(projectId, async () => {
      const workflow = await getResearchWorkflow(projectId);
      const researchContext = assertExperimentPlanUnchangedFromWorkflow(projectId, workflow, current.manifest.researchPlan);
      const manifest = await buildExperimentManifest(projectId, id, {}, root, { researchContext });
      return persistNewRun(projectId, root, makeRun(projectId, manifest, actor, { retryOf: current.id }));
    });
  }

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
  return persistNewRun(projectId, root, makeRun(projectId, manifest, actor, { retryOf: current.id }));
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
