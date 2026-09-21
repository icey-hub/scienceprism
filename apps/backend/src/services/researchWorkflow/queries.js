import { getStageReadiness, RESEARCH_WORKFLOW_STAGES, stageDefinition } from './stageContracts.js';
import { clone } from './audit.js';
import { readWorkflowFile, resolveProjectRoot } from './repository.js';

export async function getResearchWorkflow(projectId) {
  return readWorkflowFile(await resolveProjectRoot(projectId), projectId);
}

export function getStageData(workflow, stageId) {
  return workflow?.stages?.find((stage) => stage.id === stageId)?.data || {};
}

export async function getResearchStageDetails(projectId, stageId) {
  const workflow = await getResearchWorkflow(projectId);
  const stage = workflow.stages.find((item) => item.id === stageId);
  if (!stage) return null;
  const readiness = getStageReadiness(workflow, stageId);
  return { workflowVersion: workflow.version, currentStage: workflow.currentStage, stage: clone(stage), definition: stageDefinition(stageId), readiness, pendingApproval: stage.id === workflow.currentStage && readiness.ready };
}

export async function getPendingResearchApprovals(projectId) {
  const workflow = await getResearchWorkflow(projectId);
  if (workflow.status === 'completed') return [];
  const stage = workflow.stages.find((item) => item.id === workflow.currentStage);
  if (!stage) return [];
  const readiness = getStageReadiness(workflow, stage.id);
  return readiness.ready || stage.status === 'awaiting_approval'
    ? [{ stageId: stage.id, label: stage.label, status: stage.status, readiness, workflowVersion: workflow.version }]
    : [];
}

export async function getResearchAuditTimeline(projectId, { stageId, limit = 100 } = {}) {
  const workflow = await getResearchWorkflow(projectId);
  const events = (workflow.audit || []).filter((event) => !stageId || event.stageId === stageId);
  return clone(events.slice(-Math.max(1, Math.min(500, Number(limit) || 100))));
}

export async function getResearchSkillBindings(projectId) {
  const workflow = await getResearchWorkflow(projectId);
  return clone(workflow.skillBindings || {});
}

export { RESEARCH_WORKFLOW_STAGES };

