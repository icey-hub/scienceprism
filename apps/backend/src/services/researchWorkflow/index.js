import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getProjectRoot } from '../projectService.js';

export const RESEARCH_WORKFLOW_SCHEMA_VERSION = 2;
export const RESEARCH_WORKFLOW_FILE = path.join('.openprism', 'research-workflow.json');

export const RESEARCH_WORKFLOW_STAGES = Object.freeze([
  { id: 'direction', label: '研究方向', requirement: 'topic' },
  { id: 'search', label: '论文检索', requirement: 'queries' },
  { id: 'selection', label: '论文筛选', requirement: 'selectedPapers' },
  { id: 'replication', label: '论文复现（可选）', requirement: 'replication' },
  { id: 'ideation', label: '创新点', requirement: 'innovationPoints' },
  { id: 'method', label: '方法设计', requirement: 'method' },
  { id: 'experiment', label: '实验', requirement: 'experiments' },
  { id: 'writing', label: '论文写作', requirement: 'writing' }
]);

const STAGE_IDS = new Set(RESEARCH_WORKFLOW_STAGES.map((stage) => stage.id));
const STAGE_STATUSES = new Set(['pending', 'in_progress', 'awaiting_approval', 'approved', 'rejected', 'skipped']);
const WORKFLOW_STATUSES = new Set(['in_progress', 'blocked', 'completed']);
const PROJECT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_ACTOR_LENGTH = 120;
const MAX_NOTE_LENGTH = 2000;

const STAGE_VALUE_ALIASES = Object.freeze({
  direction: ['topic', 'researchQuestion', 'description', 'seedKeywords', 'keywords'],
  search: ['queries', 'searchQueries', 'papers', 'results'],
  selection: ['selectedPaperIds', 'selectedPapers', 'papers'],
  replication: ['replication', 'replicationPlan', 'reproduction', 'runs', 'results'],
  ideation: ['innovationPoints', 'ideas', 'candidates'],
  method: ['method', 'methodPlan', 'plan', 'approach'],
  experiment: ['experiment', 'experiments', 'runs', 'results', 'experimentResults', 'dataset', 'command', 'protocol'],
  writing: ['writing', 'outline', 'draft', 'manuscript']
});

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function now() {
  return new Date().toISOString();
}

function makeId() {
  return crypto.randomUUID();
}

function sanitizeActor(actor) {
  if (actor === undefined || actor === null || actor === '') return 'human';
  const value = String(actor).trim();
  if (!value || value.length > MAX_ACTOR_LENGTH) return 'human';
  return value;
}

function sanitizeNote(note) {
  if (note === undefined || note === null) return undefined;
  const value = String(note).trim();
  if (value.length > MAX_NOTE_LENGTH) {
    throw new ResearchWorkflowError(400, 'INVALID_NOTE', `note must be at most ${MAX_NOTE_LENGTH} characters.`);
  }
  return value || undefined;
}

function assertProjectId(projectId) {
  if (typeof projectId !== 'string' || !projectId || !PROJECT_ID_PATTERN.test(projectId)) {
    throw new ResearchWorkflowError(400, 'INVALID_PROJECT_ID', 'Invalid project id.');
  }
}

function assertStageId(stageId) {
  if (typeof stageId !== 'string' || !STAGE_IDS.has(stageId)) {
    throw new ResearchWorkflowError(400, 'INVALID_STAGE', 'Unknown research workflow stage.', {
      stageId,
      allowedStages: [...STAGE_IDS]
    });
  }
}

function assertData(data, field = 'data') {
  if (data === undefined) return {};
  if (!isPlainObject(data)) {
    throw new ResearchWorkflowError(400, 'INVALID_DATA', `${field} must be an object.`);
  }
  return data;
}

function skillBindingError(message, details, { stored = false } = {}) {
  return new ResearchWorkflowError(
    stored ? 500 : 400,
    stored ? 'WORKFLOW_CORRUPT' : 'INVALID_SKILL_BINDINGS',
    message,
    details
  );
}

function normalizeSkillName(name, { stored = false } = {}) {
  if (typeof name !== 'string') {
    throw skillBindingError('Each skill name must be a string.', { name }, { stored });
  }
  const normalized = name.trim().toLowerCase();
  if (!SKILL_NAME_PATTERN.test(normalized)) {
    throw skillBindingError(
      'Skill names must use normalized kebab-case.',
      { name },
      { stored }
    );
  }
  return normalized;
}

function normalizeSkillBindings(bindings, { stored = false, requireNormalized = false } = {}) {
  if (!isPlainObject(bindings)) {
    throw skillBindingError('skillBindings must be an object keyed by research workflow stage.', undefined, { stored });
  }
  const normalizedBindings = {};
  for (const [stageId, skillNames] of Object.entries(bindings)) {
    if (!STAGE_IDS.has(stageId)) {
      throw skillBindingError('skillBindings includes an unknown research workflow stage.', {
        stageId,
        allowedStages: [...STAGE_IDS]
      }, { stored });
    }
    if (!Array.isArray(skillNames)) {
      throw skillBindingError('Each skillBindings stage value must be an array.', { stageId }, { stored });
    }
    const names = [];
    const seen = new Set();
    for (const skillName of skillNames) {
      const normalizedName = normalizeSkillName(skillName, { stored });
      if (requireNormalized && skillName !== normalizedName) {
        throw skillBindingError('Stored skill names must use normalized kebab-case.', {
          stageId,
          name: skillName
        }, { stored });
      }
      if (!seen.has(normalizedName)) {
        seen.add(normalizedName);
        names.push(normalizedName);
      }
    }
    normalizedBindings[stageId] = names;
  }
  return normalizedBindings;
}

function stageDefinition(stageId) {
  assertStageId(stageId);
  return RESEARCH_WORKFLOW_STAGES.find((stage) => stage.id === stageId);
}

function createStage(stageDefinitionValue, status = 'pending', data = {}) {
  const timestamp = now();
  return {
    id: stageDefinitionValue.id,
    label: stageDefinitionValue.label,
    order: RESEARCH_WORKFLOW_STAGES.findIndex((stage) => stage.id === stageDefinitionValue.id),
    status,
    data: clone(data),
    startedAt: status === 'in_progress' ? timestamp : null,
    updatedAt: timestamp,
    approvedAt: null,
    approvedBy: null,
    rejection: null,
    skippedAt: null,
    skippedBy: null,
    skipReason: null
  };
}

function auditEvent(type, { stageId, actor, note, details } = {}) {
  const event = {
    id: makeId(),
    type,
    at: now(),
    actor: sanitizeActor(actor)
  };
  if (stageId !== undefined) event.stageId = stageId;
  if (note) event.note = note;
  if (details !== undefined) event.details = clone(details);
  return event;
}

function createWorkflowDocument(projectId, { id = makeId(), createdAt = now(), data = {}, actor } = {}) {
  const firstStage = RESEARCH_WORKFLOW_STAGES[0];
  const stages = RESEARCH_WORKFLOW_STAGES.map((definition, index) => createStage(
    definition,
    index === 0 ? 'in_progress' : 'pending',
    index === 0 ? data : {}
  ));
  const timestamp = now();
  return {
    schemaVersion: RESEARCH_WORKFLOW_SCHEMA_VERSION,
    id,
    projectId,
    status: 'in_progress',
    currentStage: firstStage.id,
    createdAt,
    updatedAt: timestamp,
    version: 1,
    stages,
    skillBindings: {},
    audit: [auditEvent('workflow.created', { actor, details: { stageId: firstStage.id } })]
  };
}

function workflowPath(projectRoot) {
  return path.join(projectRoot, RESEARCH_WORKFLOW_FILE);
}

async function resolveProjectRoot(projectId) {
  assertProjectId(projectId);
  try {
    return await getProjectRoot(projectId);
  } catch (error) {
    throw new ResearchWorkflowError(404, 'PROJECT_NOT_FOUND', 'Project not found.', { projectId });
  }
}

async function readWorkflowFile(projectRoot, projectId) {
  try {
    const raw = await fs.readFile(workflowPath(projectRoot), 'utf8');
    const parsedWorkflow = JSON.parse(raw);
    const { workflow, migrated } = migrateStoredWorkflow(parsedWorkflow, projectId);
    validateStoredWorkflow(workflow, projectId);
    if (migrated) await writeWorkflowFile(projectRoot, workflow);
    return workflow;
  } catch (error) {
    if (error instanceof ResearchWorkflowError) throw error;
    if (error?.code === 'ENOENT') {
      throw new ResearchWorkflowError(404, 'WORKFLOW_NOT_FOUND', 'Research workflow has not been initialized.');
    }
    if (error instanceof SyntaxError) {
      throw new ResearchWorkflowError(500, 'WORKFLOW_CORRUPT', 'Research workflow file is not valid JSON.');
    }
    throw error;
  }
}

function migrateStoredWorkflow(workflow, projectId) {
  if (!isPlainObject(workflow) || workflow.projectId !== projectId || !Array.isArray(workflow.stages)) {
    throw new ResearchWorkflowError(500, 'WORKFLOW_CORRUPT', 'Research workflow has an invalid structure.');
  }
  if (workflow.schemaVersion === RESEARCH_WORKFLOW_SCHEMA_VERSION) {
    return { workflow, migrated: false };
  }
  if (workflow.schemaVersion !== 1) {
    throw new ResearchWorkflowError(409, 'WORKFLOW_VERSION_UNSUPPORTED', 'Research workflow schema version is unsupported.', {
      schemaVersion: workflow.schemaVersion,
      expected: RESEARCH_WORKFLOW_SCHEMA_VERSION
    });
  }

  const migratedWorkflow = clone(workflow);
  migratedWorkflow.schemaVersion = RESEARCH_WORKFLOW_SCHEMA_VERSION;
  migratedWorkflow.skillBindings = normalizeSkillBindings(migratedWorkflow.skillBindings ?? {}, { stored: true });
  appendAudit(migratedWorkflow, 'workflow.migrated', {
    actor: 'system',
    details: { fromSchemaVersion: 1, toSchemaVersion: RESEARCH_WORKFLOW_SCHEMA_VERSION }
  });
  return { workflow: migratedWorkflow, migrated: true };
}

function validateStoredWorkflow(workflow, projectId) {
  if (!isPlainObject(workflow) || workflow.projectId !== projectId || !Array.isArray(workflow.stages)) {
    throw new ResearchWorkflowError(500, 'WORKFLOW_CORRUPT', 'Research workflow has an invalid structure.');
  }
  if (workflow.schemaVersion !== RESEARCH_WORKFLOW_SCHEMA_VERSION || workflow.stages.length !== RESEARCH_WORKFLOW_STAGES.length) {
    throw new ResearchWorkflowError(409, 'WORKFLOW_VERSION_UNSUPPORTED', 'Research workflow schema version is unsupported.', {
      schemaVersion: workflow.schemaVersion,
      expected: RESEARCH_WORKFLOW_SCHEMA_VERSION
    });
  }
  if (!WORKFLOW_STATUSES.has(workflow.status) || !STAGE_IDS.has(workflow.currentStage)) {
    throw new ResearchWorkflowError(500, 'WORKFLOW_CORRUPT', 'Research workflow has invalid status or current stage.');
  }
  normalizeSkillBindings(workflow.skillBindings, { stored: true, requireNormalized: true });
  for (const definition of RESEARCH_WORKFLOW_STAGES) {
    const stage = workflow.stages.find((item) => item.id === definition.id);
    if (!stage || !STAGE_STATUSES.has(stage.status) || !isPlainObject(stage.data)) {
      throw new ResearchWorkflowError(500, 'WORKFLOW_CORRUPT', `Research workflow stage ${definition.id} is invalid.`);
    }
  }
}

async function writeWorkflowFile(projectRoot, workflow) {
  const directory = path.dirname(workflowPath(projectRoot));
  await fs.mkdir(directory, { recursive: true });
  const target = workflowPath(projectRoot);
  const temporary = path.join(directory, `.research-workflow.${process.pid}.${makeId()}.tmp`);
  await fs.writeFile(temporary, `${JSON.stringify(workflow, null, 2)}\n`, 'utf8');
  try {
    await fs.rename(temporary, target);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function appendAudit(workflow, type, details) {
  workflow.audit = Array.isArray(workflow.audit) ? workflow.audit : [];
  workflow.audit.push(auditEvent(type, details));
  workflow.updatedAt = now();
  workflow.version = (Number(workflow.version) || 0) + 1;
}

function valueIsPresent(value) {
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (isPlainObject(value)) return Object.keys(value).length > 0;
  return value !== undefined && value !== null && value !== false;
}

export function getStageReadiness(workflow, stageId = workflow?.currentStage) {
  assertStageId(stageId);
  const stage = workflow?.stages?.find((item) => item.id === stageId);
  if (!stage) {
    return { ready: false, reason: 'Stage is missing from workflow.', missing: ['stage'] };
  }
  const aliases = STAGE_VALUE_ALIASES[stageId] || [];
  const hasValue = aliases.some((key) => valueIsPresent(stage.data?.[key]));
  if (hasValue) return { ready: true, missing: [] };
  return {
    ready: false,
    reason: `Stage requires ${stageDefinition(stageId).requirement}.`,
    missing: [stageDefinition(stageId).requirement]
  };
}

function mergeData(previous, patch) {
  const next = { ...previous };
  for (const [key, value] of Object.entries(patch)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) continue;
    if (isPlainObject(value) && isPlainObject(next[key])) {
      next[key] = mergeData(next[key], value);
    } else {
      next[key] = clone(value);
    }
  }
  return next;
}

function requireCurrentStage(workflow, stageId) {
  if (stageId && stageId !== workflow.currentStage) {
    throw new ResearchWorkflowError(409, 'STAGE_GATE', 'Only the current stage can be changed or approved.', {
      currentStage: workflow.currentStage,
      requestedStage: stageId
    });
  }
  return workflow.stages.find((stage) => stage.id === workflow.currentStage);
}

export class ResearchWorkflowError extends Error {
  constructor(statusCode, code, message, details) {
    super(message);
    this.name = 'ResearchWorkflowError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export async function getResearchWorkflow(projectId) {
  const projectRoot = await resolveProjectRoot(projectId);
  return readWorkflowFile(projectRoot, projectId);
}

export async function getResearchSkillBindings(projectId) {
  const workflow = await getResearchWorkflow(projectId);
  return clone(workflow.skillBindings);
}

export async function updateResearchSkillBindings(projectId, {
  bindings,
  actor,
  note
} = {}) {
  const projectRoot = await resolveProjectRoot(projectId);
  const workflow = await readWorkflowFile(projectRoot, projectId);
  if (workflow.status === 'completed') {
    throw new ResearchWorkflowError(409, 'WORKFLOW_COMPLETED', 'Completed research workflows cannot be changed.');
  }
  const normalizedBindings = normalizeSkillBindings(bindings);
  const sanitizedNote = sanitizeNote(note);
  workflow.skillBindings = normalizedBindings;
  appendAudit(workflow, 'workflow.skills.updated', {
    actor,
    note: sanitizedNote,
    details: {
      stages: Object.keys(normalizedBindings),
      skillCount: Object.values(normalizedBindings).reduce((count, skillNames) => count + skillNames.length, 0)
    }
  });
  await writeWorkflowFile(projectRoot, workflow);
  return workflow;
}

export async function initializeResearchWorkflow(projectId, { data = {}, actor } = {}) {
  const projectRoot = await resolveProjectRoot(projectId);
  const initialData = assertData(data);
  try {
    await fs.access(workflowPath(projectRoot));
    throw new ResearchWorkflowError(409, 'WORKFLOW_EXISTS', 'Research workflow already exists.');
  } catch (error) {
    if (error instanceof ResearchWorkflowError) throw error;
    if (error?.code !== 'ENOENT') throw error;
  }
  const workflow = createWorkflowDocument(projectId, { data: initialData, actor });
  await writeWorkflowFile(projectRoot, workflow);
  return workflow;
}

export async function updateResearchWorkflow(projectId, {
  stageId,
  data,
  patch,
  status,
  actor,
  note
} = {}) {
  const projectRoot = await resolveProjectRoot(projectId);
  const workflow = await readWorkflowFile(projectRoot, projectId);
  if (workflow.status === 'completed') {
    throw new ResearchWorkflowError(409, 'WORKFLOW_COMPLETED', 'Completed research workflows cannot be changed.');
  }
  const currentStage = requireCurrentStage(workflow, stageId);
  const nextData = data !== undefined ? data : patch;
  if (nextData === undefined) {
    throw new ResearchWorkflowError(400, 'MISSING_DATA', 'Provide data or patch to update the current stage.');
  }
  const patchData = assertData(nextData, 'data');
  const sanitizedNote = sanitizeNote(note);
  currentStage.data = mergeData(currentStage.data, patchData);
  currentStage.updatedAt = now();
  if (currentStage.status === 'rejected') {
    currentStage.status = 'in_progress';
    currentStage.rejection = null;
    workflow.status = 'in_progress';
  }
  if (status !== undefined) {
    if (!['in_progress', 'awaiting_approval'].includes(status)) {
      throw new ResearchWorkflowError(400, 'INVALID_STAGE_STATUS', 'Updates may only set in_progress or awaiting_approval.');
    }
    if (status === 'awaiting_approval') {
      const readiness = getStageReadiness(workflow, currentStage.id);
      if (!readiness.ready) {
        throw new ResearchWorkflowError(409, 'STAGE_NOT_READY', 'Stage is not ready for approval.', readiness);
      }
    }
    currentStage.status = status;
  }
  appendAudit(workflow, 'stage.updated', {
    stageId: currentStage.id,
    actor,
    note: sanitizedNote,
    details: { fields: Object.keys(patchData), status: currentStage.status }
  });
  await writeWorkflowFile(projectRoot, workflow);
  return workflow;
}

export async function approveResearchWorkflow(projectId, {
  stageId,
  decision = 'approve',
  actor,
  note
} = {}) {
  const projectRoot = await resolveProjectRoot(projectId);
  const workflow = await readWorkflowFile(projectRoot, projectId);
  if (workflow.status === 'completed') {
    throw new ResearchWorkflowError(409, 'WORKFLOW_COMPLETED', 'Completed research workflows cannot be approved.');
  }
  const currentStage = requireCurrentStage(workflow, stageId);
  if (currentStage.status === 'approved') {
    throw new ResearchWorkflowError(409, 'STAGE_ALREADY_APPROVED', 'Current stage has already been approved.');
  }
  if (!['approve', 'reject', 'skip'].includes(decision)) {
    throw new ResearchWorkflowError(400, 'INVALID_DECISION', 'decision must be approve, reject, or skip.');
  }
  const sanitizedNote = sanitizeNote(note);
  if (decision === 'reject') {
    currentStage.status = 'rejected';
    currentStage.rejection = { at: now(), by: sanitizeActor(actor), note: sanitizedNote || null };
    workflow.status = 'blocked';
    appendAudit(workflow, 'stage.rejected', {
      stageId: currentStage.id,
      actor,
      note: sanitizedNote,
      details: { status: workflow.status }
    });
    await writeWorkflowFile(projectRoot, workflow);
    return workflow;
  }

  if (decision === 'skip') {
    if (currentStage.id !== 'replication') {
      throw new ResearchWorkflowError(409, 'STAGE_NOT_OPTIONAL', 'Only the replication stage can be skipped.');
    }
    if (!sanitizedNote) {
      throw new ResearchWorkflowError(400, 'SKIP_REASON_REQUIRED', 'A note is required when skipping replication.');
    }
    const timestamp = now();
    currentStage.status = 'skipped';
    currentStage.skippedAt = timestamp;
    currentStage.skippedBy = sanitizeActor(actor);
    currentStage.skipReason = sanitizedNote;
    currentStage.updatedAt = timestamp;
    const currentIndex = RESEARCH_WORKFLOW_STAGES.findIndex((stage) => stage.id === currentStage.id);
    const nextDefinition = RESEARCH_WORKFLOW_STAGES[currentIndex + 1];
    const nextStage = workflow.stages.find((stage) => stage.id === nextDefinition.id);
    workflow.currentStage = nextDefinition.id;
    nextStage.status = 'in_progress';
    nextStage.startedAt = timestamp;
    nextStage.updatedAt = timestamp;
    workflow.status = 'in_progress';
    appendAudit(workflow, 'stage.skipped', {
      stageId: currentStage.id,
      actor,
      note: sanitizedNote,
      details: { nextStage: nextDefinition.id, optional: true }
    });
    await writeWorkflowFile(projectRoot, workflow);
    return workflow;
  }

  const readiness = getStageReadiness(workflow, currentStage.id);
  if (!readiness.ready) {
    throw new ResearchWorkflowError(409, 'STAGE_NOT_READY', 'Stage is not ready for approval.', readiness);
  }
  const timestamp = now();
  currentStage.status = 'approved';
  currentStage.approvedAt = timestamp;
  currentStage.approvedBy = sanitizeActor(actor);
  currentStage.updatedAt = timestamp;
  currentStage.rejection = null;
  const currentIndex = RESEARCH_WORKFLOW_STAGES.findIndex((stage) => stage.id === currentStage.id);
  const nextDefinition = RESEARCH_WORKFLOW_STAGES[currentIndex + 1];
  if (nextDefinition) {
    workflow.currentStage = nextDefinition.id;
    const nextStage = workflow.stages.find((stage) => stage.id === nextDefinition.id);
    nextStage.status = 'in_progress';
    nextStage.startedAt = timestamp;
    nextStage.updatedAt = timestamp;
    workflow.status = 'in_progress';
  } else {
    workflow.status = 'completed';
  }
  appendAudit(workflow, 'stage.approved', {
    stageId: currentStage.id,
    actor,
    note: sanitizedNote,
    details: { nextStage: nextDefinition?.id || null, workflowStatus: workflow.status }
  });
  await writeWorkflowFile(projectRoot, workflow);
  return workflow;
}

export async function resetResearchWorkflow(projectId, { actor, note } = {}) {
  const projectRoot = await resolveProjectRoot(projectId);
  const previous = await readWorkflowFile(projectRoot, projectId);
  const sanitizedNote = sanitizeNote(note);
  const workflow = createWorkflowDocument(projectId, {
    id: previous.id,
    createdAt: previous.createdAt,
    actor
  });
  workflow.version = (Number(previous.version) || 1) + 1;
  workflow.audit = [
    ...(Array.isArray(previous.audit) ? previous.audit : []),
    auditEvent('workflow.reset', {
      actor,
      note: sanitizedNote,
      details: { previousVersion: previous.version }
    })
  ];
  workflow.updatedAt = now();
  await writeWorkflowFile(projectRoot, workflow);
  return workflow;
}

// Short aliases keep the service convenient for callers while the verbose names
// make the route contract self-documenting.
export const createResearchWorkflow = initializeResearchWorkflow;
export const readResearchWorkflow = getResearchWorkflow;
export const patchResearchWorkflow = updateResearchWorkflow;
