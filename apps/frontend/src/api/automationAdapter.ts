import type { LLMConfig, HarnessRun } from './client';
type AutomationModel = Omit<LLMConfig,'apiKey'> & {apiKey?: string};
export type ConfirmationMode = 'inherit' | 'auto' | 'manual';
export interface AutomationPolicy { enabled: boolean; agentMode: 'specialists' | 'generalist'; overrides: Record<string, ConfirmationMode>; }
export interface AutomationStep { stage: string; status: string; runIds: string[]; experimentRunId?: string; result?: { status: string; metrics: {name: string; value: number}[] }; }
export interface AutomationState {
  version: number; policy: AutomationPolicy; agents: {stage: string; id: string; label: string; purpose: string}[];
  session: null | { id: string; status: string; currentStage?: string; targetStage: string; message?: string; steps: AutomationStep[]; error?: {code: string; details?: {part?: string}} };
}
async function request<T>(projectId: string, suffix = '', method = 'GET', body?: object): Promise<T> {
  const token = sessionStorage.getItem('scienceprism-collab-token') || sessionStorage.getItem('openprism-collab-token');
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/research-workflow/automation${suffix}`, {method, headers: {'Content-Type':'application/json', ...(token ? {Authorization:`Bearer ${token}`} : {})}, ...(body ? {body:JSON.stringify(body)} : {})});
  const result = await response.json();
  if (!response.ok || result.ok === false) throw new Error(result.error?.message || `自动研究请求失败 (${response.status})`);
  return result;
}
export const automationApi = {
  load: (projectId: string) => request<AutomationState>(projectId),
  save: (projectId: string, policy: AutomationPolicy, expectedVersion: number) => request<AutomationState>(projectId, '', 'PATCH', {actor:'human', policy, expectedVersion}),
  action: (projectId: string, action: 'start'|'resume'|'stop', input: object = {}, llmConfig?: AutomationModel) => request<AutomationState>(projectId, `/${action}`, 'POST', {actor:'human', ...input, llmConfig}),
  applyPatches: (projectId: string, runId: string) => request<{run: HarnessRun}>(projectId, `/patches/${encodeURIComponent(runId)}/apply`, 'POST', {})
};
