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
    const binding = step.executionPlanBinding;
    if (binding === undefined || binding === null) continue;
    if (!plain(binding) || Object.keys(binding).length !== 2 || !Number.isSafeInteger(binding.version) || binding.version < 1
      || typeof binding.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(binding.sha256)) fail('AUTOMATION_EXECUTION_PLAN_CHANGED', 'The consumed execution plan binding is invalid.');
    if (binding.version !== next.executionPlanVersion || binding.sha256 !== next.executionPlanSha256) fail('AUTOMATION_EXECUTION_PLAN_CHANGED', 'The consumed execution materials do not match the current plan.');
  }
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
