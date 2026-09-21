import crypto from 'node:crypto';
import { sanitizeActor } from './errors.js';

export function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

export function auditEvent(type, { stageId, actor, note, details, now = new Date().toISOString() } = {}) {
  const event = { id: crypto.randomUUID(), type, at: now, actor: sanitizeActor(actor) };
  if (stageId !== undefined) event.stageId = stageId;
  if (note) event.note = note;
  if (details !== undefined) event.details = clone(details);
  return event;
}

export function appendAudit(workflow, type, { actor, stageId, note, details, now } = {}) {
  const previousVersion = Number(workflow.version) || 0;
  workflow.audit = Array.isArray(workflow.audit) ? workflow.audit : [];
  workflow.audit.push(auditEvent(type, {
    actor,
    stageId,
    note,
    details: { ...(details || {}), previousVersion },
    now
  }));
  workflow.updatedAt = now || new Date().toISOString();
  workflow.version = previousVersion + 1;
  return workflow;
}

