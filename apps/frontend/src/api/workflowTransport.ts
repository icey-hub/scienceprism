import type { HarnessResearchStageId, ResearchStageId } from '../researchStageIds';

type Stage = ResearchStageId | HarnessResearchStageId;
interface VersionedMutation {
  expectedVersion?: number;
  idempotencyKey: string;
}
interface WorkflowErrorPayload {
  ok?: boolean;
  error?: string | { code?: string; message?: string };
}

/** Keep the server's conflict identity available without exposing HTTP to views. */
export class WorkflowRequestError extends Error {
  constructor(message: string, public status: number, public code?: string) {
    super(message);
    this.name = 'WorkflowRequestError';
  }
}

async function request<T>(projectId: string, suffix = '', method = 'GET', body?: object): Promise<T> {
  const token = typeof window === 'undefined' ? '' : window.sessionStorage.getItem('scienceprism-collab-token') || window.sessionStorage.getItem('openprism-collab-token') || '';
  const headers: Record<string, string> = { 'x-lang': 'zh-CN' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/research-workflow${suffix}`, {
    method, headers, ...(body ? { body: JSON.stringify(body) } : {})
  });
  const payload = await response.json().catch(() => ({})) as T & WorkflowErrorPayload;
  if (!response.ok || payload.ok === false) {
    const detail = typeof payload.error === 'string' ? payload.error : payload.error?.message;
    throw new WorkflowRequestError(detail || `${response.status}:研究流程请求失败`, response.status,
      typeof payload.error === 'object' ? payload.error?.code : undefined);
  }
  return payload;
}

function canonicalStage(stage: Stage): HarnessResearchStageId {
  return stage === 'innovation' ? 'ideation' : stage;
}

export const workflowSession = {
  load<T>(projectId: string) { return request<T>(projectId); },
  initialize<T>(projectId: string) { return request<T>(projectId, '', 'POST', { actor: 'human' }); },
  saveInstructions<T>(projectId: string, stage: Stage, humanInstructions: string, version: VersionedMutation) {
    return request<T>(projectId, '', 'PATCH', { actor: 'human', stage: canonicalStage(stage), humanInstructions, ...version });
  },
  run<T>(projectId: string, action: string, input: Record<string, unknown>, version: VersionedMutation) {
    return request<T>(projectId, '', 'POST', { ...input, action, ...version });
  },
  saveStage<T>(projectId: string, stage: Stage, data: Record<string, unknown>, version: VersionedMutation) {
    return request<T>(projectId, '', 'PATCH', { stage: canonicalStage(stage), data, ...version });
  },
  saveDirection<T>(projectId: string, direction: object, version: VersionedMutation) {
    return request<T>(projectId, '', 'PATCH', { direction, ...version });
  },
  approve<T>(projectId: string, stage: Stage, decision: { decision?: 'skip' | 'reject'; note?: string }, version: VersionedMutation) {
    return request<T>(projectId, '/approve', 'POST', { actor: 'human', stage: canonicalStage(stage), ...decision, ...version });
  },
  reset<T>(projectId: string, version: VersionedMutation) {
    return request<T>(projectId, '/reset', 'POST', { actor: 'human', ...version });
  }
};
