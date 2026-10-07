import type { ExperimentRun, EvidenceRecord } from '../../api/client';
import type { WritingDelegation } from './stages/WritingStage';
import type {
  ExperimentPlan,
  FilterPolicy,
  InnovationIdea,
  MethodDraft,
  PaperCandidate,
  ReplicationPlan,
  ReplicationResultSummary,
  ResearchDirection,
  ResearchStageId,
  ResearchStageStatus,
  SearchRunSummary,
  WritingEvidenceSummary
} from './researchStages';

export type StageState = 'locked' | 'ready' | 'active' | 'complete' | 'error';

export interface StageRecord {
  id: ResearchStageId;
  state: StageState;
  status?: string;
}

export interface UiWorkflow {
  projectName?: string;
  version?: number;
  status?: string;
  activeStage?: ResearchStageId;
  currentStage?: ResearchStageId;
  stages?: StageRecord[];
  humanInstructions?: Partial<Record<ResearchStageId, string>>;
  direction?: Partial<ResearchDirection>;
  search?: Partial<Omit<SearchRunSummary, 'candidateCount' | 'selectedCount'>> & { count?: number; policy?: Partial<FilterPolicy> };
  replication?: Partial<ReplicationPlan> & { skipped?: boolean };
  papers?: PaperCandidate[];
  ideas?: (InnovationIdea & { selected?: boolean })[];
  ideaHumanDirection?: string;
  ideaCaveats?: string[];
  ideaComparison?: { ideaId: string; strengths: string[]; weaknesses: string[]; differentiator: string }[];
  method?: Partial<MethodDraft>;
  methodCandidates?: { id: string; name: string; description: string; baselines: string[]; metrics: string[]; implementationRisks: string[] }[];
  experiment?: Partial<ExperimentPlan> & { command?: string };
  writing?: Partial<WritingEvidenceSummary> & { handoffAt?: string; briefPath?: string; evidence?: { outline?: string; claims?: unknown[] } };
  task?: {
    id?: string;
    stage?: string;
    status?: string;
    validation?: { ok?: boolean; errors?: { message?: string }[]; warnings?: string[] };
    harness?: { runId?: string | null; adapter?: string | null; status?: string } | null;
    delegation?: WritingDelegation | null;
    humanDecision?: { decision?: string; actor?: string } | null;
    error?: { message?: string } | null;
  };
  sourceFailures?: { source?: string; message?: string }[];
}

export interface WorkflowEnvelope {
  ok?: boolean;
  workflow?: UiWorkflow;
  data?: UiWorkflow;
  error?: string | { message?: string };
}

export const DEFAULT_POLICY: FilterPolicy = {
  venueLevel: 'CCF-A', publicationType: 'Any', yearFrom: '2022', yearTo: '2026', peerReviewed: true, requireCode: false
};

export const EMPTY_WORKFLOW: UiWorkflow = {
  activeStage: 'direction', direction: { question: '', keywords: [], scope: '', notes: '' }, search: { query: '', count: 0 }, papers: [],
  replication: { repository: '', environment: '', dataset: '', note: '' }, ideas: [], method: { title: '', hypothesis: '', baselines: [], ablations: [] },
  experiment: { dataset: '', datasetVersion: '', protocol: '', command: '', status: '待规划', metrics: [] }, writing: { ready: false, outline: '' }
};

export function mergeWorkflow(input?: UiWorkflow | WorkflowEnvelope): UiWorkflow {
  const raw = input as WorkflowEnvelope | undefined;
  const value = (raw?.workflow || raw?.data || input || {}) as UiWorkflow;
  return {
    ...EMPTY_WORKFLOW,
    ...value,
    direction: { ...EMPTY_WORKFLOW.direction, ...value.direction },
    search: { ...EMPTY_WORKFLOW.search, ...value.search },
    replication: { ...EMPTY_WORKFLOW.replication, ...value.replication },
    method: { ...EMPTY_WORKFLOW.method, ...value.method },
    experiment: { ...EMPTY_WORKFLOW.experiment, ...value.experiment },
    writing: { ...EMPTY_WORKFLOW.writing, ...value.writing },
    papers: value.papers || [],
    ideas: value.ideas || []
  };
}

export function stageStatuses(workflow: UiWorkflow): Partial<Record<ResearchStageId, ResearchStageStatus>> {
  return Object.fromEntries((workflow.stages || []).map((item) => [item.id, item.state])) as Partial<Record<ResearchStageId, ResearchStageStatus>>;
}

export function selectedPaperIds(workflow: UiWorkflow): string[] {
  return (workflow.papers || []).filter((paper) => paper.selected).map((paper) => paper.id);
}

export function selectedIdeaIds(workflow: UiWorkflow): string[] {
  return (workflow.ideas || []).filter((idea) => idea.selected).map((idea) => idea.id);
}

function evidenceStatus(entry: EvidenceRecord | undefined, fallback: string) {
  return entry?.verificationStatus || fallback;
}

export function replicationResultSummary(run?: ExperimentRun | null, evidenceEntries: readonly EvidenceRecord[] | null = []): ReplicationResultSummary | undefined {
  const manifest = run?.manifest;
  const provenance = manifest?.replication;
  if (!run || !provenance) return undefined;
  const metrics = Array.isArray(run.metrics) ? run.metrics : [];
  const artifactsFromRun = Array.isArray(run.artifacts) ? run.artifacts : [];
  const ledgerAvailable = evidenceEntries !== null;
  const ledgerEntries = evidenceEntries || [];
  const runEvidenceId = run.evidence?.runId || `experiment-run-${run.id}`;
  const runEvidence = ledgerEntries.find((entry) => entry.id === runEvidenceId);
  const fallbackStatus = !ledgerAvailable ? 'unavailable' : run.status === 'completed' && artifactsFromRun.length > 0 ? 'pending' : 'unverified';
  const resolvedEvidenceStatus = evidenceStatus(runEvidence, fallbackStatus);
  const confirmedStatuses = new Set(['verified', 'human-confirmed', 'approved']);
  const artifacts = artifactsFromRun.map((artifact, index) => {
    const evidenceId = run.evidence?.artifactIds?.[index];
    const entry = evidenceId ? ledgerEntries.find((item) => item.id === evidenceId) : undefined;
    return { ...artifact, evidenceId, evidenceStatus: evidenceStatus(entry, fallbackStatus) };
  });
  const evidenceConfirmed = ledgerAvailable && confirmedStatuses.has(resolvedEvidenceStatus) && artifacts.every((artifact) => confirmedStatuses.has(artifact.evidenceStatus));
  return {
    id: run.id,
    status: run.status,
    evidenceId: runEvidence?.id || runEvidenceId,
    evidenceStatus: resolvedEvidenceStatus,
    evidenceConfirmed,
    supportsSuccessfulFinding: run.status === 'completed' && evidenceConfirmed,
    verificationNote: run.status === 'completed' && evidenceConfirmed
      ? 'Run and all archived artifact Evidence are confirmed.'
      : run.status === 'completed'
        ? 'Run completed, but its Evidence is pending or unverified; human verification is required before treating findings as successful.'
        : `Run status is ${run.status}; it cannot support a successful finding.`,
    provenance,
    codeVersion: manifest.code?.version || '',
    codeSnapshotHash: manifest.code?.snapshotHash || '',
    dataset: { id: manifest.dataset?.id || '', version: manifest.dataset?.version || '' },
    environment: {
      node: manifest.environment?.node || '',
      platform: manifest.environment?.platform || '',
      arch: manifest.environment?.arch || '',
      runner: manifest.environment?.runner || '',
      ...(manifest.environment?.recorded ? { recorded: manifest.environment.recorded } : {})
    },
    metrics,
    artifacts
  };
}

export function toResearchView(workflow: UiWorkflow, claimMatrix?: WritingEvidenceSummary['claimMatrix'], experimentRun?: ExperimentRun | null, replicationRun?: ExperimentRun | null, evidenceEntries: readonly EvidenceRecord[] | null = []) {
  const selectedPapers = selectedPaperIds(workflow);
  const selectedIdeas = selectedIdeaIds(workflow);
  const direction: ResearchDirection = { question: workflow.direction?.question || '', keywords: workflow.direction?.keywords || [], scope: workflow.direction?.scope || '', notes: workflow.direction?.notes || '', falsificationCondition: workflow.direction?.falsificationCondition || '' };
  const search: SearchRunSummary = { ...workflow.search, query: workflow.search?.query || '', candidateCount: workflow.search?.count || workflow.papers?.length || 0, selectedCount: selectedPapers.length, lastRunAt: workflow.search?.lastRunAt, sources: workflow.search?.sources };
  const replication: ReplicationPlan = {
    repository: workflow.replication?.repository || '', codeVersion: workflow.replication?.codeVersion || '',
    environment: workflow.replication?.environment || '', dataset: workflow.replication?.dataset || '',
    datasetVersion: workflow.replication?.datasetVersion || '', expectedMetrics: workflow.replication?.expectedMetrics || '',
    gaps: workflow.replication?.gaps || '', note: workflow.replication?.note || '',
    ...(workflow.replication?.execution ? { execution: workflow.replication.execution } : {}),
    ...(workflow.replication?.parameters ? { parameters: workflow.replication.parameters } : {}),
    ...(workflow.replication?.seed ? { seed: workflow.replication.seed } : {}),
    ...(workflow.replication?.resources ? { resources: workflow.replication.resources } : {}),
    ...(workflow.replication?.artifacts ? { artifacts: workflow.replication.artifacts } : {}),
    status: workflow.replication?.status
  };
  const method: MethodDraft = { title: workflow.method?.title || '', hypothesis: workflow.method?.hypothesis || '', baselines: workflow.method?.baselines || [], ablations: workflow.method?.ablations || [] };
  const experiment: ExperimentPlan = { dataset: workflow.experiment?.dataset || '', datasetVersion: workflow.experiment?.datasetVersion || '', protocol: workflow.experiment?.protocol || workflow.experiment?.command || '', execution: workflow.experiment?.execution, parameters: workflow.experiment?.parameters, seed: workflow.experiment?.seed, successCriteria: workflow.experiment?.successCriteria, artifacts: workflow.experiment?.artifacts, codePaths: workflow.experiment?.codePaths, resources: workflow.experiment?.resources, status: workflow.experiment?.status, metrics: workflow.experiment?.metrics || [] };
  const completedMetrics = experimentRun?.status === 'completed' && Array.isArray(experimentRun.metrics) ? experimentRun.metrics : [];
  const replicationResult = replicationResultSummary(replicationRun, evidenceEntries);
  const writing: WritingEvidenceSummary = { paperCount: selectedPapers.length, innovationCount: selectedIdeas.length, metricCount: completedMetrics.length || experiment.metrics.length, ready: Boolean(workflow.writing?.ready), outline: workflow.writing?.outline || workflow.writing?.evidence?.outline || '', claimMatrix, replicationRun: replicationResult || workflow.writing?.replicationRun };
  return { direction, search, replication, replicationResult, method, experiment, writing, selectedPapers, selectedIdeas };
}
