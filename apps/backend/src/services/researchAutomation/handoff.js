import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { RESEARCH_WORKFLOW_STAGES } from '../researchWorkflow/stageContracts.js';
import { ResearchWorkflowError } from '../researchWorkflow/errors.js';

const stages = RESEARCH_WORKFLOW_STAGES.map(value => value.id);
const fail = (code, message, status = 409) => new ResearchWorkflowError(status, code, message);
const identity = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && value === value.trim()
  && value.isWellFormed() && !/[\x00-\x1f\x7f]/.test(value);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
export function sourceHash(data) {
  const active = new Set(); let nodes = 0;
  const stable = (value, depth = 0) => {
    if (++nodes > 100000 || depth > 64) throw fail('AUTOMATION_HANDOFF_INPUT_INVALID', 'The source stage data exceeds its JSON structural limit.');
    if (value === null || typeof value === 'boolean' || typeof value === 'string' && value.isWellFormed() || typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
    if (!Array.isArray(value) && !plain(value) || active.has(value)) throw fail('AUTOMATION_HANDOFF_INPUT_INVALID', 'The source stage data must be complete, finite JSON.');
    active.add(value);
    let encoded;
    if (Array.isArray(value)) encoded = `[${value.map(item => stable(item, depth + 1)).join(',')}]`;
    else encoded = `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key], depth + 1)}`).join(',')}}`;
    active.delete(value); return encoded;
  };
  // Hash all saved data, including task approval/version fields. Never publish
  // selected prose or exclude mutable source fields merely to make resume pass.
  return createHash('sha256').update(stable(data)).digest('hex');
}
function references(values, field) {
  if (!Array.isArray(values) || values.length > 1000 || values.some(value => !identity(value))) throw fail('AUTOMATION_HANDOFF_REFERENCE_INVALID', `The ${field} source identities are invalid.`);
  return [...new Set(values)].sort();
}
function optionalReference(value, field) {
  if (value === undefined || value === null) return [];
  return references([value], field);
}
function context({ projectId, workflow, session, stage, role } = {}) {
  if (!identity(projectId) || !identity(role) || !stages.includes(stage) || !plain(workflow) || !plain(session)
    || !identity(workflow.id) || workflow.projectId !== projectId || !Number.isSafeInteger(workflow.version) || workflow.version < 1
    || !identity(session.id) || session.workflowId !== workflow.id || session.projectId !== undefined && session.projectId !== projectId
    || !identity(session.coordinatorRunId)) throw fail('AUTOMATION_HANDOFF_CONTEXT_INVALID', 'A bound project, workflow, session, role and actual coordinator Run are required.', 400);
  if (!Array.isArray(workflow.stages) || workflow.stages.length !== stages.length || stages.some(id => workflow.stages.filter(value => value?.id === id).length !== 1)
    || !Array.isArray(session.steps) || session.steps.some(step => !plain(step) || !stages.includes(step.stage))
    || new Set(session.steps.map(step => step.stage)).size !== session.steps.length) throw fail('AUTOMATION_HANDOFF_CONTEXT_INVALID', 'The workflow stages and session source steps must be unambiguous.', 400);
  return { projectId, workflow, session, stage, role };
}

/** A reference-only transfer between specialists of the same real coordinator.
 * This record provides provenance; it never grants capabilities or approvals. */
export function buildAutomationHandoff(input) {
  const { projectId, workflow, session, stage, role } = context(input);
  const inputArtifacts = [];
  for (const sourceStage of stages.slice(0, stages.indexOf(stage))) {
    const source = workflow.stages.find(value => value.id === sourceStage), data = source.data;
    if (!plain(data)) throw fail('AUTOMATION_HANDOFF_INPUT_INVALID', 'Saved source stage data must be a JSON object.');
    if (!Object.keys(data).length) continue;
    const step = session.steps.find(value => value.stage === sourceStage);
    const producerRunIds = references([...(step?.runIds === undefined ? [] : references(step.runIds, 'producer Run')),
      ...optionalReference(data.task?.harness?.runId, 'producer Run')], 'producer Run');
    const searchSessionIds = references([...(data.searchSessionIds === undefined ? [] : references(data.searchSessionIds, 'search session')),
      ...(data.task?.output?.searchSessionIds === undefined ? [] : references(data.task.output.searchSessionIds, 'search session'))], 'search session');
    const experimentIds = references([...optionalReference(step?.experimentRunId, 'experiment Run'),
      ...optionalReference(data.experimentRunId, 'experiment Run'),
      ...(['replication', 'experiment'].includes(sourceStage) ? optionalReference(data.automaticResult?.id, 'experiment Run') : [])], 'experiment Run');
    if (experimentIds.length > 1) throw fail('AUTOMATION_HANDOFF_REFERENCE_CONFLICT', 'The saved source stage refers to different Experiment Runs.');
    inputArtifacts.push({ workflowId: workflow.id, workflowVersion: workflow.version, stage: sourceStage,
      dataSha256: sourceHash(data), producerRunIds, searchSessionIds, experimentRunId: experimentIds[0] || null });
  }
  return { schemaVersion: 1, projectId, sessionId: session.id, workflowId: workflow.id, workflowVersion: workflow.version,
    stage, role, parentRunId: session.coordinatorRunId, inputArtifacts };
}

export function assertAutomationHandoff(handoff, input) {
  const current = buildAutomationHandoff(input);
  const fields = ['schemaVersion', 'projectId', 'sessionId', 'workflowId', 'workflowVersion', 'stage', 'role', 'parentRunId', 'inputArtifacts'];
  if (!plain(handoff) || Object.keys(handoff).length !== fields.length || Object.keys(handoff).some(key => !fields.includes(key))
    || handoff.schemaVersion !== 1 || !Number.isSafeInteger(handoff.workflowVersion) || handoff.workflowVersion < 1
    || handoff.workflowVersion > current.workflowVersion || !Array.isArray(handoff.inputArtifacts)) {
    throw fail('AUTOMATION_HANDOFF_INVALID', 'The saved automation handoff has an unsupported shape or workflow version.');
  }
  for (const key of ['projectId', 'sessionId', 'workflowId', 'stage', 'role', 'parentRunId']) {
    if (handoff[key] !== current[key]) throw fail('AUTOMATION_HANDOFF_OWNER_CHANGED', 'The handoff does not belong to this coordinator, specialist and workflow stage.');
  }
  // Later stage writes advance the workflow version. The captured source data
  // and reference identities still have to match exactly at their old version.
  const expectedArtifacts = current.inputArtifacts.map(artifact => ({ ...artifact, workflowVersion: handoff.workflowVersion }));
  if (!isDeepStrictEqual(handoff.inputArtifacts, expectedArtifacts)) throw fail('AUTOMATION_HANDOFF_INPUT_CHANGED', 'Research handoff source data or producer identities changed; rebuild from the current workflow.');
  return handoff;
}
