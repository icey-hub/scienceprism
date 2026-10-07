import { ExperimentRunnerError } from './errors.js';
import { getResearchWorkflow } from '../researchWorkflow/index.js';
import { isDeepStrictEqual } from 'node:util';
import { withWorkflowLock } from '../researchWorkflow/repository.js';

export function isReplicationRequest(input) {
  if (!plainObject(input)) throw new ExperimentRunnerError(400, 'INVALID_RUN_REQUEST', 'Experiment Run input must be an object.');
  const containers = [input, input.plan, input.experiment].filter(plainObject);
  if ((input.sourceStage !== undefined && !['experiment', 'replication'].includes(input.sourceStage))
    || containers.some((value) => Object.hasOwn(value, 'replication'))
    || containers.slice(1).some((value) => Object.hasOwn(value, 'sourceStage'))) {
    throw new ExperimentRunnerError(400, 'REPLICATION_SOURCE_REQUIRED', 'Replication provenance is server-owned. Use sourceStage=replication and the current expectedVersion.');
  }
  if (input.sourceStage !== 'replication') return false;
  const requestFields = new Set(['sourceStage', 'expectedVersion', 'plan', 'actor']);
  const executionFields = new Set(['execution', 'parameters', 'seed', 'resources', 'artifacts']);
  if (Object.keys(input).some((key) => !requestFields.has(key))
    || !plainObject(input.plan)
    || Object.keys(input.plan).some((key) => !executionFields.has(key))) {
    throw new ExperimentRunnerError(400, 'REPLICATION_PLAN_OVERRIDE', 'A replication Run accepts only execution, parameters, seed, resources, and artifacts; its preparation comes from the saved workflow.');
  }
  return true;
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function clone(value) {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

export function readReplicationContextFromWorkflow(projectId, workflow, { expectedVersion } = {}) {
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    throw new ExperimentRunnerError(400, 'REPLICATION_VERSION_REQUIRED', 'expectedVersion must be the current research workflow version.');
  }
  if (workflow.version !== expectedVersion) {
    throw new ExperimentRunnerError(409, 'REPLICATION_PLAN_STALE', 'The saved replication plan changed. Read the current workflow and retry.', {
      expectedVersion,
      actualVersion: workflow.version
    });
  }
  const stage = workflow.stages?.find((item) => item.id === 'replication');
  if (!stage) throw new ExperimentRunnerError(409, 'REPLICATION_STAGE_UNAVAILABLE', 'The research workflow has no replication stage.');
  if (stage.status === 'skipped') throw new ExperimentRunnerError(409, 'REPLICATION_STAGE_SKIPPED', 'A skipped replication stage cannot create an Experiment Run.');
  if (stage.status === 'rejected') throw new ExperimentRunnerError(409, 'REPLICATION_PLAN_REJECTED', 'Revise and approve the replication plan before creating an Experiment Run.');
  if (stage.status !== 'approved') throw new ExperimentRunnerError(409, 'REPLICATION_PLAN_NOT_APPROVED', 'Approve the saved replication plan before creating an Experiment Run.');
  const stageData = plainObject(stage.data) ? stage.data : {};
  const plan = plainObject(stageData.replication) ? stageData.replication : stageData;
  for (const field of ['repository', 'environment', 'dataset', 'datasetVersion', 'note']) {
    if (!text(plan[field])) throw new ExperimentRunnerError(409, 'REPLICATION_PLAN_INCOMPLETE', `The saved replication plan is missing ${field}.`);
  }
  return {
    sourceStage: 'replication',
    projectId,
    workflowId: workflow.id,
    workflowVersion: workflow.version,
    stageStatus: stage.status,
    plan: clone(plan)
  };
}

export async function readReplicationContext(projectId, { expectedVersion } = {}) {
  return withWorkflowLock(projectId, async () => readReplicationContextFromWorkflow(projectId, await getResearchWorkflow(projectId), { expectedVersion }));
}

export function assertReplicationPreparationUnchangedFromWorkflow(projectId, workflow, savedContext) {
  const current = readReplicationContextFromWorkflow(projectId, workflow, { expectedVersion: workflow.version });
  const samePreparation = current.workflowId === savedContext.workflowId
    && current.stageStatus === savedContext.stageStatus
    && isDeepStrictEqual(current.plan, savedContext.plan);
  if (!samePreparation) {
    throw new ExperimentRunnerError(409, 'REPLICATION_PLAN_CHANGED', 'The approved replication preparation changed after this Run was created. Create a new Run from the current approved preparation.', {
      runWorkflowVersion: savedContext.workflowVersion,
      currentWorkflowVersion: workflow.version
    });
  }
  return current;
}

export async function assertReplicationPreparationUnchanged(projectId, savedContext) {
  return withWorkflowLock(projectId, async () => assertReplicationPreparationUnchangedFromWorkflow(projectId, await getResearchWorkflow(projectId), savedContext));
}
