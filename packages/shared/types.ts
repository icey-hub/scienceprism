export interface AgentResponse {
  ok: boolean;
  reply: string;
  suggestion: string;
}

export type ResearchStageId =
  | 'direction'
  | 'search'
  | 'selection'
  | 'replication'
  | 'ideation'
  | 'method'
  | 'experiment'
  | 'writing';

export type ResearchStageStatus = 'pending' | 'in_progress' | 'awaiting_approval' | 'approved' | 'rejected' | 'skipped';

export interface ResearchStageState {
  id: ResearchStageId;
  status: ResearchStageStatus;
  data: Record<string, unknown>;
  updatedAt: string;
}

export interface ResearchWorkflowState {
  version: number;
  projectId: string;
  title: string;
  currentStage: ResearchStageId;
  stages: ResearchStageState[];
  policy: Record<string, unknown>;
  audit: Array<{
    id: string;
    type: string;
    stage: ResearchStageId;
    at: string;
    actor: 'human' | 'ai' | 'system';
    details?: Record<string, unknown>;
  }>;
  updatedAt: string;
  skillBindings?: Partial<Record<ResearchStageId, string[]>>;
}

export interface ResearchSkillSummary {
  name: string;
  description: string;
  stages: ResearchStageId[];
  source: 'built-in' | 'project';
  enabled?: boolean;
}
