export type ResearchStageId =
  | 'direction'
  | 'search'
  | 'selection'
  | 'replication'
  | 'innovation'
  | 'method'
  | 'experiment'
  | 'writing';

/** The workflow service calls the innovation stage "ideation". */
export type HarnessResearchStageId = Exclude<ResearchStageId, 'innovation'> | 'ideation';

export type ResearchStageStatus = 'locked' | 'ready' | 'active' | 'complete' | 'error';

export interface ResearchStageDefinition {
  id: ResearchStageId;
  harnessId: HarnessResearchStageId;
  index: number;
  label: string;
  description: string;
}

export const RESEARCH_STAGES: readonly ResearchStageDefinition[] = [
  { id: 'direction', harnessId: 'direction', index: 1, label: '研究方向', description: '由研究者定义问题、边界与工作偏好' },
  { id: 'search', harnessId: 'search', index: 2, label: '论文检索', description: '由 AI 补充检索式并保留来源' },
  { id: 'selection', harnessId: 'selection', index: 3, label: '筛选论文', description: '由质量规则与人工判断共同筛选' },
  { id: 'replication', harnessId: 'replication', index: 4, label: '论文复现', description: '可选地验证已有工作和实验条件' },
  { id: 'innovation', harnessId: 'ideation', index: 5, label: '创新点', description: '从已确认的证据中发现可检验空白' },
  { id: 'method', harnessId: 'method', index: 6, label: '方法设计', description: '把创新点转为明确的方法与假设' },
  { id: 'experiment', harnessId: 'experiment', index: 7, label: '实验验证', description: '记录数据、计划、结果与统计约束' },
  { id: 'writing', harnessId: 'writing', index: 8, label: '写作整合', description: '在同一项目中将证据带入论文正文' }
];

export const STAGE_STATUS_LABELS: Record<ResearchStageStatus, string> = {
  locked: '未开始',
  ready: '待确认',
  active: '进行中',
  complete: '已完成',
  error: '需处理'
};

export function isResearchStageId(value: string | undefined): value is ResearchStageId {
  return RESEARCH_STAGES.some((stage) => stage.id === value);
}

export function getResearchStage(id: ResearchStageId): ResearchStageDefinition {
  const stage = RESEARCH_STAGES.find((item) => item.id === id);
  if (!stage) throw new Error(`Unknown research stage: ${id}`);
  return stage;
}

export function toHarnessResearchStage(id: ResearchStageId): HarnessResearchStageId {
  return getResearchStage(id).harnessId;
}

export function fromHarnessResearchStage(id: HarnessResearchStageId): ResearchStageId {
  return id === 'ideation' ? 'innovation' : id;
}

export interface ResearchDirection {
  question: string;
  keywords: string[];
  scope: string;
  notes: string;
}

export interface SearchRunSummary {
  query: string;
  candidateCount: number;
  selectedCount: number;
  lastRunAt?: string;
  sources?: string[];
}

export interface FilterPolicy {
  venueLevel: 'CCF-A' | 'CCF-B' | 'CCF-C' | 'Any';
  publicationType: 'journal' | 'conference' | 'Any';
  yearFrom: string;
  yearTo: string;
  peerReviewed: boolean;
  requireCode: boolean;
}

export type PaperEligibility = 'pass' | 'review' | 'reject';

export interface PaperCandidate {
  id: string;
  title: string;
  venue?: string;
  year?: number;
  authors?: string[];
  abstract?: string;
  url?: string;
  ccf?: string;
  quality?: number;
  eligibility?: PaperEligibility;
  reason?: string;
  selected?: boolean;
}

export interface ReplicationPlan {
  repository: string;
  environment: string;
  dataset: string;
  note: string;
  status?: string;
}

export interface InnovationIdea {
  id: string;
  title: string;
  summary: string;
  evidence: string[];
}

export interface MethodDraft {
  title: string;
  hypothesis: string;
  baselines: string[];
  ablations: string[];
}

export interface ExperimentMetric {
  name: string;
  value?: string;
  uncertainty?: string;
}

export interface ExperimentPlan {
  dataset: string;
  datasetVersion: string;
  protocol: string;
  status?: string;
  metrics: ExperimentMetric[];
}

export interface WritingEvidenceSummary {
  paperCount: number;
  innovationCount: number;
  metricCount: number;
  ready: boolean;
  outline: string;
}

export type ProjectSkillSource = 'built-in' | 'project';

export interface ProjectSkill {
  name: string;
  description: string;
  stages: ResearchStageId[];
  source?: ProjectSkillSource;
  available?: boolean;
}

export type SkillBindings = Partial<Record<ResearchStageId, readonly string[]>>;

export function formatResearchDate(value?: string): string {
  if (!value) return '尚未运行';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false });
}
