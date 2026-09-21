import { ResearchWorkflowError, assertExpectedVersion, assertPlainObject, sanitizeNote } from './errors.js';
import { appendAudit, clone } from './audit.js';
import { applyApprovalDecision, applyRecovery, applyReset, applyStageUpdate, createWorkflowDocument } from './stateMachine.js';
import { normalizeSkillBindings } from './skillBindings.js';
import { readWorkflowFile, resolveProjectRoot, withWorkflowLock, writeWorkflowFile } from './repository.js';

function commandKey(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const key = String(value).trim();
  if (!key || key.length > 200) throw new ResearchWorkflowError(400, 'INVALID_IDEMPOTENCY_KEY', 'idempotencyKey must be between 1 and 200 characters.');
  return key;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  return value;
}

function fingerprint(command, payload) {
  return JSON.stringify(stableValue({ command, payload }));
}

function receiptFor(workflow, key, expectedFingerprint) {
  if (!key) return null;
  const receipt = workflow.commandReceipts?.[key];
  if (!receipt) return null;
  if (receipt.fingerprint !== expectedFingerprint) throw new ResearchWorkflowError(409, 'IDEMPOTENCY_KEY_REUSED', 'idempotencyKey was already used for a different command.');
  return clone(workflow);
}

function rememberReceipt(workflow, key, expectedFingerprint, command) {
  if (!key) return;
  workflow.commandReceipts = workflow.commandReceipts || {};
  workflow.commandReceipts[key] = { command, fingerprint: expectedFingerprint, version: workflow.version, recordedAt: workflow.updatedAt };
  const keys = Object.keys(workflow.commandReceipts);
  if (keys.length > 100) delete workflow.commandReceipts[keys[0]];
}

async function mutateWorkflow(projectId, { command, actor, note, expectedVersion, idempotencyKey, payload = {}, mutate }) {
  const root = await resolveProjectRoot(projectId);
  const key = commandKey(idempotencyKey);
  const expectedFingerprint = fingerprint(command, payload);
  return withWorkflowLock(projectId, async () => {
    const workflow = await readWorkflowFile(root, projectId);
    const replay = receiptFor(workflow, key, expectedFingerprint);
    if (replay) return replay;
    const version = assertExpectedVersion(expectedVersion);
    if (version !== undefined && version !== workflow.version) {
      throw new ResearchWorkflowError(409, 'VERSION_CONFLICT', 'Research workflow changed since it was read.', { expectedVersion: version, actualVersion: workflow.version });
    }
    const next = mutate(workflow);
    rememberReceipt(next, key, expectedFingerprint, command);
    await writeWorkflowFile(root, next);
    return next;
  });
}

export async function initializeResearchWorkflow(projectId, { data = {}, actor, idempotencyKey } = {}) {
  const root = await resolveProjectRoot(projectId);
  const initialData = assertPlainObject(data);
  const key = commandKey(idempotencyKey);
  const expectedFingerprint = fingerprint('initialize', { data: initialData });
  return withWorkflowLock(projectId, async () => {
    try {
      const existing = await readWorkflowFile(root, projectId);
      const replay = receiptFor(existing, key, expectedFingerprint);
      if (replay) return replay;
      throw new ResearchWorkflowError(409, 'WORKFLOW_EXISTS', 'Research workflow already exists.');
    } catch (error) {
      if (error instanceof ResearchWorkflowError && error.code !== 'WORKFLOW_NOT_FOUND') throw error;
    }
    const workflow = createWorkflowDocument(projectId, { data: initialData, actor });
    rememberReceipt(workflow, key, expectedFingerprint, 'initialize');
    await writeWorkflowFile(root, workflow);
    return workflow;
  });
}

export function updateResearchWorkflow(projectId, options = {}) {
  return mutateWorkflow(projectId, {
    command: 'update', actor: options.actor, note: options.note, expectedVersion: options.expectedVersion, idempotencyKey: options.idempotencyKey,
    payload: { stageId: options.stageId, data: options.data, patch: options.patch, status: options.status },
    mutate: (workflow) => applyStageUpdate(workflow, options)
  });
}

export function approveResearchWorkflow(projectId, options = {}) {
  return mutateWorkflow(projectId, {
    command: options.decision || 'approve', actor: options.actor, note: options.note, expectedVersion: options.expectedVersion, idempotencyKey: options.idempotencyKey,
    payload: { stageId: options.stageId, decision: options.decision || 'approve', note: options.note },
    mutate: (workflow) => applyApprovalDecision(workflow, options)
  });
}

export function rejectResearchWorkflow(projectId, options = {}) { return approveResearchWorkflow(projectId, { ...options, decision: 'reject' }); }
export function skipResearchWorkflow(projectId, options = {}) { return approveResearchWorkflow(projectId, { ...options, decision: 'skip' }); }

export function recoverResearchWorkflow(projectId, options = {}) {
  return mutateWorkflow(projectId, {
    command: 'recover', actor: options.actor, note: options.note, expectedVersion: options.expectedVersion, idempotencyKey: options.idempotencyKey,
    payload: { note: options.note }, mutate: (workflow) => applyRecovery(workflow, options)
  });
}

export function resetResearchWorkflow(projectId, options = {}) {
  return mutateWorkflow(projectId, {
    command: 'reset', actor: options.actor, note: options.note, expectedVersion: options.expectedVersion, idempotencyKey: options.idempotencyKey,
    payload: { note: options.note }, mutate: (workflow) => applyReset(workflow, options)
  });
}

export function updateResearchSkillBindings(projectId, { bindings, actor, note, expectedVersion, idempotencyKey } = {}) {
  const normalizedBindings = normalizeSkillBindings(bindings);
  return mutateWorkflow(projectId, {
    command: 'update-skills', actor, note, expectedVersion, idempotencyKey, payload: { bindings: normalizedBindings },
    mutate: (workflow) => {
      if (workflow.status === 'completed') throw new ResearchWorkflowError(409, 'WORKFLOW_COMPLETED', 'Completed research workflows cannot be changed.');
      workflow.skillBindings = normalizedBindings;
      appendAudit(workflow, 'workflow.skills.updated', {
        actor, note: sanitizeNote(note), details: { stages: Object.keys(normalizedBindings), skillCount: Object.values(normalizedBindings).reduce((count, skillNames) => count + skillNames.length, 0) }
      });
      return workflow;
    }
  });
}

export { commandKey, fingerprint };

