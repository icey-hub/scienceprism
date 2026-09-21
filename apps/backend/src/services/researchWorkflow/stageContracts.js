import { ResearchWorkflowError } from './errors.js';

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

export const STAGE_STATUSES = new Set([
  'pending',
  'in_progress',
  'awaiting_approval',
  'approved',
  'rejected',
  'skipped'
]);

export const WORKFLOW_STATUSES = new Set(['in_progress', 'blocked', 'completed']);
export const STAGE_IDS = new Set(RESEARCH_WORKFLOW_STAGES.map((stage) => stage.id));

export const STAGE_VALUE_ALIASES = Object.freeze({
  direction: ['topic', 'researchQuestion', 'description', 'seedKeywords', 'keywords'],
  search: ['queries', 'searchQueries', 'papers', 'results'],
  selection: ['selectedPaperIds', 'selectedPapers', 'papers'],
  replication: ['replication', 'replicationPlan', 'reproduction', 'runs', 'results'],
  ideation: ['innovationPoints', 'ideas', 'candidates'],
  method: ['method', 'methodPlan', 'plan', 'approach'],
  experiment: ['experiment', 'experiments', 'runs', 'results', 'experimentResults', 'dataset', 'command', 'protocol'],
  writing: ['writing', 'outline', 'draft', 'manuscript']
});

function nonEmptyText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function nonEmptyArray(value) {
  return Array.isArray(value) && value.length > 0;
}

function nonEmptyObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0;
}

export const STAGE_CONTRACTS = Object.freeze({
  direction: {
    required: ['researchQuestion'],
    check: (data) => nonEmptyText(data.researchQuestion || data.topic || data.question)
  },
  search: {
    required: ['queries'],
    check: (data) => nonEmptyArray(data.queries || data.searchQueries) || nonEmptyArray(data.papers || data.results)
  },
  selection: {
    required: ['selectedPaperIds'],
    check: (data) => nonEmptyArray(data.selectedPaperIds || data.paperIds) || nonEmptyArray(data.selectedPapers)
  },
  replication: {
    required: ['replication'],
    check: (data) => nonEmptyObject(data.replication || data.replicationPlan || data.reproduction) || nonEmptyArray(data.runs || data.results)
  },
  ideation: {
    required: ['ideas'],
    check: (data) => nonEmptyArray(data.ideas || data.innovationPoints || data.candidates)
  },
  method: {
    required: ['method'],
    check: nonEmptyObject
  },
  experiment: {
    required: ['dataset', 'command'],
    check: (data) => (nonEmptyText(data.dataset) || nonEmptyText(data.datasetId) || nonEmptyArray(data.datasetIds)) && (nonEmptyText(data.command) || nonEmptyText(data.protocol) || nonEmptyArray(data.commands) || nonEmptyObject(data.experiment))
  },
  writing: {
    required: ['writing'],
    check: (data) => data.ready === true || nonEmptyObject(data.writing) || nonEmptyObject(data.evidence) || nonEmptyText(data.outline) || nonEmptyText(data.draft) || nonEmptyText(data.manuscript)
  }
});

function valueIsPresent(value) {
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (value !== null && typeof value === 'object') return Object.keys(value).length > 0;
  return value !== undefined && value !== null && value !== false;
}

export function assertStageId(stageId) {
  if (typeof stageId !== 'string' || !STAGE_IDS.has(stageId)) {
    throw new ResearchWorkflowError(400, 'INVALID_STAGE', 'Unknown research workflow stage.', {
      stageId,
      allowedStages: [...STAGE_IDS]
    });
  }
}

export function stageDefinition(stageId) {
  assertStageId(stageId);
  return RESEARCH_WORKFLOW_STAGES.find((stage) => stage.id === stageId);
}

export function getStageReadiness(workflow, stageId = workflow?.currentStage) {
  assertStageId(stageId);
  const stage = workflow?.stages?.find((item) => item.id === stageId);
  if (!stage) return { ready: false, reason: 'Stage is missing from workflow.', missing: ['stage'] };
  const definition = stageDefinition(stageId);
  const contract = STAGE_CONTRACTS[stageId];
  const task = stage.data?.task;
  if (task?.status === 'failed' || task?.validation?.ok === false) {
    return { ready: false, reason: 'The latest stage task failed validation and must be retried or corrected.', missing: ['task.validation'] };
  }
  const ready = contract ? contract.check(stage.data || {}) : (STAGE_VALUE_ALIASES[stageId] || []).some((key) => valueIsPresent(stage.data?.[key]));
  return ready
    ? { ready: true, missing: [] }
    : { ready: false, reason: `Stage requires ${definition.requirement}.`, missing: contract?.required || [definition.requirement] };
}
