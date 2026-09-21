import crypto from 'node:crypto';
import { ResearchWorkflowError, assertPlainObject, sanitizeActor, sanitizeNote } from './errors.js';
import { appendAudit, clone } from './audit.js';
import { getStageReadiness, RESEARCH_WORKFLOW_STAGES, assertStageId } from './stageContracts.js';
import { markStageTaskDecision } from './stageTask.js';

export function mergeStageData(previous, patch) {
  const next = { ...(previous || {}) };
  for (const [key, value] of Object.entries(patch || {})) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) continue;
    if (value !== null && typeof value === 'object' && !Array.isArray(value) && next[key] !== null && typeof next[key] === 'object' && !Array.isArray(next[key])) {
      next[key] = mergeStageData(next[key], value);
    } else {
      next[key] = clone(value);
    }
  }
  return next;
}

function createStage(definition, status = 'pending', data = {}, now = new Date().toISOString()) {
  return {
    id: definition.id,
    label: definition.label,
    order: RESEARCH_WORKFLOW_STAGES.findIndex((stage) => stage.id === definition.id),
    status,
    data: clone(data),
    startedAt: status === 'in_progress' ? now : null,
    updatedAt: now,
    approvedAt: null,
    approvedBy: null,
    rejection: null,
    skippedAt: null,
    skippedBy: null,
    skipReason: null
  };
}

export function createWorkflowDocument(projectId, { id = crypto.randomUUID(), createdAt = new Date().toISOString(), data = {}, actor, now = new Date().toISOString() } = {}) {
  const firstStage = RESEARCH_WORKFLOW_STAGES[0];
  const workflow = {
    schemaVersion: 3,
    id,
    projectId,
    status: 'in_progress',
    currentStage: firstStage.id,
    createdAt,
    updatedAt: now,
    version: 1,
    stages: RESEARCH_WORKFLOW_STAGES.map((definition, index) => createStage(definition, index === 0 ? 'in_progress' : 'pending', index === 0 ? data : {}, now)),
    skillBindings: {},
    commandReceipts: {},
    audit: []
  };
  workflow.audit.push({
    id: crypto.randomUUID(),
    type: 'workflow.created',
    at: now,
    actor: sanitizeActor(actor),
    details: { stageId: firstStage.id, previousVersion: 0 }
  });
  return workflow;
}

function currentStage(workflow, requestedStageId) {
  if (requestedStageId) assertStageId(requestedStageId);
  if (requestedStageId && requestedStageId !== workflow.currentStage) {
    throw new ResearchWorkflowError(409, 'STAGE_GATE', 'Only the current stage can be changed or approved.', {
      currentStage: workflow.currentStage,
      requestedStage: requestedStageId
    });
  }
  const stage = workflow.stages.find((item) => item.id === workflow.currentStage);
  if (!stage) throw new ResearchWorkflowError(500, 'WORKFLOW_CORRUPT', 'Current workflow stage is missing.');
  return stage;
}

function assertMutable(workflow, message = 'Completed research workflows cannot be changed.') {
  if (workflow.status === 'completed') throw new ResearchWorkflowError(409, 'WORKFLOW_COMPLETED', message);
}

export function applyStageUpdate(workflow, { stageId, data, patch, status, actor, note, now = new Date().toISOString() } = {}) {
  assertMutable(workflow);
  const stage = currentStage(workflow, stageId);
  const nextData = data !== undefined ? data : patch;
  if (nextData === undefined) throw new ResearchWorkflowError(400, 'MISSING_DATA', 'Provide data or patch to update the current stage.');
  const patchData = assertPlainObject(nextData, 'data');
  const sanitizedNote = sanitizeNote(note);
  stage.data = mergeStageData(stage.data, patchData);
  stage.updatedAt = now;
  if (stage.status === 'rejected') {
    stage.status = 'in_progress';
    stage.rejection = null;
    workflow.status = 'in_progress';
  }
  if (status !== undefined) {
    if (!['in_progress', 'awaiting_approval'].includes(status)) {
      throw new ResearchWorkflowError(400, 'INVALID_STAGE_STATUS', 'Updates may only set in_progress or awaiting_approval.');
    }
    if (status === 'awaiting_approval') {
      const readiness = getStageReadiness(workflow, stage.id);
      if (!readiness.ready) throw new ResearchWorkflowError(409, 'STAGE_NOT_READY', 'Stage is not ready for approval.', readiness);
    }
    stage.status = status;
  }
  appendAudit(workflow, 'stage.updated', {
    stageId: stage.id,
    actor,
    note: sanitizedNote,
    details: { fields: Object.keys(patchData), status: stage.status },
    now
  });
  return workflow;
}

export function applyApprovalDecision(workflow, { stageId, decision = 'approve', actor, note, now = new Date().toISOString() } = {}) {
  assertMutable(workflow, 'Completed research workflows cannot be approved.');
  const stage = currentStage(workflow, stageId);
  if (stage.status === 'approved') throw new ResearchWorkflowError(409, 'STAGE_ALREADY_APPROVED', 'Current stage has already been approved.');
  if (!['approve', 'reject', 'skip'].includes(decision)) throw new ResearchWorkflowError(400, 'INVALID_DECISION', 'decision must be approve, reject, or skip.');
  const sanitizedNote = sanitizeNote(note);

  if (decision === 'reject') {
    stage.status = 'rejected';
    if (stage.data?.task) stage.data.task = markStageTaskDecision(stage.data.task, { decision, actor, note: sanitizedNote, at: now });
    stage.rejection = { at: now, by: sanitizeActor(actor), note: sanitizedNote || null };
    stage.updatedAt = now;
    workflow.status = 'blocked';
    appendAudit(workflow, 'stage.rejected', { stageId: stage.id, actor, note: sanitizedNote, details: { status: workflow.status }, now });
    return workflow;
  }

  if (decision === 'skip') {
    if (stage.id !== 'replication') throw new ResearchWorkflowError(409, 'STAGE_NOT_OPTIONAL', 'Only the replication stage can be skipped.');
    if (!sanitizedNote) throw new ResearchWorkflowError(400, 'SKIP_REASON_REQUIRED', 'A note is required when skipping replication.');
    const next = RESEARCH_WORKFLOW_STAGES[stage.order + 1];
    if (!next) throw new ResearchWorkflowError(409, 'NO_NEXT_STAGE', 'No stage is available after the current stage.');
    stage.status = 'skipped';
    if (stage.data?.task) stage.data.task = markStageTaskDecision(stage.data.task, { decision, actor, note: sanitizedNote, at: now });
    stage.skippedAt = now;
    stage.skippedBy = sanitizeActor(actor);
    stage.skipReason = sanitizedNote;
    stage.updatedAt = now;
    const nextStage = workflow.stages.find((item) => item.id === next.id);
    nextStage.status = 'in_progress';
    nextStage.startedAt = now;
    nextStage.updatedAt = now;
    workflow.currentStage = next.id;
    workflow.status = 'in_progress';
    appendAudit(workflow, 'stage.skipped', { stageId: stage.id, actor, note: sanitizedNote, details: { nextStage: next.id, optional: true }, now });
    return workflow;
  }

  const readiness = getStageReadiness(workflow, stage.id);
  if (!readiness.ready) throw new ResearchWorkflowError(409, 'STAGE_NOT_READY', 'Stage is not ready for approval.', readiness);
  stage.status = 'approved';
  if (stage.data?.task) stage.data.task = markStageTaskDecision(stage.data.task, { decision, actor, note: sanitizedNote, at: now });
  stage.approvedAt = now;
  stage.approvedBy = sanitizeActor(actor);
  stage.updatedAt = now;
  stage.rejection = null;
  const next = RESEARCH_WORKFLOW_STAGES[stage.order + 1];
  if (next) {
    const nextStage = workflow.stages.find((item) => item.id === next.id);
    nextStage.status = 'in_progress';
    nextStage.startedAt = now;
    nextStage.updatedAt = now;
    workflow.currentStage = next.id;
    workflow.status = 'in_progress';
  } else {
    workflow.status = 'completed';
  }
  appendAudit(workflow, 'stage.approved', { stageId: stage.id, actor, note: sanitizedNote, details: { nextStage: next?.id || null, workflowStatus: workflow.status }, now });
  return workflow;
}

export function applyRecovery(workflow, { actor, note, now = new Date().toISOString() } = {}) {
  if (workflow.status !== 'blocked' || workflow.currentStage === undefined) {
    throw new ResearchWorkflowError(409, 'WORKFLOW_NOT_BLOCKED', 'Only a blocked workflow can be recovered.');
  }
  const stage = currentStage(workflow);
  if (stage.status !== 'rejected') throw new ResearchWorkflowError(409, 'WORKFLOW_NOT_RECOVERABLE', 'The current workflow stage is not rejected.');
  const sanitizedNote = sanitizeNote(note);
  stage.status = 'in_progress';
  stage.rejection = null;
  stage.updatedAt = now;
  workflow.status = 'in_progress';
  appendAudit(workflow, 'workflow.recovered', { stageId: stage.id, actor, note: sanitizedNote, details: { status: workflow.status }, now });
  return workflow;
}

export function applyReset(workflow, { actor, note, now = new Date().toISOString() } = {}) {
  const reset = createWorkflowDocument(workflow.projectId, { id: workflow.id, createdAt: workflow.createdAt, actor, now });
  reset.version = (Number(workflow.version) || 1) + 1;
  const sanitizedNote = sanitizeNote(note);
  reset.audit = [
    ...(Array.isArray(workflow.audit) ? workflow.audit : []),
    {
      id: crypto.randomUUID(),
      type: 'workflow.reset',
      at: now,
      actor: sanitizeActor(actor),
      ...(sanitizedNote ? { note: sanitizedNote } : {}),
      details: { previousVersion: workflow.version }
    }
  ];
  reset.updatedAt = now;
  reset.commandReceipts = {};
  return reset;
}

export { assertMutable, currentStage };
