import {
  getResearchWorkflow,
  getResearchStageDetails,
  getPendingResearchApprovals,
  getResearchAuditTimeline,
  getResearchSkillBindings
} from './queries.js';
import {
  initializeResearchWorkflow,
  updateResearchWorkflow,
  approveResearchWorkflow,
  rejectResearchWorkflow,
  skipResearchWorkflow,
  recoverResearchWorkflow,
  resetResearchWorkflow,
  updateResearchSkillBindings
} from './commands.js';
import { ResearchWorkflowError } from './errors.js';
import { getStageReadiness, RESEARCH_WORKFLOW_STAGES } from './stageContracts.js';
import { RESEARCH_WORKFLOW_FILE, LEGACY_RESEARCH_WORKFLOW_FILE, RESEARCH_WORKFLOW_SCHEMA_VERSION } from './repository.js';
import { toFrontendWorkflow } from './projection.js';

export {
  ResearchWorkflowError,
  RESEARCH_WORKFLOW_FILE,
  LEGACY_RESEARCH_WORKFLOW_FILE,
  RESEARCH_WORKFLOW_SCHEMA_VERSION,
  RESEARCH_WORKFLOW_STAGES,
  getStageReadiness,
  getResearchWorkflow,
  getResearchStageDetails,
  getPendingResearchApprovals,
  getResearchAuditTimeline,
  getResearchSkillBindings,
  initializeResearchWorkflow,
  updateResearchWorkflow,
  approveResearchWorkflow,
  rejectResearchWorkflow,
  skipResearchWorkflow,
  recoverResearchWorkflow,
  resetResearchWorkflow,
  updateResearchSkillBindings,
  toFrontendWorkflow
};

export const createResearchWorkflow = initializeResearchWorkflow;
export const readResearchWorkflow = getResearchWorkflow;
export const patchResearchWorkflow = updateResearchWorkflow;
