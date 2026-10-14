import type { LLMConfig, HarnessRun } from './client';
type AutomationModel = Omit<LLMConfig,'apiKey'> & {apiKey?: string};
export type ConfirmationMode = 'inherit' | 'auto' | 'manual';
export interface DatasetScope {allowedHosts:string[];maxBytes:number;maxDatasets:number;}
export interface EnvironmentScope {allowedPaths:string[];maxPackages:number;maxPrepareMs:number;maxOutputBytes:number;maxEnvironments:number;}
export interface CodeScope {allowedPaths:string[];maxTokens:number;timeoutMs:number;maxVersions:number;}
export interface AutomationPolicy { enabled: boolean; agentMode: 'specialists' | 'generalist'; overrides: Record<string, ConfirmationMode>; datasetScope?:DatasetScope|null; environmentScope?:EnvironmentScope|null; codeScope?:CodeScope|null; }
export interface AutomationExecutionPlan { dataset: string; datasetVersion: string; execution: { adapter: 'node' | 'python'; entrypoint: string; args: string[]; environmentId?:string; codePreparationId?:string }; [key: string]: unknown; }
export interface AutomationCodePreparation {
  authorization: { schemaVersion:1; capability:'patch.propose'; actor:'system'; projectId:string; sessionId:string; parentRunId:string;
    stage:'replication'|'experiment'; inputSha256:string; policyVersion:number; scope:CodeScope; scopeSha256:string };
  producerRunId:string|null; preparationId:string|null; sha256:string|null; status:string; paths:string[];
  repairOf?:{trialRunId:string;codePreparationId:string;repairIndex:1};
  error?:{code:string;message:string}|null;
}
export interface AutomationCodeTrial {
  authorization: {stage:'replication'|'experiment';policyVersion:number;[key:string]:unknown};
  plan:AutomationExecutionPlan;
  runId:string|null;status:string;manifestSha256?:string|null;
  result?:{id:string;status:string;purpose:'engineering-trial';supportsSuccessfulFinding:false;codeVersion?:string}|null;
  error?:{code:string;message:string}|null;
}
export interface AutomationStep { stage: string; status: string; runIds: string[]; experimentRunId?: string; result?: { status: string; metrics: {name: string; value: number}[] };
  executionPlanBinding?: { version: number; sha256: string };
  materialPreparation?:{sourcePlan:AutomationExecutionPlan;sourceVersion:number;sourceSha256:string;preparedSha256:string;preparedVersion:number};
  datasetAcquisitions?: {jobId:string|null;datasetId:string|null;status:string;sha256?:string;authorization:{policyVersion:number;sourceRunId:string;proposal:{filename:string;url:string}}}[];
  calls?: {runId:string;task:string}[];
  environmentPreparations?: {jobId:string|null;status:string;environmentId:string|null;sha256?:string}[];
  codePreparations?:AutomationCodePreparation[];
  codeTrials?:AutomationCodeTrial[];
  handoff?: { parentRunId: string; workflowVersion: number; role: string; inputArtifacts: {stage: string; dataSha256: string; producerRunIds: string[]; searchSessionIds: string[]; experimentRunId: string | null}[] }; }
export interface AutomationState {
  version: number; policy: AutomationPolicy; agents: {stage: string; id: string; label: string; purpose: string}[];
  session: null | { id: string; coordinatorRunId?: string; ownerPid?: number; status: string; currentStage?: string; targetStage: string; message?: string; steps: AutomationStep[]; error?: {code: string; details?: {part?: string}};
    executionPlan?: AutomationExecutionPlan | null; executionPlanVersion?: number; executionPlanSha256?: string | null; executionPlanLocked?: boolean };
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
