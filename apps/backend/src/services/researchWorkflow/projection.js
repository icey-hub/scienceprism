import { getStageData } from './queries.js';
import { getStageReadiness, RESEARCH_WORKFLOW_STAGES } from './stageContracts.js';

export const UI_TO_STAGE = Object.freeze({ direction: 'direction', search: 'search', selection: 'selection', replication: 'replication', innovation: 'ideation', method: 'method', experiment: 'experiment', writing: 'writing' });
export const STAGE_TO_UI = Object.fromEntries(Object.entries(UI_TO_STAGE).map(([key, value]) => [value, key]));

function paperForUi(paper, selectionIds = new Set()) {
  const candidate = paper?.candidate || paper || {};
  const decision = paper?.decision || paper?.eligibility;
  const id = candidate.id || paper.id;
  return { id, title: candidate.title || paper.title || 'Untitled paper', venue: candidate.venue || paper.venue || '', year: candidate.year || paper.year || 0, authors: candidate.authors || paper.authors || [], abstract: candidate.abstract || paper.abstract || '', url: candidate.url || paper.url || '', ccf: candidate.venueLevel || paper.ccf || '', quality: paper.qualityScore ?? paper.quality ?? null, evidenceId: candidate.evidenceId || paper.evidenceId || null, source: candidate.source || paper.source || null, sourceCount: candidate.sourceCount || paper.sourceCount || 0, sourceRecords: candidate.sourceRecords || paper.sourceRecords || [], metadata: paper.metadata || null, selected: selectionIds.has(id), eligibility: decision === 'accept' || decision === 'pass' ? 'pass' : decision === 'reject' ? 'reject' : 'review', reason: paper.reasons?.join(' ') || paper.reason || '' };
}

function frontendStageState(stage, currentStage) {
  if (stage.status === 'approved' || stage.status === 'skipped') return 'complete';
  if (stage.status === 'rejected') return 'error';
  if (stage.id === currentStage) return 'active';
  const currentOrder = RESEARCH_WORKFLOW_STAGES.findIndex((item) => item.id === currentStage);
  return stage.order === currentOrder + 1 ? 'ready' : 'locked';
}

export function toFrontendWorkflow(workflow) {
  const direction = getStageData(workflow, 'direction');
  const search = getStageData(workflow, 'search');
  const selection = getStageData(workflow, 'selection');
  const replication = getStageData(workflow, 'replication');
  const ideation = getStageData(workflow, 'ideation');
  const method = getStageData(workflow, 'method');
  const experiment = getStageData(workflow, 'experiment');
  const writing = getStageData(workflow, 'writing');
  const selectedIds = new Set(selection.selectedPaperIds || selection.paperIds || []);
  const selectedDetails = new Map((selection.selectedPapers || []).map((paper) => [String(paper.id), paper]));
  const rawPapers = search.evaluations || search.results || search.papers || [];
  const papers = rawPapers.map((paper) => {
    const candidateId = String(paper?.candidate?.id || paper?.id || '');
    const selected = selectedDetails.get(candidateId);
    return selected ? paperForUi({ ...paper, candidate: { ...(paper.candidate || {}), ...selected } }, selectedIds) : paperForUi(paper, selectedIds);
  });
  const ideas = ideation.ideas || ideation.innovationPoints || [];
  const currentStage = STAGE_TO_UI[workflow.currentStage] || workflow.currentStage;
  return {
    id: workflow.id, projectId: workflow.projectId, version: workflow.version, status: workflow.status,
    activeStage: currentStage, currentStage,
    stages: workflow.stages.map((stage) => ({ id: STAGE_TO_UI[stage.id] || stage.id, state: frontendStageState(stage, workflow.currentStage), status: stage.status, updatedAt: stage.updatedAt, readiness: stage.id === workflow.currentStage ? getStageReadiness(workflow, stage.id) : undefined })),
    direction: { question: direction.researchQuestion || direction.topic || direction.question || '', keywords: direction.seedKeywords || direction.keywords || [], scope: direction.scope || '', notes: direction.notes || '' },
    search: { query: search.query || search.queries?.[0] || '', count: papers.length, lastRunAt: search.lastRunAt || null, sources: search.sources || [], policy: search.policy || null },
    papers,
    replication: replication.replication || replication.replicationPlan || replication,
    ideas: ideas.map((idea, index) => ({ id: idea.id || `idea-${index + 1}`, title: idea.title || idea.name || `候选创新点 ${index + 1}`, summary: idea.summary || idea.problem || idea.description || '', evidence: idea.evidence || idea.relatedPaperIds || [], selected: Boolean(idea.selected) })),
    ideaComparison: ideation.comparison || [],
    method: { title: method.title || method.name || '', hypothesis: method.hypothesis || method.description || '', baselines: method.baselines || [], ablations: method.ablations || [] },
    methodCandidates: method.methodProposals || [],
    experiment: {
      dataset: experiment.dataset || experiment.datasetId || experiment.datasetIds?.join(', ') || '',
      datasetVersion: experiment.datasetVersion || '',
      protocol: experiment.protocol || '',
      command: experiment.command || experiment.commands?.join('\n') || '',
      execution: experiment.execution,
      parameters: experiment.parameters,
      seed: experiment.seed,
      successCriteria: experiment.successCriteria || [],
      artifacts: experiment.artifacts || [],
      status: experiment.status || '待规划',
      metrics: experiment.metrics || []
    },
    writing: { ready: Boolean(writing.ready || writing.handoffAt), handoffAt: writing.handoffAt || null, briefPath: writing.briefPath || null, outline: writing.outline || writing.evidence?.outline || '', claims: writing.claims || [], evidence: writing.evidence || null },
    task: (workflow.stages.find((stage) => stage.id === workflow.currentStage)?.data || {}).task || null,
    sourceFailures: search.sourceFailures || [],
    policy: search.policy || selection.policy || null,
    audit: workflow.audit || [],
    pendingApprovals: getPendingApprovalProjection(workflow),
    updatedAt: workflow.updatedAt
  };
}

function getPendingApprovalProjection(workflow) {
  if (workflow.status === 'completed') return [];
  const stage = workflow.stages.find((item) => item.id === workflow.currentStage);
  if (!stage) return [];
  const readiness = getStageReadiness(workflow, stage.id);
  return readiness.ready || stage.status === 'awaiting_approval' ? [{ stageId: STAGE_TO_UI[stage.id] || stage.id, label: stage.label, status: stage.status, readiness, workflowVersion: workflow.version }] : [];
}
