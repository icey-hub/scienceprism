import { ResearchWorkflowError } from './errors.js';
import { appendAudit, clone } from './audit.js';
import { RESEARCH_WORKFLOW_STAGES, STAGE_IDS, STAGE_STATUSES, WORKFLOW_STATUSES } from './stageContracts.js';
import { normalizeSkillBindings } from './skillBindings.js';

export const RESEARCH_WORKFLOW_SCHEMA_VERSION = 3;

export function migrateStoredWorkflow(input, projectId) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || input.projectId !== projectId || !Array.isArray(input.stages)) {
    throw new ResearchWorkflowError(500, 'WORKFLOW_CORRUPT', 'Research workflow has an invalid structure.');
  }
  const workflow = clone(input);
  let migrated = false;
  if (workflow.schemaVersion === 1) {
    workflow.schemaVersion = 2;
    workflow.skillBindings = normalizeSkillBindings(workflow.skillBindings ?? {}, { stored: true });
    appendAudit(workflow, 'workflow.migrated', { actor: 'system', details: { fromSchemaVersion: 1, toSchemaVersion: 2 } });
    migrated = true;
  }
  if (workflow.schemaVersion === 2) {
    workflow.schemaVersion = RESEARCH_WORKFLOW_SCHEMA_VERSION;
    workflow.commandReceipts = workflow.commandReceipts && typeof workflow.commandReceipts === 'object' ? workflow.commandReceipts : {};
    appendAudit(workflow, 'workflow.migrated', { actor: 'system', details: { fromSchemaVersion: 2, toSchemaVersion: RESEARCH_WORKFLOW_SCHEMA_VERSION } });
    migrated = true;
  }
  if (workflow.schemaVersion !== RESEARCH_WORKFLOW_SCHEMA_VERSION) {
    throw new ResearchWorkflowError(409, 'WORKFLOW_VERSION_UNSUPPORTED', 'Research workflow schema version is unsupported.', {
      schemaVersion: workflow.schemaVersion,
      expected: RESEARCH_WORKFLOW_SCHEMA_VERSION
    });
  }
  return { workflow, migrated };
}

export function validateStoredWorkflow(workflow, projectId) {
  if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow) || workflow.projectId !== projectId || !Array.isArray(workflow.stages)) {
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
  normalizeSkillBindings(workflow.skillBindings ?? {}, { stored: true, requireNormalized: true });
  if (!workflow.commandReceipts || typeof workflow.commandReceipts !== 'object' || Array.isArray(workflow.commandReceipts)) {
    throw new ResearchWorkflowError(500, 'WORKFLOW_CORRUPT', 'Research workflow command receipts are invalid.');
  }
  for (const definition of RESEARCH_WORKFLOW_STAGES) {
    const stage = workflow.stages.find((item) => item.id === definition.id);
    if (!stage || !STAGE_STATUSES.has(stage.status) || !stage.data || typeof stage.data !== 'object' || Array.isArray(stage.data)) {
      throw new ResearchWorkflowError(500, 'WORKFLOW_CORRUPT', `Research workflow stage ${definition.id} is invalid.`);
    }
  }
  return workflow;
}

