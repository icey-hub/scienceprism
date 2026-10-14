import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { isPathAllowed, isSensitivePath } from '../harnessRuntime/capabilities.js';
import { readAutomation, requireAutomatic, validateAutomationExecution } from '../researchAutomation/policy.js';
import { assertCodeAuthorization } from '../researchAutomation/codeAuthorization.js';
import { assertAutomationHandoff, sourceHash } from '../researchAutomation/handoff.js';
import { getResearchWorkflow } from '../researchWorkflow/index.js';
import { getHarnessRun } from '../harnessRuntime/index.js';
import { codePreparationService } from './codePreparations.js';
import { environmentService } from './environments.js';
import { resolveExperimentDataset } from './datasetInput.js';
import { ExperimentRunnerError } from './errors.js';
import { buildExperimentManifest, experimentManifestHash } from './manifest.js';
import { readExperimentRuns, resolveExperimentProjectRoot } from './repository.js';
import { initializeAutomationExecutionPlan } from '../researchAutomation/executionPlan.js';
import { safeJoin } from '../../utils/pathUtils.js';

const fail = (code, message) => { throw new ExperimentRunnerError(409, code, message); };
const scientificPlan = plan => {
  const value = structuredClone(plan);
  delete value.codePaths;
  delete value.execution.codePreparationId;
  delete value.execution.environmentId;
  return value;
};

async function currentSource(projectId, { sessionId, stage, plan }, workflow, { completedBinding = false } = {}) {
  const draft = validateAutomationExecution(plan);
  if (!draft || !['replication', 'experiment'].includes(stage) || !draft.execution.codePreparationId) {
    fail('EXPERIMENT_TRIAL_INPUT_REQUIRED', 'An engineering trial requires a fixed code version and a complete draft plan.');
  }
  const state = await readAutomation(projectId), session = state.session;
  const step = session?.steps?.find(item => item.stage === stage);
  workflow ||= await getResearchWorkflow(projectId);
  const sourceStage = workflow.stages?.find(item => item.id === stage);
  if (session?.id !== sessionId || session.status !== 'running' || session.stopRequested || session.currentStage !== stage
    || session.workflowId !== workflow.id || workflow.projectId !== projectId || !step?.handoff || !sourceStage
    || !['pending', 'in_progress', 'awaiting_approval', ...(completedBinding ? ['approved'] : [])].includes(sourceStage.status)
    || !completedBinding && (step.executionPlanBinding || step.experimentRunId || session.executionPlan)) {
    fail('EXPERIMENT_TRIAL_OWNER_CHANGED', 'The original unconsumed research draft and its running coordinator are required.');
  }
  assertAutomationHandoff(step.handoff, { projectId, workflow, session, stage, role: step.handoff.role });
  const coordinator = await getHarnessRun(projectId, session.coordinatorRunId);
  if (coordinator.kind !== 'research-coordinator' || coordinator.projectId !== projectId
    || coordinator.coordinatorSessionId !== sessionId || coordinator.parentRunId || coordinator.archived
    || coordinator.status !== 'created' || coordinator.cleanup?.modelSlotRetained) {
    fail('EXPERIMENT_TRIAL_COORDINATOR_CHANGED', 'The original research coordinator is no longer available.');
  }
  const entries = (step.codePreparations || []).filter(item => item.preparationId === draft.execution.codePreparationId);
  if (entries.length !== 1) fail('EXPERIMENT_TRIAL_CODE_SOURCE_REQUIRED', 'The fixed code must belong to this original stage preparation.');
  const entry = entries[0], codeAuthorization = entry.authorization;
  const codeScope = assertCodeAuthorization(codeAuthorization, { projectId, session, stage, inputSha256: sourceHash(entry.input),
    policyVersion: state.version, policy: state.policy });
  if (step.codePreparations.length > codeScope.maxVersions || (step.codeTrials?.length || 0) > codeScope.maxVersions) {
    fail('EXPERIMENT_TRIAL_VERSION_LIMIT', 'The original stage code and trial version budget is exhausted.');
  }
  if (entry.status !== 'completed' || entry.sha256 !== draft.execution.codePreparationId.slice(17)
    || !step.calls?.some(call => call.runId === entry.producerRunId && ['research:code-preparation', 'research:code-repair'].includes(call.task))) {
    fail('EXPERIMENT_TRIAL_CODE_SOURCE_REQUIRED', 'The original completed code producer and fixed version are required.');
  }
  const base = validateAutomationExecution(entry.input.executionPlan);
  if (!base || !isDeepStrictEqual(scientificPlan(base), scientificPlan(draft))
    || base.execution.environmentId && base.execution.environmentId !== draft.execution.environmentId) {
    fail('EXPERIMENT_TRIAL_PROTOCOL_CHANGED', 'An engineering trial cannot change the fixed scientific protocol, seed, metrics, outputs or resource limits.');
  }
  const prepared = await codePreparationService.verify(projectId, entry.preparationId, entry.sha256);
  const producer = await getHarnessRun(projectId, entry.producerRunId);
  if (producer.parentRunId !== session.coordinatorRunId || producer.kind !== 'research-stage' || producer.stage !== stage
    || producer.automationSessionId !== sessionId || producer.role !== 'experiment-code-producer'
    || !isDeepStrictEqual(producer.request?.context?.codeAuthorization, codeAuthorization)
    || !isDeepStrictEqual(producer.request?.context?.automationHandoff, step.handoff)
    || sourceHash(producer.request?.input) !== sourceHash(entry.input)
    || prepared.preparation.source.runId !== producer.id) {
    fail('EXPERIMENT_TRIAL_CODE_SOURCE_CHANGED', 'The original code producer provenance changed.');
  }
  const expectedPaths = [...new Set([...(base.codePaths || entry.input.availableFiles?.map(file => file.path) || []), ...prepared.files.map(file => file.path)])];
  if (!Array.isArray(draft.codePaths) || draft.codePaths.length !== expectedPaths.length
    || !isDeepStrictEqual([...draft.codePaths].sort(), expectedPaths.sort())) {
    fail('EXPERIMENT_TRIAL_CODE_PATHS_CHANGED', 'Only the original input files and verified code overlay may be trial inputs.');
  }
  const dataset = await resolveExperimentDataset(projectId, { id: draft.dataset, version: draft.datasetVersion, evidenceId: null });
  if (!dataset.input) fail('EXPERIMENT_TRIAL_FIXED_DATA_REQUIRED', 'Engineering trials require an actual fixed SHA256 dataset input.');
  const environment = draft.execution.environmentId
    ? (await environmentService.verify(projectId, draft.execution.environmentId)).environment : null;
  if (draft.execution.adapter === 'python' && !environment) fail('EXPERIMENT_TRIAL_ENVIRONMENT_REQUIRED', 'A Python trial requires a fixed prepared environment.');
  const executionAuthorization = await requireAutomatic(projectId, 'execution', sessionId);
  const root = await resolveExperimentProjectRoot(projectId);
  const material = await buildExperimentManifest(projectId, 'engineering-trial-material', { plan: draft }, root);
  const allowedPaths = [...new Set([...material.code.files.map(file => file.path), material.command.entrypoint,
    dataset.input.path, ...material.artifacts.map(item => item.path)])].sort();
  const constraints = JSON.parse(await fs.readFile(path.join(root, '.scienceprism/project-constraints.json'), 'utf8'));
  const projectPaths = constraints.allowedPaths ?? constraints.fileScope ?? [];
  if (!Array.isArray(projectPaths) || projectPaths.some(value => typeof value !== 'string')
    || allowedPaths.some(relative => isSensitivePath(relative) || !isPathAllowed(relative, { allowedPaths: projectPaths }))
    || !constraints.capabilities?.includes('experiment.execute') || constraints.allowExperimentExecution === false
    || Number(constraints.experimentTimeoutMs || constraints.timeoutMs) > 0
      && material.resources.timeoutMs > Number(constraints.experimentTimeoutMs || constraints.timeoutMs)) {
    fail('EXPERIMENT_TRIAL_SCOPE_DENIED', 'The fixed engineering inputs, outputs or resources exceed the current experiment authorization.');
  }
  const materialFields = ['command', 'code', 'dataset', 'environment', 'protocol', 'parameters', 'seed', 'resources', 'successCriteria', 'artifacts'];
  return { state, session, step, draft, codeAuthorization, executionAuthorization, snapshot: {
    schemaVersion: 1, purpose: 'engineering-trial', projectId, sessionId, parentRunId: session.coordinatorRunId,
    workflowId: workflow.id, stage, handoff: structuredClone(step.handoff), stageDataSha256: sourceHash(sourceStage.data),
    draftPlanSha256: sourceHash(draft), codeAuthorization: structuredClone(codeAuthorization),
    code: structuredClone(prepared.preparation), dataset, environment: environment ? { id: environment.id, sha256: environment.sha256 } : null,
    allowedPaths, materialSha256: sourceHash(Object.fromEntries(materialFields.map(field => [field, material[field]])))
  } };
}

/** Internal-only grant captured before the automation service persists codeTrials.
 * It grants no formal scientific result, workflow approval or plan consumption. */
export async function createTrialAuthorization(projectId, input) {
  const { snapshot, executionAuthorization, step } = await currentSource(projectId, input);
  const existing = (step.codeTrials || []).filter(item => item.plan?.execution?.codePreparationId === input.plan.execution.codePreparationId);
  if (existing.length) {
    if (existing.length !== 1) fail('EXPERIMENT_TRIAL_REGISTRATION_REQUIRED', 'A code version may have only one original engineering trial.');
    await assertTrialAuthorization(projectId, existing[0].authorization, input.plan);
    return structuredClone(existing[0].authorization);
  }
  return { ...snapshot, executionAuthorization, policyVersion: executionAuthorization.policyVersion };
}

export function trialRunId(authorization) { return `experiment-trial-${sourceHash(authorization)}`; }

export async function assertTrialAuthorization(projectId, authorization, plan, { workflow, registered = true } = {}) {
  if (!authorization || authorization.purpose !== 'engineering-trial') fail('EXPERIMENT_TRIAL_AUTHORIZATION_REQUIRED', 'The original engineering trial grant is required.');
  const current = await currentSource(projectId, { sessionId: authorization.sessionId, stage: authorization.stage, plan }, workflow);
  const { executionAuthorization, policyVersion, ...snapshot } = authorization;
  if (!isDeepStrictEqual(snapshot, current.snapshot) || executionAuthorization?.actor !== 'system'
    || executionAuthorization.part !== 'execution' || executionAuthorization.sessionId !== authorization.sessionId
    || !Number.isSafeInteger(executionAuthorization.policyVersion) || executionAuthorization.policyVersion < 1
    || executionAuthorization.policyVersion > current.executionAuthorization.policyVersion || policyVersion !== executionAuthorization.policyVersion) {
    fail('EXPERIMENT_TRIAL_AUTHORIZATION_CHANGED', 'The original execution grant, complete handoff, draft materials or fixed inputs changed.');
  }
  if (registered) {
    const matching = (current.step.codeTrials || []).filter(item => isDeepStrictEqual(item.authorization, authorization));
    if (matching.length !== 1 || !isDeepStrictEqual(matching[0].plan, current.draft)
      || current.step.codeTrials.filter(item => item.plan?.execution?.codePreparationId === current.draft.execution.codePreparationId).length !== 1
      || matching[0].runId && matching[0].runId !== trialRunId(authorization)) {
      fail('EXPERIMENT_TRIAL_REGISTRATION_REQUIRED', 'Persist the original trial grant and draft before creating or executing its Runner.');
    }
  }
  return current;
}

export async function assertTrialExperiment(projectId, manifest, { workflow, executionBinding } = {}) {
  if (manifest?.purpose !== 'engineering-trial' || !manifest.trial?.authorization || !manifest.trial.plan
    || manifest.id !== trialRunId(manifest.trial.authorization)) fail('EXPERIMENT_TRIAL_PROVENANCE_INVALID', 'The Runner has no original engineering trial provenance.');
  const { draft, snapshot } = await assertTrialAuthorization(projectId, manifest.trial.authorization, manifest.trial.plan, { workflow });
  const materialFields = ['command', 'code', 'dataset', 'environment', 'protocol', 'parameters', 'seed', 'resources', 'successCriteria', 'artifacts'];
  if (manifest.projectId !== projectId || !isDeepStrictEqual(manifest.command, draft.execution)
    || sourceHash(Object.fromEntries(materialFields.map(field => [field, manifest[field]]))) !== snapshot.materialSha256
    || manifest.code.preparation?.id !== snapshot.code.id || manifest.code.preparation?.sha256 !== snapshot.code.sha256
    || !isDeepStrictEqual(manifest.dataset, snapshot.dataset)
    || manifest.environment.preparation?.id !== (snapshot.environment?.id ?? undefined)
    || manifest.environment.preparation?.sha256 !== (snapshot.environment?.sha256 ?? undefined)) {
    fail('EXPERIMENT_TRIAL_MANIFEST_CHANGED', 'The engineering manifest differs from its original fixed inputs.');
  }
  if (executionBinding && (executionBinding.parentRunId !== snapshot.parentRunId
    || executionBinding.policyVersion !== String(manifest.trial.authorization.executionAuthorization.policyVersion))) {
    fail('EXPERIMENT_TRIAL_EXECUTION_OWNER_CHANGED', 'Only the original coordinator and execution grant may start this trial.');
  }
  return manifest.trial.authorization;
}

/** Read-only certificate after successful engineering inputs have been bound.
 * This deliberately cannot grant creation, approval, retries or execution. */
export async function assertCompletedTrial(projectId, run, { sessionId, stage, plan } = {}) {
  const root = await resolveExperimentProjectRoot(projectId);
  const stored = (await readExperimentRuns(root, projectId)).runs.find(item => item.id === run?.id);
  if (!stored || !isDeepStrictEqual(stored, run) || run.status !== 'completed' || run.purpose !== 'engineering-trial'
    || run.manifest?.purpose !== 'engineering-trial' || !run.manifest.trial?.authorization
    || run.execution?.process?.stopConfirmed !== true || !Number.isSafeInteger(run.execution.process.pid)
    || run.execution.process.pid < 1 || run.execution.exitCode !== 0) {
    fail('EXPERIMENT_TRIAL_COMPLETION_REQUIRED', 'Only the actual completed and stopped original engineering Runner may be reused.');
  }
  try { process.kill(run.execution.process.pid, 0); fail('EXPERIMENT_TRIAL_STOP_UNCONFIRMED', 'The engineering process is still present.'); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
  const authorization = run.manifest.trial.authorization;
  const current = await currentSource(projectId, { sessionId, stage, plan }, undefined, { completedBinding: true });
  const session = initializeAutomationExecutionPlan(current.session), binding = current.step.executionPlanBinding;
  const rows = (current.step.codeTrials || []).filter(item => item.runId === run.id);
  const { executionAuthorization, policyVersion, stageDataSha256, ...original } = authorization;
  const { stageDataSha256: currentStageSha, ...snapshot } = current.snapshot;
  if (!isDeepStrictEqual(original, snapshot) || typeof stageDataSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(stageDataSha256)
    || !isDeepStrictEqual(run.manifest.trial.plan, current.draft) || run.id !== trialRunId(authorization)
    || policyVersion !== executionAuthorization?.policyVersion || executionAuthorization?.actor !== 'system'
    || executionAuthorization?.part !== 'execution' || executionAuthorization?.sessionId !== sessionId
    || !Number.isSafeInteger(policyVersion) || policyVersion < 1
    || executionAuthorization.policyVersion > current.executionAuthorization.policyVersion
    || rows.length !== 1 || rows[0].status !== 'completed' || !isDeepStrictEqual(rows[0].authorization, authorization)
    || !isDeepStrictEqual(rows[0].plan, current.draft) || rows[0].manifestSha256 !== experimentManifestHash(run.manifest)
    || run.executionBinding?.parentRunId !== authorization.parentRunId
    || run.executionBinding?.policyVersion !== String(policyVersion)
    || run.executionBinding?.manifestSha256 !== rows[0].manifestSha256
    || !binding || binding.version !== session.executionPlanVersion || binding.sha256 !== sourceHash(current.draft)
    || session.executionPlanSha256 !== binding.sha256 || !isDeepStrictEqual(session.executionPlan, current.draft)) {
    fail('EXPERIMENT_TRIAL_CERTIFICATE_CHANGED', 'The completed trial, original grant or consumed formal plan no longer matches.');
  }
  const materialFields = ['command', 'code', 'dataset', 'environment', 'protocol', 'parameters', 'seed', 'resources', 'successCriteria', 'artifacts'];
  if (sourceHash(Object.fromEntries(materialFields.map(field => [field, run.manifest[field]]))) !== snapshot.materialSha256) {
    fail('EXPERIMENT_TRIAL_MANIFEST_CHANGED', 'The completed trial manifest no longer matches its fixed materials.');
  }
  if (!Array.isArray(run.artifacts) || !run.artifacts.length) fail('EXPERIMENT_TRIAL_ARCHIVE_REQUIRED', 'The completed engineering archive is unavailable.');
  for (const artifact of run.artifacts) {
    const bytes = await fs.readFile(safeJoin(root, artifact.path));
    if (bytes.byteLength !== artifact.bytes || createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) {
      fail('EXPERIMENT_TRIAL_ARCHIVE_CHANGED', 'An original engineering archive no longer matches its retained bytes.');
    }
  }
  return stored;
}

/** A read-only failure receipt for the original bounded code repair. Missing
 * outputs qualify only when a real process also exited nonzero; no permission,
 * isolation, cancellation, interruption, timeout or other archive error does. */
export async function assertRepairableTrial(projectId, run, { sessionId, stage, plan } = {}) {
  const root = await resolveExperimentProjectRoot(projectId);
  const stored = (await readExperimentRuns(root, projectId)).runs.find(item => item.id === run?.id);
  const errors = ['EXPERIMENT_EXIT_NONZERO', 'ARTIFACT_MISSING'];
  if (!stored || !isDeepStrictEqual(stored, run) || run.status !== 'failed' || run.purpose !== 'engineering-trial'
    || run.manifest?.purpose !== 'engineering-trial' || !errors.includes(run.error?.code) || run.evidenceError
    || !Number.isSafeInteger(run.execution?.exitCode) || run.execution.exitCode < 1 || run.execution.signal
    || run.execution.error && !(run.error.code === 'ARTIFACT_MISSING' && run.execution.error.code === 'ARTIFACT_MISSING')
    || run.execution.process?.stopConfirmed !== true || !Number.isSafeInteger(run.execution.process.pid) || run.execution.process.pid < 1) {
    fail('EXPERIMENT_TRIAL_NOT_REPAIRABLE', 'Only an actual stopped nonzero engineering failure may request the original bounded code repair.');
  }
  try { process.kill(run.execution.process.pid, 0); fail('EXPERIMENT_TRIAL_STOP_UNCONFIRMED', 'The failed engineering process is still present.'); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
  const manifestSha256 = experimentManifestHash(run.manifest);
  const authorization = await assertTrialExperiment(projectId, run.manifest, { executionBinding: run.executionBinding });
  const state = await readAutomation(projectId), step = state.session?.steps?.find(item => item.stage === stage);
  const rows = (step?.codeTrials || []).filter(item => item.runId === run.id);
  if (state.session?.id !== sessionId || authorization.sessionId !== sessionId || authorization.stage !== stage
    || state.session.coordinatorRunId !== authorization.parentRunId || state.session.currentStage !== stage
    || state.session.status !== 'running' || state.session.stopRequested || state.session.executionPlan
    || step.executionPlanBinding || step.experimentRunId || rows.length !== 1 || rows[0].status !== 'failed'
    || !isDeepStrictEqual(rows[0].authorization, authorization) || !isDeepStrictEqual(rows[0].plan, plan)
    || !isDeepStrictEqual(run.manifest.trial.plan, plan) || rows[0].manifestSha256 !== manifestSha256
    || !run.executionBinding || run.executionBinding.parentRunId !== authorization.parentRunId
    || run.executionBinding.policyVersion !== String(authorization.policyVersion)
    || run.executionBinding.manifestSha256 !== manifestSha256) {
    fail('EXPERIMENT_TRIAL_REPAIR_BINDING_CHANGED', 'The original failed trial, unconsumed draft or approved execution binding changed.');
  }
  const prefix = `.scienceprism/experiment-runs/${run.id}/artifacts/`;
  const artifacts = [], logs = {};
  if (!Array.isArray(run.artifacts) || !run.artifacts.length) fail('EXPERIMENT_TRIAL_ARCHIVE_REQUIRED', 'The original failed engineering archive is unavailable.');
  for (const artifact of run.artifacts) {
    if (typeof artifact.path !== 'string' || !artifact.path.startsWith(prefix) || artifact.path.slice(prefix.length).split('/').some(part => !part || ['.', '..'].includes(part))
      || !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0 || artifact.bytes > run.manifest.resources.maxArtifactBytes
      || !/^[a-f0-9]{64}$/.test(artifact.sha256) || artifacts.some(item => item.path === artifact.path)) {
      fail('EXPERIMENT_TRIAL_ARCHIVE_CHANGED', 'The original engineering archive has invalid or duplicate fixed metadata.');
    }
    const target = safeJoin(root, artifact.path);
    if (await fs.realpath(target) !== target) fail('EXPERIMENT_TRIAL_ARCHIVE_CHANGED', 'The failed engineering archive cannot follow filesystem links.');
    const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let bytes;
    try {
      const initial = await handle.stat();
      if (!initial.isFile() || initial.nlink !== 1 || initial.size !== artifact.bytes) fail('EXPERIMENT_TRIAL_ARCHIVE_CHANGED', 'An original archived file no longer matches its retained size.');
      bytes = await handle.readFile();
      const final = await handle.stat();
      if (final.size !== initial.size || bytes.byteLength !== artifact.bytes || createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) {
        fail('EXPERIMENT_TRIAL_ARCHIVE_CHANGED', 'An original engineering archive no longer matches its retained bytes.');
      }
    } finally { await handle.close(); }
    artifacts.push({ path: artifact.path, sha256: artifact.sha256, bytes: artifact.bytes });
    if (artifact.path === `${prefix}stdout.log`) logs.stdout = bytes.toString('utf8').slice(-20000).toWellFormed();
    if (artifact.path === `${prefix}stderr.log`) logs.stderr = bytes.toString('utf8').slice(-20000).toWellFormed();
  }
  if (logs.stdout === undefined || logs.stderr === undefined) fail('EXPERIMENT_TRIAL_ARCHIVE_REQUIRED', 'The failed trial must retain its actual stdout and stderr archives.');
  return { runId: run.id, manifestSha256, codePreparationId: run.manifest.command.codePreparationId,
    exitCode: run.execution.exitCode, stdout: logs.stdout, stderr: logs.stderr, artifacts };
}
