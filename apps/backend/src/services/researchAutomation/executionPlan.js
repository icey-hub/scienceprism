import { validateAutomationExecution } from './policy.js';
import { sourceHash } from './handoff.js';
import { RESEARCH_WORKFLOW_STAGES } from '../researchWorkflow/stageContracts.js';
import { ResearchWorkflowError } from '../researchWorkflow/errors.js';

const stages = RESEARCH_WORKFLOW_STAGES.map(stage => stage.id);
const origins = new Set(['human', 'model', 'stage', 'legacy']);
const fail = (code, message, status = 409) => { throw new ResearchWorkflowError(status, code, message); };
const identity = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && value === value.trim()
  && value.isWellFormed() && !/[\x00-\x1f\x7f]/.test(value);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function normalize(value) {
  try {
    const plan = validateAutomationExecution(value);
    return { plan, sha256: plan ? sourceHash(plan) : null };
  } catch (reason) {
    if (reason instanceof ResearchWorkflowError && reason.code === 'INVALID_AUTOMATION_EXECUTION') throw reason;
    fail('INVALID_AUTOMATION_EXECUTION', 'Execution materials require bounded, complete and finite JSON.', 400);
  }
}
function consumed(step) {
  return Boolean(step.executionPlanBinding || step.experimentRunId || ['replication', 'experiment'].includes(step.stage)
    && (step.prepared || step.result || step.calls?.some(call => ['research:reproduction_plan', 'research:experiment_plan', 'reproduction_plan', 'experiment_plan'].includes(call.task))));
}
export function isAutomationExecutionPlanLocked(session) {
  const steps = Array.isArray(session?.steps) ? session.steps.filter(plain) : [];
  return session?.executionPlan ? steps.some(consumed) : steps.some(step => step.executionPlanBinding || step.experimentRunId);
}
function sessionCopy(value) {
  if (!plain(value) || !identity(value.id) || value.steps !== undefined && (!Array.isArray(value.steps)
    || value.steps.some(step => !plain(step) || !stages.includes(step.stage))
    || new Set(value.steps.map(step => step.stage)).size !== value.steps.length)) fail('INVALID_AUTOMATION_EXECUTION_SESSION', 'A saved automation session and unambiguous steps are required.', 400);
  try { return structuredClone(value); } catch { fail('INVALID_AUTOMATION_EXECUTION_SESSION', 'The automation session could not be copied.', 400); }
}

/** Version the normalized current materials. This never assigns a historical
 * step a binding merely because the mutable session still contains a plan. */
export function initializeAutomationExecutionPlan(session) {
  const next = sessionCopy(session), normalized = normalize(next.executionPlan);
  const old = next.executionPlanVersion === undefined && next.executionPlanSha256 === undefined;
  if (old) {
    next.executionPlanVersion = normalized.plan ? 1 : 0;
    next.executionPlanSha256 = normalized.sha256;
    if (normalized.plan && next.executionPlanOrigin === undefined) next.executionPlanOrigin = 'legacy';
  } else if (!Number.isSafeInteger(next.executionPlanVersion) || next.executionPlanVersion < 0
    || normalized.plan && next.executionPlanVersion < 1 || !normalized.plan && next.executionPlanVersion !== 0
    || next.executionPlanSha256 !== normalized.sha256) fail('AUTOMATION_EXECUTION_PLAN_CHANGED', 'The saved execution plan version or hash does not match its actual materials.');
  if (next.executionPlanOrigin !== undefined && !origins.has(next.executionPlanOrigin)) fail('INVALID_AUTOMATION_EXECUTION_ORIGIN', 'Execution plan origin is unsupported.', 400);
  if (normalized.plan) next.executionPlan = normalized.plan;
  else if (next.executionPlan !== undefined) next.executionPlan = null;
  for (const step of next.steps || []) {
    const material = step.materialPreparation;
    if (material !== undefined && material !== null) {
      const source = plain(material) ? normalize(material.sourcePlan) : { plan: null, sha256: null };
      if (!plain(material) || Object.keys(material).length !== 5
        || Object.keys(material).some(key => !['sourcePlan', 'sourceVersion', 'sourceSha256', 'preparedSha256', 'preparedVersion'].includes(key))
        || !source.plan || !Number.isSafeInteger(material.sourceVersion) || material.sourceVersion < 1
        || material.sourceSha256 !== source.sha256 || sourceHash(material.sourcePlan) !== source.sha256
        || material.preparedVersion !== material.sourceVersion + 1 || material.preparedVersion !== next.executionPlanVersion
        || material.preparedSha256 !== next.executionPlanSha256 || material.preparedSha256 === material.sourceSha256) {
        fail('AUTOMATION_EXECUTION_MATERIALS_CHANGED', 'The saved source and prepared material versions or hashes do not match their actual plans.');
      }
    }
    const binding = step.executionPlanBinding;
    if (binding === undefined || binding === null) continue;
    if (!plain(binding) || Object.keys(binding).length !== 2 || !Number.isSafeInteger(binding.version) || binding.version < 1
      || typeof binding.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(binding.sha256)) fail('AUTOMATION_EXECUTION_PLAN_CHANGED', 'The consumed execution plan binding is invalid.');
    if (binding.version !== next.executionPlanVersion || binding.sha256 !== next.executionPlanSha256) fail('AUTOMATION_EXECUTION_PLAN_CHANGED', 'The consumed execution materials do not match the current plan.');
  }
  return next;
}

/** Complete only code/environment references in the original unconsumed plan.
 * The caller verifies actual domain inputs and the stopped trial under its
 * workflow lock; this pure transition retains the user's scientific tuple. */
export function prepareAutomationExecutionMaterials(session, stage, plan) {
  const next = initializeAutomationExecutionPlan(session);
  if (!next.executionPlan) return next;
  const prepared = normalize(plan);
  if (prepared.sha256 === next.executionPlanSha256) return next;
  if (!['replication', 'experiment'].includes(stage) || next.status !== 'running' || next.stopRequested || next.currentStage !== stage) {
    fail('AUTOMATION_EXECUTION_MATERIALS_INACTIVE', 'Material completion requires the original running research stage.');
  }
  const step = next.steps?.find(item => item.stage === stage);
  if (!step || isAutomationExecutionPlanLocked(next) || next.steps.some(consumed)) {
    fail('AUTOMATION_EXECUTION_PLAN_LOCKED', 'Consumed execution plans cannot receive automatic material changes.');
  }
  if (next.steps.some(item => item.materialPreparation)) fail('AUTOMATION_EXECUTION_MATERIALS_LOCKED', 'Preserve the one completed material preparation instead of assigning new references.');
  const source = next.executionPlan, target = prepared.plan;
  const scientific = value => {
    const copy = structuredClone(value);
    delete copy.codePaths; delete copy.execution.codePreparationId; delete copy.execution.environmentId;
    return sourceHash(copy);
  };
  if (!target || scientific(source) !== scientific(target)
    || source.execution.codePreparationId && source.execution.codePreparationId !== target.execution.codePreparationId
    || source.execution.environmentId && source.execution.environmentId !== target.execution.environmentId) {
    fail('AUTOMATION_EXECUTION_MATERIALS_PROTOCOL_CHANGED', 'Only missing fixed code and environment references may be completed; preserve all scientific inputs and explicitly selected versions.');
  }
  const addingCode = !source.execution.codePreparationId && !!target.execution.codePreparationId;
  const addingEnvironment = !source.execution.environmentId && !!target.execution.environmentId;
  let code;
  if (addingCode) {
    const rows = (step.codePreparations || []).filter(item => item.preparationId === target.execution.codePreparationId && item.status === 'completed');
    code = rows[0];
    if (rows.length !== 1 || code.sha256 !== target.execution.codePreparationId.slice(17) || !identity(code.producerRunId)
      || code.authorization?.sessionId !== next.id || code.authorization?.parentRunId !== next.coordinatorRunId || code.authorization?.stage !== stage
      || !code.input?.executionPlan || normalize(code.input.executionPlan).sha256 !== next.executionPlanSha256
      || sourceHash(code.input) !== code.authorization.inputSha256
      || !Array.isArray(code.paths) || !code.paths.length || code.paths.some(value => typeof value !== 'string' || !value)
      || !step.calls?.some(call => call.runId === code.producerRunId && ['research:code-preparation', 'research:code-repair'].includes(call.task))) {
      fail('AUTOMATION_EXECUTION_MATERIALS_CODE_REQUIRED', 'The original stage must retain the completed code producer and its unchanged source plan.');
    }
    const trials = (step.codeTrials || []).filter(item => item.status === 'completed' && normalize(item.plan).sha256 === prepared.sha256);
    if (trials.length !== 1 || !identity(trials[0].runId) || !/^[a-f0-9]{64}$/.test(trials[0].manifestSha256)
      || trials[0].authorization?.sessionId !== next.id || trials[0].authorization?.parentRunId !== next.coordinatorRunId
      || trials[0].authorization?.stage !== stage || trials[0].authorization?.code?.id !== code.preparationId
      || trials[0].authorization?.code?.sha256 !== code.sha256 || trials[0].authorization?.draftPlanSha256 !== prepared.sha256) {
      fail('AUTOMATION_EXECUTION_MATERIALS_TRIAL_REQUIRED', 'Complete and retain the exact fixed-code engineering trial before enriching the user plan.');
    }
  }
  if (addingEnvironment) {
    const rows = (step.environmentPreparations || []).filter(item => item.environmentId === target.execution.environmentId && item.status === 'completed');
    const environment = rows[0];
    if (rows.length !== 1 || !/^[a-f0-9]{64}$/.test(environment.sha256) || !identity(environment.jobId)
      || environment.authorization?.sessionId !== next.id || environment.authorization?.parentRunId !== next.coordinatorRunId || environment.authorization?.stage !== stage
      || !step.calls?.some(call => call.runId === environment.authorization.sourceRunId && call.task === 'research:environment_proposal')) {
      fail('AUTOMATION_EXECUTION_MATERIALS_ENVIRONMENT_REQUIRED', 'The original stage must retain the completed fixed environment preparation.');
    }
  }
  if (addingCode || sourceHash(source.codePaths ?? null) !== sourceHash(target.codePaths ?? null)) {
    const originals = source.codePaths ?? code?.input.availableFiles?.map(file => file.path);
    const allowed = new Set([...(originals || []), ...(code?.paths || [])]);
    if (!addingCode || !Array.isArray(originals) || !Array.isArray(target.codePaths) || new Set(target.codePaths).size !== target.codePaths.length
      || originals.some(file => !target.codePaths.includes(file)) || code.paths.some(file => !target.codePaths.includes(file))
      || target.codePaths.some(file => !allowed.has(file))) {
      fail('AUTOMATION_EXECUTION_MATERIALS_PATHS_CHANGED', 'Keep the original input paths and add only the completed producer source files.');
    }
  }
  if (!addingCode && !addingEnvironment) fail('AUTOMATION_EXECUTION_MATERIALS_REQUIRED', 'No proven missing code or environment material was added.');
  step.materialPreparation = { sourcePlan: structuredClone(source), sourceVersion: next.executionPlanVersion,
    sourceSha256: next.executionPlanSha256, preparedSha256: prepared.sha256, preparedVersion: next.executionPlanVersion + 1 };
  next.executionPlan = target; next.executionPlanVersion++; next.executionPlanSha256 = prepared.sha256;
  return next;
}

export function applyAutomationExecutionPlan(session, { executionPlan, expectedSessionId, expectedExecutionPlanVersion } = {}) {
  const next = initializeAutomationExecutionPlan(session);
  if (executionPlan === undefined || executionPlan === null) return next;
  if (!identity(expectedSessionId) || !Number.isSafeInteger(expectedExecutionPlanVersion) || expectedExecutionPlanVersion < 0) fail('AUTOMATION_EXECUTION_PLAN_VERSION_REQUIRED', 'Replacing execution materials requires the saved session and plan version.', 400);
  if (expectedSessionId !== next.id || expectedExecutionPlanVersion !== next.executionPlanVersion) fail('AUTOMATION_EXECUTION_PLAN_CONFLICT', 'The automation session or execution plan version changed.');
  const normalized = normalize(executionPlan);
  if (normalized.sha256 === next.executionPlanSha256) return next;
  if (isAutomationExecutionPlanLocked(next)) fail('AUTOMATION_EXECUTION_PLAN_LOCKED', 'Execution materials have already been consumed; preserve the bound plan or start a new chain.');
  next.executionPlan = normalized.plan; next.executionPlanVersion++; next.executionPlanSha256 = normalized.sha256; next.executionPlanOrigin = 'human';
  return next;
}

export function bindAutomationExecutionPlan(session, stage, plan, { origin = 'stage' } = {}) {
  if (!['replication', 'experiment'].includes(stage) || !origins.has(origin)) fail('INVALID_AUTOMATION_EXECUTION_BINDING', 'A supported execution stage and plan origin are required.', 400);
  const next = initializeAutomationExecutionPlan(session), normalized = normalize(plan);
  if (!normalized.plan) fail('INVALID_AUTOMATION_EXECUTION', 'Concrete execution materials are required before consumption.', 400);
  const step = next.steps?.find(step => step.stage === stage);
  if (!step) fail('INVALID_AUTOMATION_EXECUTION_BINDING', 'The consuming stage must belong to the saved session.', 400);
  if (next.executionPlan && normalized.sha256 !== next.executionPlanSha256) fail('AUTOMATION_EXECUTION_PLAN_LOCKED', 'The consuming stage must use the current versioned execution materials.');
  if (step.executionPlanBinding) return next;
  if (consumed(step)) fail('AUTOMATION_EXECUTION_PLAN_LOCKED', 'This old step has consumed materials without a reliable binding; it cannot be retroactively authenticated.');
  if (!next.executionPlan) {
    if ((next.steps || []).some(consumed)) fail('AUTOMATION_EXECUTION_PLAN_LOCKED', 'Earlier execution consumption has no reliable plan binding.');
    next.executionPlan = normalized.plan; next.executionPlanVersion = 1; next.executionPlanSha256 = normalized.sha256; next.executionPlanOrigin = origin;
  }
  step.executionPlanBinding = { version: next.executionPlanVersion, sha256: next.executionPlanSha256 };
  return next;
}
