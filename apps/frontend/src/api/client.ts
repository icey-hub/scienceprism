import type { HarnessResearchStageId } from '../researchStageIds';
export interface ProjectMeta {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  tags: string[];
  archived: boolean;
  trashed: boolean;
  trashedAt: string | null;
  researchQuestion?: string;
  researchScope?: string;
  researchKeywords?: string[];
  model?: string;
  setupCompletedAt?: string;
}

export interface FileItem {
  path: string;
  type: 'file' | 'dir';
}

export interface FileOrderMap {
  [folder: string]: string[];
}

export interface LLMConfig {
  endpoint: string;
  apiKey: string;
  model: string;
  runtime?: 'legacy' | 'deepseek-harness';
}

export interface TemplateMeta {
  id: string;
  label: string;
  mainFile: string;
  category: string;
  description: string;
  descriptionEn: string;
  tags: string[];
  author: string;
  featured: boolean;
}

export interface TemplateCategory {
  id: string;
  label: string;
  labelEn: string;
}

export interface ArxivPaper {
  title: string;
  abstract: string;
  authors: string[];
  url: string;
  arxivId: string;
}

const API_BASE = '';
const LANG_KEY = 'scienceprism-lang';
const LEGACY_LANG_KEY = 'openprism-lang';
const COLLAB_TOKEN_KEY = 'scienceprism-collab-token';
const LEGACY_COLLAB_TOKEN_KEY = 'openprism-collab-token';
const COLLAB_SERVER_KEY = 'scienceprism-collab-server';
const LEGACY_COLLAB_SERVER_KEY = 'openprism-collab-server';

function getLangHeader() {
  if (typeof window === 'undefined') return 'zh-CN';
  try {
    const stored = window.localStorage.getItem(LANG_KEY) || window.localStorage.getItem(LEGACY_LANG_KEY);
    return stored === 'en-US' ? 'en-US' : 'zh-CN';
  } catch { return 'zh-CN'; }
}

export function setCollabToken(token: string) {
  if (typeof window === 'undefined') return;
  if (!token) return;
  window.sessionStorage.setItem(COLLAB_TOKEN_KEY, token);
  window.sessionStorage.removeItem(LEGACY_COLLAB_TOKEN_KEY);
}

export function clearCollabToken() {
  if (typeof window === 'undefined') return;
  window.sessionStorage.removeItem(COLLAB_TOKEN_KEY);
  window.sessionStorage.removeItem(LEGACY_COLLAB_TOKEN_KEY);
}

export function getCollabToken() {
  if (typeof window === 'undefined') return '';
  return window.sessionStorage.getItem(COLLAB_TOKEN_KEY) || window.sessionStorage.getItem(LEGACY_COLLAB_TOKEN_KEY) || '';
}

let collabServerFallback = '';

export function setCollabServer(server: string) {
  if (typeof window === 'undefined') return;
  if (!server) return;
  collabServerFallback = server;
  try {
    window.localStorage.setItem(COLLAB_SERVER_KEY, server);
    window.localStorage.removeItem(LEGACY_COLLAB_SERVER_KEY);
  } catch { /* Keep the current connection usable when persistence fails. */ }
}

export function getCollabServer() {
  if (typeof window === 'undefined') return '';
  if (collabServerFallback) return collabServerFallback;
  try { return window.localStorage.getItem(COLLAB_SERVER_KEY) || window.localStorage.getItem(LEGACY_COLLAB_SERVER_KEY) || ''; }
  catch { return ''; }
}

function getAuthHeader(): Record<string, string> {
  const token = getCollabToken();
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

/**
 * Compatibility transport used by the domain adapters. New UI modules should
 * import an adapter instead of adding another endpoint to this file.
 */
export async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const lang = getLangHeader();
  const mergedHeaders: Record<string, string> = {
    'x-lang': lang,
    ...getAuthHeader(),
    ...(options?.headers as Record<string, string> || {})
  };
  if (options?.body && !(options.body instanceof FormData)) {
    mergedHeaders['Content-Type'] = 'application/json';
  }
  const res = await fetch(`${API_BASE}${url}`, {
    ...options,
    headers: mergedHeaders
  });
  if (!res.ok) {
    throw new Error(await res.text());
  }
  return res.json() as Promise<T>;
}

export function listProjects() {
  return request<{ projects: ProjectMeta[] }>('/api/projects');
}

export function createProject(payload: { name: string; template?: string }) {
  return request<ProjectMeta>('/api/projects', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}

export function renameProject(id: string, name: string) {
  return request<{ ok: boolean; project?: ProjectMeta; error?: string }>(`/api/projects/${id}/rename-project`, {
    method: 'POST',
    body: JSON.stringify({ name })
  });
}

export function copyProject(id: string, name?: string) {
  return request<{ ok: boolean; project?: ProjectMeta; error?: string }>(`/api/projects/${id}/copy`, {
    method: 'POST',
    body: JSON.stringify({ name })
  });
}

export interface ProjectBackup {
  format: 'scienceprism-project-backup';
  version: 1;
  createdAt: string;
  project: ProjectMeta;
  files: { path: string; encoding: 'base64'; bytes: number; sha256: string; content: string }[];
}

async function backupRequest<T>(url: string, options?: RequestInit): Promise<T> {
  try { return await request<T>(url, options); }
  catch (error) {
    if (error instanceof Error) {
      let message;
      try { message = JSON.parse(error.message)?.error?.message; } catch { /* non-JSON network failure */ }
      if (typeof message === 'string') throw new Error(message);
    }
    throw error;
  }
}

export function getProjectBackup(id: string) {
  return backupRequest<ProjectBackup>(`/api/projects/${id}/backup`);
}

// Restoring twice returns PROJECT_EXISTS; never replaces an existing project.
export function restoreProjectBackup(backup: unknown) {
  return backupRequest<{ ok: true; project: ProjectMeta }>('/api/projects/restore-backup', { method: 'POST', body: JSON.stringify(backup) });
}

export function deleteProject(id: string) {
  return request<{ ok: boolean; error?: string }>(`/api/projects/${id}`, {
    method: 'DELETE'
  });
}

export function permanentDeleteProject(id: string) {
  return request<{ ok: boolean }>(`/api/projects/${id}/permanent`, {
    method: 'DELETE'
  });
}

export function updateProjectTags(id: string, tags: string[]) {
  return request<{ ok: boolean; project?: ProjectMeta }>(`/api/projects/${id}/tags`, {
    method: 'PATCH',
    body: JSON.stringify({ tags })
  });
}

export function archiveProject(id: string, archived: boolean) {
  return request<{ ok: boolean; project?: ProjectMeta }>(`/api/projects/${id}/archive`, {
    method: 'PATCH',
    body: JSON.stringify({ archived })
  });
}

export function trashProject(id: string, trashed: boolean) {
  return request<{ ok: boolean; project?: ProjectMeta }>(`/api/projects/${id}/trash`, {
    method: 'PATCH',
    body: JSON.stringify({ trashed })
  });
}

export function getProjectTree(id: string) {
  return request<{ items: FileItem[]; fileOrder?: FileOrderMap }>(`/api/projects/${id}/tree`);
}

export interface FileVersion {
  exists: boolean;
  sha256: string | null;
}

export function getFile(id: string, filePath: string) {
  const qs = new URLSearchParams({ path: filePath }).toString();
  return request<{ content: string; version: FileVersion }>(`/api/projects/${id}/file?${qs}`);
}

export function writeFile(id: string, filePath: string, content: string, expectedVersion?: FileVersion) {
  return request<{ ok: boolean; version: FileVersion }>(`/api/projects/${id}/file`, {
    method: 'PUT',
    body: JSON.stringify({ path: filePath, content, expectedVersion })
  });
}

export function getAllFiles(id: string) {
  return request<{ files: { path: string; content: string; encoding?: 'utf8' | 'base64' }[] }>(
    `/api/projects/${id}/files`
  );
}

export function createFolder(id: string, folderPath: string) {
  return request<{ ok: boolean }>(`/api/projects/${id}/folder`, {
    method: 'POST',
    body: JSON.stringify({ path: folderPath })
  });
}

export function renamePath(id: string, from: string, to: string) {
  return request<{ ok: boolean }>(`/api/projects/${id}/rename`, {
    method: 'POST',
    body: JSON.stringify({ from, to })
  });
}

export async function deleteFile(id: string, filePath: string) {
  const qs = new URLSearchParams({ path: filePath }).toString();
  const res = await fetch(`/api/projects/${id}/file?${qs}`, {
    method: 'DELETE',
    headers: {
      'x-lang': getLangHeader()
    }
  });
  if (!res.ok) {
    throw new Error(await res.text());
  }
  return res.json() as Promise<{ ok: boolean; error?: string }>;
}

export function updateFileOrder(id: string, folder: string, order: string[]) {
  return request<{ ok: boolean }>(`/api/projects/${id}/file-order`, {
    method: 'POST',
    body: JSON.stringify({ folder, order })
  });
}

export async function uploadFiles(projectId: string, files: File[], basePath?: string) {
  const form = new FormData();
  files.forEach((file) => {
    const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    const finalPath = basePath ? `${basePath}/${rel}` : rel;
    form.append('files', file, finalPath);
  });
  const res = await fetch(`/api/projects/${projectId}/upload`, {
    method: 'POST',
    body: form,
    headers: {
      'x-lang': getLangHeader(),
      ...getAuthHeader()
    }
  });
  if (!res.ok) {
    throw new Error(await res.text());
  }
  return res.json() as Promise<{ ok: boolean; files?: string[] }>;
}

export function createCollabInvite(id: string) {
  return request<{ ok: boolean; token: string }>(`/api/projects/${id}/collab/invite`, {
    method: 'POST',
    body: JSON.stringify({})
  });
}

export function resolveCollabToken(token: string) {
  const qs = new URLSearchParams({ token }).toString();
  return request<{ ok: boolean; projectId: string; projectName: string; role: string }>(`/api/collab/resolve?${qs}`);
}

export function flushCollabFile(id: string, filePath: string) {
  return request<{ ok: boolean }>(`/api/projects/${id}/collab/flush`, {
    method: 'POST',
    body: JSON.stringify({ path: filePath })
  });
}

export function getCollabStatus(id: string, filePath: string) {
  const qs = new URLSearchParams({ path: filePath }).toString();
  return request<{ ok: boolean; diagnostics: { conns: number; lastError: string | null } | null }>(
    `/api/projects/${id}/collab/status?${qs}`
  );
}

export function runAgent(payload: {
  task: string;
  prompt: string;
  selection: string;
  content: string;
  mode: 'direct' | 'tools';
  projectId?: string;
  activePath?: string;
  compileLog?: string;
  llmConfig?: Partial<LLMConfig>;
  interaction?: 'chat' | 'agent';
  // Names the agent role for this request. The backend narrows the Run's
  // capabilities to the role's allowance, so a read-only task can no longer
  // hold patch.propose merely because the caller said "do not propose patches".
  role?: string;
  history?: { role: 'user' | 'assistant'; content: string }[];
}) {
  return request<{
    ok: boolean;
    reply: string;
    suggestion: string;
    runtime?: 'legacy' | 'deepseek-harness';
    fallback?: boolean;
    harnessError?: string;
    fallbackError?: string;
    patches?: { path: string; diff: string; content: string; deleted?: boolean }[];
    constraintProposal?: { id: string };
    constraintProposalError?: { code: string; message: string };
    constraintError?: { code: string; message: string };
  }>(`/api/agent/run`, {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}

export function getAgentRuntime() {
  return request<{ ok: boolean; runtime: 'legacy' | 'deepseek-harness'; harnessConfigured: boolean; fallback: boolean }>(
    '/api/agent/runtime'
  );
}

/**
 * The role that acts for a stage, with its authority, capabilities, and skills.
 * Read before a run so a person can see what is about to act on their behalf.
 */
export interface AgentRoleSummary {
  id: string;
  purpose: string;
  authority: 'suggest-only' | 'propose-patch' | 'execute' | 'interpret-results';
  capabilities: string[];
  skills: string[];
  forbiddenActions: string[];
  stageScope: HarnessResearchStageId[];
}

export function getAgentRoles(stage?: HarnessResearchStageId) {
  return request<{
    ok: boolean;
    stage: HarnessResearchStageId | null;
    catalog: { total: number; entrypointCount: number };
    roles: AgentRoleSummary[];
  }>(`/api/agent/roles${stage ? `?stage=${encodeURIComponent(stage)}` : ''}`);
}

export interface HarnessPatch {
  path: string;
  diff?: string;
  content?: string;
  original?: string;
  deleted?: boolean;
  baseVersion?: FileVersion | null;
}

export interface RuntimeEvent {
  schemaVersion?: number; id?: string; runId?: string; attempt?: number; sequence?: number;
  type?: string; name?: string; callId?: string; capability?: string; text?: string; at?: string;
  arguments?: string; output?: string; error?: string; outcome?: string; truncated?: boolean;
  path?: string; version?: FileVersion; usage?: Record<string, number>;
  searchSessionId?: string; searchQuery?: string; searchStatus?: 'completed' | 'partial' | 'failed';
  experimentRunId?: string; experimentStatus?: 'completed' | 'failed' | 'cancelled';
}
export interface ToolCatalogue {
  tools:{id:string;name:string;source:string;capability:string|null;calls:number;success:number;error:number;incomplete:number;cancelled:number;unknown:number;serverId?:string;enabled?:boolean;bound?:boolean;dshRestricted?:boolean;recent:{runId:string;callId:string;outcome:string;at:string|null}[]}[];
  skills:(AssistantSkill & {selectedRuns:number;recordedReads:number})[];
  scope:{runLimit:number;runs:number;archivedRuns:number;uncorrelatedEvents:number;droppedEvents:number;unknownRetentionRuns:number};
}
export function getToolCatalogue(projectId:string){return request<{ok:boolean}&ToolCatalogue>(`/api/projects/${encodeURIComponent(projectId)}/tool-catalogue`);}
export interface McpServer {
  id:string;name:string;transport:'stdio'|'streamable-http';enabled:boolean;command:string;args:string[];url:string;
  envKeys:string[];headerKeys:string[];roles:string[];tasks:string[];tools:string[];capability:string;
  discovery?:{state:'discovered'|'failed';at:string;limit?:number;error?:string;tools:{id:string;name:string;publicName:string;description:string;inputSchema:Record<string,unknown>|null;readOnlyHint:boolean}[]}|null;
  execution:{state:string;reason:string};
}
export function getMcpCatalogue(projectId:string){return request<{ok:boolean;version:number;servers:McpServer[]}>(`/api/projects/${encodeURIComponent(projectId)}/mcp`);}
export function saveMcpServer(projectId:string,id:string,input:Record<string,unknown>){return request<{ok:boolean;version:number;servers:McpServer[]}>(`/api/projects/${encodeURIComponent(projectId)}/mcp/${encodeURIComponent(id)}`,{method:'PUT',body:JSON.stringify(input)});}
export function discoverMcpTools(projectId:string,id:string){return request<{ok:boolean;version:number;servers:McpServer[]}>(`/api/projects/${encodeURIComponent(projectId)}/mcp/${encodeURIComponent(id)}/discover`,{method:'POST'});}
export function deleteMcpServer(projectId:string,id:string){return request<{ok:boolean;version:number;servers:McpServer[]}>(`/api/projects/${encodeURIComponent(projectId)}/mcp/${encodeURIComponent(id)}`,{method:'DELETE'});}
export function checkMcpTool(projectId:string,id:string,toolName:string,args:Record<string,unknown>){return request<{ok:boolean;run:HarnessRun}>(`/api/projects/${encodeURIComponent(projectId)}/mcp/${encodeURIComponent(id)}/check`,{method:'POST',body:JSON.stringify({toolName,arguments:args})});}

export interface ExplorationSourceRef { kind: string; id: string; field?: string; version?: string | number | null }
export interface ExplorationNode {
  id: string; kind: string; title: string; status: string; retained: boolean; retention?: string;
  sourceRef: ExplorationSourceRef; href: string | null; version?: string | number | null;
  source?: EvidenceRecord['source'] | null; summary?: string; adapter?: string; decision?: string; bytes?: number;
}
export interface ExplorationGraph {
  schemaVersion: 1; projectId: string; lens: 'execution' | 'evidence'; generatedAt: string;
  workflow?: { currentStage: string; status: string; stageOrder: string[]; optionalStageIds: string[] } | null;
  nodes: ExplorationNode[]; edges: { id: string; from: string; to: string; type: string; sourceRef: ExplorationSourceRef }[];
  warnings: string[];
  scope: { totalNodes: number; totalEdges: number; displayedNodes: number; displayedEdges: number; nodeLimit: number; harnessLimit: number; experimentLimit: number; callsPerRun: number; ledgerVersion: number; workflowVersion: number | null };
}
export function getProjectExploration(projectId: string, query: Record<string,string> = {}) {
  const params = new URLSearchParams(query);
  return request<{ ok: boolean; graph: ExplorationGraph }>(`/api/projects/${encodeURIComponent(projectId)}/exploration?${params}`);
}
export interface HarnessRun {
  id: string;
  kind?: 'codex-worker' | 'research-coordinator' | 'research-stage';
  coordination?: { sessionId: string; status: string; currentStage: string | null };
  sessionId?: string;
  output?: { codex?: { threadId: string; turnId: string | null }; proposalOwnerRunId?: string };
  projectId: string;
  parentRunId?: string | null;
  delegationTask?: string | null;
  delegationDepth?: number;
  role?: string | null;
  attempt?: number;
  retainedWorkspace?: { format: string; attempt: number };
  recovery?: { format: string; status: string; workspaceAttempt: number; children: { runId: string; task: string; reply: string; threadId: string; turnId: string }[] };
  replayOf?: string | null;
  adapterHistory?: { adapter: string; error?: string; at?: string }[];
  archived?: boolean;
  stage: HarnessResearchStageId | string | null;
  task: string;
  adapter: 'deepseek' | 'legacy' | 'fake' | string;
  status: 'created' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled' | string;
  model?: string | null;
  skills?: string[];
  contextHash?: string;
  contextManifest?: Record<string, unknown>;
  capabilities?: { granted?: string[]; denied?: string[]; constraints?: Record<string, unknown> };
  limits?: { timeoutMs?: number; maxTokens?: number; maxConcurrent?: number; retryLimit?: number };
  events?: RuntimeEvent[];
  eventRetention?: { limit: number; total: number; retained: number; dropped: number; priorRetentionUnknown: boolean };
  patches?: HarnessPatch[];
  request?: Partial<AssistantRunInput> & { source?: string; evaluationSource?: { campaignId:string } };
  documentVersions?: (FileVersion & { path: string })[];
  appliedPatches?: string[];
  patchDecisions?: Record<string, { status: string; at?: string }>;
  application?: { status?: string; error?: { message?: string } };
  constraintProposal?: { id: string };
  constraintProposalError?: { code: string; message: string };
  tokenUsage?: Record<string, unknown> | null;
  humanDecision?: { status: string; actor?: string; note?: string; at?: string };
  outputValidation?: { ok?: boolean; warnings?: string[]; errors?: string[] } | null;
  error?: { code?: string; message?: string; retryable?: boolean } | null;
  reply?: string;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  updatedAt: string;
}

export function listHarnessRuns(projectId: string, query: Record<string, string> = {}) {
  const qs = new URLSearchParams(query).toString();
  return request<{ ok: boolean; runs: HarnessRun[] }>(`/api/projects/${projectId}/harness-runs${qs ? `?${qs}` : ''}`);
}

export function getHarnessRun(projectId: string, runId: string) {
  return request<{ ok: boolean; run: HarnessRun }>(`/api/projects/${projectId}/harness-runs/${encodeURIComponent(runId)}`);
}

export function startHarnessRun(projectId: string, runId: string) {
  return request<{ ok: boolean; run: HarnessRun }>(`/api/projects/${projectId}/harness-runs/${encodeURIComponent(runId)}/start`, {
    method: 'POST',
    body: JSON.stringify({})
  });
}

export function pauseHarnessRun(projectId: string, runId: string) {
  return request<{ ok: boolean; run: HarnessRun }>(`/api/projects/${projectId}/harness-runs/${encodeURIComponent(runId)}/pause`, {
    method: 'POST',
    body: JSON.stringify({})
  });
}

export function resumeHarnessRun(projectId: string, runId: string) {
  return request<{ ok: boolean; run: HarnessRun }>(`/api/projects/${projectId}/harness-runs/${encodeURIComponent(runId)}/resume`, {
    method: 'POST',
    body: JSON.stringify({})
  });
}

export function recoverHarnessRun(projectId: string, runId: string) {
  return request<{ ok: boolean; run: HarnessRun }>(`/api/projects/${projectId}/harness-runs/${encodeURIComponent(runId)}/recover`, {
    method: 'POST', body: JSON.stringify({})
  });
}

export function cancelHarnessRun(projectId: string, runId: string) {
  return request<{ ok: boolean; run: HarnessRun }>(`/api/projects/${projectId}/harness-runs/${encodeURIComponent(runId)}/cancel`, {
    method: 'POST',
    body: JSON.stringify({})
  });
}

export function replayHarnessRun(projectId: string, runId: string) {
  return request<{ ok: boolean; run: HarnessRun }>(`/api/projects/${projectId}/harness-runs/${encodeURIComponent(runId)}/replay`, {
    method: 'POST',
    body: JSON.stringify({ start: true })
  });
}

export function decideHarnessRun(projectId: string, runId: string, decision: 'accept' | 'reject', note = '', paths?: string[]) {
  return request<{ ok: boolean; run: HarnessRun }>(`/api/projects/${projectId}/harness-runs/${encodeURIComponent(runId)}/decision`, {
    method: 'POST',
    body: JSON.stringify({ decision, note, paths })
  });
}

export interface AssistantSkill {
  name: string;
  description: string;
  stages: string[];
  source: 'built-in' | 'project';
  relativePath: string;
  available: boolean;
  reason?: string | null;
  shadows?: 'built-in';
}

export function previewAssistantSkill(projectId: string, name: string) {
  return request<{ok:boolean;skill:AssistantSkill;content:string;truncated:boolean}>(`/api/projects/${encodeURIComponent(projectId)}/assistant-skills/${encodeURIComponent(name)}/document`);
}
export function getAssistantSkills(projectId: string) {
  return request<{ ok: boolean; skills: AssistantSkill[] }>(`/api/projects/${projectId}/assistant-skills`);
}

export interface AssistantRunInput {
  requestId: string;
  skillNames?: string[];
  permission: 'read' | 'edit';
  task: string;
  prompt: string;
  activePath?: string;
  selection?: string;
  compileLog?: string;
  history?: { role: 'user' | 'assistant'; content: string }[];
  documentVersions?: (FileVersion & { path: string })[];
  llmConfig?: Partial<LLMConfig>;
}

export function startAssistantRun(projectId: string, input: AssistantRunInput) {
  return request<{ ok: boolean; run: HarnessRun }>(`/api/projects/${projectId}/assistant-runs`, {
    method: 'POST', body: JSON.stringify(input)
  });
}

export function applyHarnessRunPatches(projectId: string, runId: string, paths: string[]) {
  return request<{ ok: boolean; run: HarnessRun; applied: string[]; alreadyApplied: string[] }>(
    `/api/projects/${projectId}/harness-runs/${encodeURIComponent(runId)}/apply`,
    { method: 'POST', body: JSON.stringify({ paths }) }
  );
}

export interface CompileInputSnapshot {
  runId: string;
  mainFile: string;
  engine: string;
  files: { path: string; bytes: number; sha256: string }[];
  hash: string;
}

export function compileProject(payload: {
  projectId: string;
  mainFile: string;
  engine: 'pdflatex' | 'xelatex' | 'lualatex' | 'latexmk' | 'tectonic';
}, signal?: AbortSignal) {
  return request<{ ok: boolean; cancelled?: boolean; code?: string; taskId?: string; pdf?: string; log?: string; status?: number; engine?: string; error?: string; inputSnapshot?: CompileInputSnapshot }>(
    `/api/compile`,
    {
      method: 'POST',
      signal,
      body: JSON.stringify(payload)
    }
  );
}

export interface PaperImportPreviewItem {
  index: number;
  expectedRevision: string | null;
  candidate: Partial<PaperLibraryRecord> & { canonicalKey?: string; citationKey?: string };
  duplicates: { scope: 'project' | 'batch'; paperId?: string; index?: number }[];
  conflicts: { scope: string; field: string; existing: unknown; incoming: unknown }[];
  warnings: string[];
  requiresDecision: boolean;
  checks: { fields: { status: string; issues: string[] }; source: { status: string; reason: string } };
}

export interface PaperImportPreview {
  format: string;
  originalText: string;
  inputDigest: string;
  receivedAt: string;
  count: number;
  writesPerformed: boolean;
  items: PaperImportPreviewItem[];
}

export interface PaperSourceLookup {
  provider: 'doi' | 'arxiv' | string;
  identifier: string;
  requestedVersion?: string | null;
  externalVersion?: string | null;
  retrievedAt: string;
  candidate: Partial<PaperLibraryRecord> & { title?: string; authors?: string[]; year?: number | null; venue?: string; url?: string; abstract?: string };
  record: unknown;
  checks: { fields: { status: string; issues: string[] }; source: { status: string; scope?: string; scientificStatus?: string } };
  matches: { paperId: string; revision: string; conflicts: { field: string; local: unknown; external: unknown }[] }[];
  previewToken: string;
  expiresAt: string;
  allowedFields: string[];
  writesPerformed: false;
}

export interface PaperSourceReview {
  id: string;
  provider: string;
  identifier: string;
  retrievedAt: string;
  externalVersion?: string | null;
  record: unknown;
  checks: PaperSourceLookup['checks'];
  decision: { action: string; fields: string[]; actor: string; at: string; scope: string };
}

export interface PaperLibraryRecord {
  id: string;
  canonicalKey?: string;
  title: string;
  authors: string[];
  abstract?: string;
  url?: string;
  doi?: string;
  arxivId?: string;
  venue?: string;
  publicationType?: string;
  isOpenAccess?: boolean | null;
  oaPdfUrl?: string;
  oaVersion?: string;
  oaLicense?: string;
  issns?: string[];
  year?: number | null;
  source?: { provider?: string | null; url?: string | null; path?: string | null };
  searchSessionIds?: string[];
  sourceRecords?: { searchSessionId?: string; provider?: string; id?: string; retrievedAt?: string; externalVersion?: string | null }[];
  sourceReviews?: PaperSourceReview[];
  evidenceId?: string | null;
  tags: string[];
  favorite: boolean;
  readingStatus: 'unread' | 'reading' | 'read' | 'archived';
  notes: string;
  annotations: { id: string; text: string; quote?: string; page?: number | null; createdAt: string; updatedAt: string }[];
  bibtex: string;
  sourceCheck?: { status: string; checkedAt?: string; provider?: string; issues?: string[] };
  importedAt: string;
  updatedAt: string;
}

export interface RunStatistics {
  total: number; terminal: number; completed: number; failed: number; cancelled: number;
  tokens: { input: number; output: number; total: number };
  usageReports: number; unreportedUsage: number; durationSamples: number; averageDurationMs: number;
}
export interface ProjectObservability {
  generatedAt: string;
  scope: { harnessLimit: number; experimentLimit: number; recentLimit: number; oldestAt: string | null; newestAt: string | null };
  harness: RunStatistics; experiments: RunStatistics; runs: RunStatistics;
  recentRuns: { type: string; runId: string; stage: string; status: string; adapter: string; usageReported: boolean; tokens: { input: number; output: number; total: number }; error?: { message?: string } | null }[];
}
export function getProjectObservability(id: string) {
  return request<{ ok: boolean; observability: ProjectObservability }>(`/api/projects/${encodeURIComponent(id)}/observability`);
}
export function getProjectTask(id: string, taskId: string) {
  return request<{ ok: boolean; task: ProjectTask }>(`/api/projects/${encodeURIComponent(id)}/tasks/${encodeURIComponent(taskId)}`);
}
export function getExperimentRun(id: string, runId: string) {
  return request<{ ok: boolean; run: ExperimentRun }>(`/api/projects/${encodeURIComponent(id)}/experiment-runs/${encodeURIComponent(runId)}`);
}

export type PaperComparisonGap = 'none' | 'data-coverage' | 'missing-control' | 'generalization' | 'missing-report' | 'replication-failed';
export interface PaperComparisonRowInput {
  metricName: string; reportedValue: number | null; unit: string; referenceLocation: string; reportedText: string;
  causeHypothesis: string; nextStep: string; gapType: PaperComparisonGap; tolerance: number | null;
}
export interface PaperComparisonRow extends PaperComparisonRowInput {
  id: string; actualValue: number | null; difference: number | null; hypothesisStatus: 'unverified';
  status: 'match' | 'different' | 'unassessed' | 'missing-report' | 'missing-result' | 'run-failed' | 'run-incomplete';
}
export interface PaperComparison {
  revision: number; runId: string; paper: { id: string; title: string; doi?: string | null; url?: string | null; year?: number | null; sha256?: string };
  paperBinding: 'run-bound' | 'analysis-linked'; source: 'human' | 'ai'; updatedAt: string; runStatus: string; rows: PaperComparisonRow[];
}
export function getPaperComparison(projectId: string, runId: string) {
  return request<{ok:boolean;comparison:PaperComparison|null}>(`/api/projects/${encodeURIComponent(projectId)}/experiment-runs/${encodeURIComponent(runId)}/paper-comparison`);
}
export function savePaperComparison(projectId: string, runId: string, input: {expectedRevision:number;paperId:string;rows:PaperComparisonRowInput[]}) {
  return request<{ok:boolean;comparison:PaperComparison}>(`/api/projects/${encodeURIComponent(projectId)}/experiment-runs/${encodeURIComponent(runId)}/paper-comparison`, {method:'PUT',body:JSON.stringify(input)});
}

export interface IdeaHypothesis {
  problem:string;prediction:string;priorWork:string;conditions:string;falsificationCondition:string;
}
export interface IdeaEvaluation {
  researchType:'empirical'|'computational'|'theoretical';dataset:string;datasetVersion:string;split:string;seed:string;baselines:string[];
  metrics:{name:string;direction:'increase'|'decrease'|'target';threshold:number|null}[];
  repetitions:number|null;ablations:string[];budget:{maxRuns:number|null;maxSeconds:number|null};
}
export interface IdeaPlan {
  ideaId:string;revision:number;createdAt:string;actor:'human'|'ai';sourceRunId?:string;generatedFromRunId?:string;hypothesis:IdeaHypothesis;evaluation:IdeaEvaluation;
  readiness:{ready:boolean;issues:string[]};
  evidence:null|{runId:string;comparisonRevision:number;paper:{id:string;title:string;doi?:string|null;url?:string|null};rows:PaperComparisonRow[]};
  relatedWork?:{searchSessionId:string|null;query:string;sources:string[];searchedAt:string;status:string;
    failures:{source?:string;message?:string;code?:string}[];
    candidates:{id:string;title:string;year?:number|null;doi?:string|null;url?:string|null;source?:string|null}[]};
}
export function getIdeaPlan(projectId:string,ideaId:string) {
  return request<{ok:boolean;plan:IdeaPlan|null;history:IdeaPlan[]}>(`/api/projects/${encodeURIComponent(projectId)}/research-workflow/ideas/${encodeURIComponent(ideaId)}/plan`);
}
export function saveIdeaPlan(projectId:string,ideaId:string,input:{expectedRevision:number;hypothesis:IdeaHypothesis;evaluation:IdeaEvaluation;replicationRunId?:string}) {
  return request<{ok:boolean;plan:IdeaPlan;history:IdeaPlan[]}>(`/api/projects/${encodeURIComponent(projectId)}/research-workflow/ideas/${encodeURIComponent(ideaId)}/plan`,{method:'PUT',headers:{'x-scienceprism-actor':'human'},body:JSON.stringify(input)});
}
export function generateIdeaPlan(projectId:string,ideaId:string,input:{expectedRevision:number;query?:string;replicationRunId?:string}) {
  return request<{ok:boolean;plan:IdeaPlan;history:IdeaPlan[]}>(`/api/projects/${encodeURIComponent(projectId)}/research-workflow/ideas/${encodeURIComponent(ideaId)}/plan/generate`,{method:'POST',headers:{'x-scienceprism-actor':'human'},body:JSON.stringify(input)});
}

export interface ValidationVariant {id:string;label:string;kind:'candidate'|'baseline'|'ablation';parameters:Record<string,unknown>;}
export type ValidationVerdict = 'supported'|'refuted'|'insufficient';
export interface ValidationCampaignEvaluation {
  schemaVersion:1;ruleVersion:'paired-frozen-metrics-v1';scope:'frozen-conditions-only';planRevision:number;planSha256:string;
  verdict:ValidationVerdict;counts:{supported:number;refuted:number;insufficient:number};
  rules:{increase:string;decrease:string;target:string;aggregation:string};limitations:string[];
  summaries:{candidateVariantId:string;candidateLabel:string;comparisonVariantId:string;comparisonLabel:string;comparisonKind:'baseline'|'ablation';
    metricName:string;direction:'increase'|'decrease'|'target';threshold:number|null;expectedSeeds:string[];completeSeeds:number;
    candidateMean:number|null;comparisonMean:number|null;meanImprovement:number|null;verdict:ValidationVerdict;issues:string[]}[];
  rows:{candidateVariantId:string;comparisonVariantId:string;comparisonKind:'baseline'|'ablation';metricName:string;direction:'increase'|'decrease'|'target';threshold:number|null;
    seed:string;candidateRunId:string|null;comparisonRunId:string|null;candidateStatus:string;comparisonStatus:string;
    candidateValue:number|null;comparisonValue:number|null;unit:string|null;delta:number|null;dataStatus:'complete'|'insufficient';issues:string[];
    sourceArtifacts:{runId:string;id:string;path:string;sha256:string;bytes:number}[]}[];
}
export interface ValidationCampaign {
  id:string;projectId:string;sessionId:string;ideaId:string;planRevision:number;planSha256:string;plan:IdeaPlan;
  baseRunId:string;baseManifestSha256:string;seeds:string[];variants:ValidationVariant[];
  budget:{maxRuns:number;maxSeconds:number};status:string;elapsedSeconds:number;error?:{code?:string;message?:string}|null;
  evaluation?:ValidationCampaignEvaluation;
  trials:{id:string;runId:string|null;seed:string;variantId:string;status:string;manifestSha256?:string|null;
    result?:{id:string;status:string;codeVersion?:string;codeSnapshotHash?:string;dataset?:{id:string;version:string};
      metrics?:{name:string;value?:unknown;unit?:string|null}[];errorMessage?:string|null;exitCode?:number|null}|null}[];
}
export interface ValidationCampaignFigureStyle {
  title:string;xLabel:string;yLabel:string;palette:'blue-orange'|'purple-green'|'grayscale';
}
export interface ValidationCampaignFigure {
  id:string;campaignId:string;metricName:string;candidateVariantId:string;comparisonVariantId:string;createdAt:string;
  sourceSha256:string;styleSha256:string;renderer:{name:string;sha256:string;pythonVersion:string;matplotlibVersion:string};
  style:ValidationCampaignFigureStyle;
  statistics:{n:number;unit:string|null;seeds:string[];errorBars:'none';threshold:number;direction:'increase'|'decrease'|'target';caption:string};
  files:Record<'svg'|'pdf'|'png'|'source'|'rendererSource',{path:string;sha256:string;bytes:number;url:string}>;
}
export function getValidationCampaignFigures(projectId:string,campaignId:string) {
  return request<{ok:boolean;figures:ValidationCampaignFigure[]}>(`/api/projects/${encodeURIComponent(projectId)}/validation-campaigns/${encodeURIComponent(campaignId)}/figures`);
}
export function generateValidationCampaignFigure(projectId:string,campaignId:string,input:{candidateVariantId:string;comparisonVariantId:string;metricName:string;style?:Partial<ValidationCampaignFigureStyle>}) {
  return request<{ok:boolean;figure:ValidationCampaignFigure}>(`/api/projects/${encodeURIComponent(projectId)}/validation-campaigns/${encodeURIComponent(campaignId)}/figures`,{method:'POST',headers:{'x-scienceprism-actor':'human'},body:JSON.stringify(input)});
}
export function getValidationCampaigns(projectId:string) {
  return request<{ok:boolean;campaigns:ValidationCampaign[];candidates?:{ideaId:string;title:string;plan:IdeaPlan|null}[]}>(`/api/projects/${encodeURIComponent(projectId)}/validation-campaigns`);
}
export function startValidationCampaign(projectId:string,input:{ideaId:string;expectedPlanRevision:number;seeds:string[];variants:ValidationVariant[]}) {
  return request<import('./automationAdapter').AutomationState & {ok:boolean}>(`/api/projects/${encodeURIComponent(projectId)}/validation-campaigns`,{method:'POST',headers:{'x-scienceprism-actor':'human'},body:JSON.stringify(input)});
}
export function startAutomaticValidationCampaign(projectId:string,input:{ideaId:string;expectedPlanRevision:number}) {
  return request<import('./automationAdapter').AutomationState & {ok:boolean}>(`/api/projects/${encodeURIComponent(projectId)}/validation-campaigns/auto`,{method:'POST',headers:{'x-scienceprism-actor':'human'},body:JSON.stringify(input)});
}

export interface ProjectTask {
  id: string;
  kind: string;
  title: string;
  status: 'queued' | 'running' | 'paused' | 'awaiting_approval' | 'approved' | 'completed' | 'failed' | 'cancelled' | 'rejected' | string;
  progress: number | null;
  stage?: string | null;
  log: string[];
  error?: { message?: string } | null;
  retryable?: boolean;
  metadata?: Record<string, unknown>;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  updatedAt: string;
}

export interface ReplicationRunPlan {
  execution: { adapter: 'node' | 'python'; entrypoint: string; args: string[]; environmentId?: string; codePreparationId?: string };
  parameters?: Record<string, unknown>;
  seed?: string;
  resources?: { timeoutMs?: number; maxOutputBytes?: number; maxArtifactBytes?: number };
  artifacts?: { path: string; kind?: string; name?: string }[];
}

export interface ReplicationEvaluationProtocol {
  datasetSplit: string;
  metricExtraction: string;
  referenceLocation: string;
}

export interface ReplicationPaperSource {
  id: string;
  title: string;
  authors?: string[];
  year?: number | null;
  doi?: string | null;
  url?: string | null;
  source?: string | { provider?: string | null; url?: string | null; path?: string | null } | null;
  sourceRecords?: { provider?: string; id?: string; retrievedAt?: string; [key: string]: unknown }[];
  evidenceId?: string | null;
  sha256: string;
}

export interface ReplicationProvenance {
  sourceStage: 'replication';
  projectId: string;
  workflowId: string;
  workflowVersion: number;
  stageStatus: string;
  paper?: ReplicationPaperSource;
  paperBinding?: 'bound' | 'unbound';
  plan: {
    repository: string;
    codeVersion?: string;
    environment: string;
    dataset: string;
    datasetVersion: string;
    expectedMetrics?: string;
    gaps?: string;
    note: string;
    paperId?: string;
    evaluationProtocol?: ReplicationEvaluationProtocol | null;
  };
}

export interface ExperimentRun {
  paperComparison?: PaperComparison | null;
  id: string;
  projectId: string;
  executionBinding?: { parentRunId: string; policyVersion: string; manifestSha256: string };
  planId?: string | null;
  status: 'awaiting_approval' | 'approved' | 'running' | 'completed' | 'failed' | 'cancelled' | 'rejected' | string;
  phase?: string;
  attempt?: number;
  // Older persisted Runs may omit manifest sections or result arrays. Consumers
  // must keep those records readable and show an explicit "not recorded" value.
  manifest?: {
    campaign?: {campaignId:string;trialId:string;sessionId:string;baseRunId:string;planSha256:string;variantId:string};
    code?: { version?: string; snapshotHash?: string; preparation?: { id:string; sha256:string; source:{runId:string; childRunIds:string[]} } };
    dataset?: { id?: string; version?: string; input?: { path: string; sha256: string; byteLength: number; filename: string; source: {kind: string; url: string | null; revision: string | null}; license: {label: string; verified: boolean}; split: string } };
    environment?: { node?: string; platform?: string; arch?: string; runner?: string; recorded?: string; preparation?: {id: string; sha256: string; lockSha256: string}; python?: {version: string; implementation: string} };
    command?: { adapter?: string; entrypoint?: string; args?: string[] };
    parameters?: Record<string, unknown>;
    seed?: string | null;
    successCriteria?: string[];
    protocol?: string;
    evaluationProtocol?: ReplicationEvaluationProtocol | null;
    replication?: ReplicationProvenance;
    researchPlan?: {
      sourceStage: 'experiment';
      projectId: string;
      workflowId: string;
      workflowVersion: number;
      stageStatus: string;
      plan: { methodId?: string; repetitions?: number; budget?: string; expectedFailures?: string[] };
    };
  };
  approval?: { decision: string; actor: string; note?: string; at: string } | null;
  execution?: { startedAt?: string; finishedAt?: string; exitCode?: number | null; signal?: string | null; isolation?: string | null;
    process?: { pid: number | null; stopConfirmed: boolean }; error?: { code?: string; message?: string } | null } | null;
  logs?: { stdout?: string; stderr?: string };
  metrics?: { name: string; value?: unknown; unit?: string | null; uncertainty?: unknown }[];
  artifacts?: { id: string; name: string; kind: string; path: string; sha256: string; bytes: number }[];
  evidence?: { runId?: string | null; artifactIds?: string[] };
  error?: { code?: string; message?: string; retryable?: boolean } | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface ProjectDashboard {
  project: ProjectMeta;
  initialized: boolean;
  constraints: { capabilities: string[]; allowedPaths: string[]; networkAllowlist: string[]; maxTokens?: number; timeoutMs?: number; contextTokenBudget?: number; fallback?: boolean };
  workflow: any | null;
  progress: { completed: number; total: number; percent: number; currentStage: string | null; currentStatus: string | null };
  approvals: { stageId: string; label: string; status: string; readiness?: { missing?: string[] } }[];
  risks: { id: string; severity: string; title: string; detail: string; href?: string | null }[];
  nextAction: { label: string; href: string; reason: string };
  recentRuns: any[];
  tasks: { total: number; active: number; failed: number; completed: number; recent: ProjectTask[] };
  library: { count: number; unread: number; reading: number; read: number; favorites: number; needsSourceReview: number; tags: string[]; recent: PaperLibraryRecord[] };
  quality: ClaimEvidenceMatrix;
  model: string | null;
  currentStage: { id: string; label: string; status: string; updatedAt: string } | null;
  generatedAt: string;
}

export function getProjectDashboard(projectId: string) {
  return request<{ ok: boolean; dashboard: ProjectDashboard }>(`/api/projects/${projectId}/dashboard`);
}

export function initializeProject(projectId: string, payload: {
  researchQuestion: string;
  scope?: string;
  keywords?: string[];
  notes?: string;
  model?: string;
  constraints?: Record<string, unknown>;
}) {
  return request<{ ok: boolean; result: { project: ProjectMeta; workflow: ResearchWorkflowState; constraints: ProjectDashboard['constraints'] } }>(`/api/projects/${projectId}/initialize`, {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}

export function listProjectPapers(projectId: string, query: Record<string, string> = {}) {
  const qs = new URLSearchParams(query).toString();
  return request<{ ok: boolean; papers: PaperLibraryRecord[] }>(`/api/projects/${projectId}/papers${qs ? `?${qs}` : ''}`);
}

export function lookupProjectPaperSource(projectId: string, input: { doi: string } | { arxivId: string }) {
  return request<{ ok: boolean; lookup: PaperSourceLookup }>(`/api/projects/${projectId}/papers/source-lookup`, {
    method: 'POST', body: JSON.stringify(input)
  });
}

export function confirmProjectPaperSource(projectId: string, payload: { previewToken: string; action: 'create' | 'keep' | 'merge'; paperId?: string; fields?: string[] }) {
  return request<{ ok: boolean; result: { paper?: PaperLibraryRecord; skipped?: boolean; writesPerformed: boolean } }>(`/api/projects/${projectId}/papers/source-confirm`, {
    method: 'POST', body: JSON.stringify(payload)
  });
}

export function previewProjectPaperImport(projectId: string, text: string) {
  return request<{ ok: boolean; preview: PaperImportPreview }>(`/api/projects/${projectId}/papers/import-preview`, {
    method: 'POST', body: JSON.stringify({ format: 'bibtex', text })
  });
}

export function confirmProjectPaperImport(projectId: string, payload: { text: string; inputDigest: string; index: number; expectedRevision: string | null; action: 'create' | 'keep' | 'merge'; fields: string[] }) {
  return request<{ ok: boolean; result: { paper: PaperLibraryRecord; duplicate: boolean; skipped?: boolean } }>(`/api/projects/${projectId}/papers/import-confirm`, {
    method: 'POST', body: JSON.stringify(payload)
  });
}

export function importProjectPaper(projectId: string, paper: Partial<PaperLibraryRecord> & { title: string }) {
  return request<{ ok: boolean; result: { paper: PaperLibraryRecord; duplicate: boolean } }>(`/api/projects/${projectId}/papers`, {
    method: 'POST',
    body: JSON.stringify(paper)
  });
}

export function updateProjectPaper(projectId: string, paperId: string, patch: Partial<PaperLibraryRecord> & { runSourceCheck?: boolean }) {
  return request<{ ok: boolean; result: { paper: PaperLibraryRecord } }>(`/api/projects/${projectId}/papers/${paperId}`, {
    method: 'PATCH',
    body: JSON.stringify(patch)
  });
}

export function checkProjectPaperSource(projectId: string, paperId: string) {
  return request<{ ok: boolean; result: { paper: PaperLibraryRecord } }>(`/api/projects/${projectId}/papers/${paperId}/source-check`, { method: 'POST', body: JSON.stringify({}) });
}

export function deleteProjectPaper(projectId: string, paperId: string) {
  return request<{ ok: boolean }>(`/api/projects/${projectId}/papers/${paperId}`, { method: 'DELETE' });
}

export function listProjectTasks(projectId: string, query: Record<string, string> = {}) {
  const qs = new URLSearchParams(query).toString();
  return request<{ ok: boolean; tasks: ProjectTask[] }>(`/api/projects/${projectId}/tasks${qs ? `?${qs}` : ''}`);
}

export function retryProjectTask(projectId: string, taskId: string) {
  return request<{ ok: boolean; result: { task: ProjectTask } }>(`/api/projects/${projectId}/tasks/${encodeURIComponent(taskId)}/retry`, { method: 'POST', body: JSON.stringify({}) });
}

export function cancelProjectTask(projectId: string, taskId: string) {
  return request<{ ok: boolean; result: { task: ProjectTask } }>(`/api/projects/${projectId}/tasks/${encodeURIComponent(taskId)}/cancel`, { method: 'POST', body: JSON.stringify({}) });
}

export function listExperimentRuns(projectId: string, query: Record<string, string> = {}) {
  const qs = new URLSearchParams(query).toString();
  return request<{ ok: boolean; runs: ExperimentRun[] }>(`/api/projects/${projectId}/experiment-runs${qs ? `?${qs}` : ''}`);
}

export function createExperimentRun(projectId: string, plan: Record<string, unknown>, expectedVersion?: number) {
  return request<{ ok: boolean; run: ExperimentRun }>(`/api/projects/${projectId}/experiment-runs`, {
    method: 'POST',
    body: JSON.stringify({ plan, ...(expectedVersion !== undefined ? { sourceStage: 'experiment', expectedVersion } : {}) })
  });
}

export function createReplicationExperimentRun(projectId: string, expectedVersion: number, plan: ReplicationRunPlan) {
  return request<{ ok: boolean; run: ExperimentRun }>(`/api/projects/${projectId}/experiment-runs`, {
    method: 'POST',
    body: JSON.stringify({ sourceStage: 'replication', expectedVersion, plan })
  });
}

export function decideExperimentRun(projectId: string, runId: string, decision: 'approve' | 'reject', note = '') {
  return request<{ ok: boolean; run: ExperimentRun }>(`/api/projects/${projectId}/experiment-runs/${encodeURIComponent(runId)}/decision`, {
    method: 'POST',
    body: JSON.stringify({ decision, note, actor: 'human' })
  });
}

export function startExperimentRun(projectId: string, runId: string) {
  return request<{ ok: boolean; run: ExperimentRun }>(`/api/projects/${projectId}/experiment-runs/${encodeURIComponent(runId)}/start`, {
    method: 'POST',
    body: JSON.stringify({ wait: false })
  });
}

export function cancelExperimentRun(projectId: string, runId: string) {
  return request<{ ok: boolean; run: ExperimentRun }>(`/api/projects/${projectId}/experiment-runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST', body: JSON.stringify({}) });
}

export function getWritingQuality(projectId: string) {
  return request<{ ok: boolean; quality: any }>(`/api/projects/${projectId}/writing-quality`);
}

export function listTemplates() {
  return request<{ templates: TemplateMeta[]; categories?: TemplateCategory[] }>('/api/templates');
}

export async function uploadTemplate(templateId: string, templateLabel: string, file: File) {
  const form = new FormData();
  form.append('templateId', templateId);
  form.append('templateLabel', templateLabel);
  form.append('file', file);
  const lang = getLangHeader();
  const res = await fetch(`${API_BASE}/api/templates/upload`, {
    method: 'POST',
    headers: { 'x-lang': lang, ...getAuthHeader() },
    body: form,
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<{ ok: boolean; templateId?: string; error?: string }>;
}

export function arxivSearch(payload: { query: string; maxResults?: number }) {
  return request<{ ok: boolean; papers?: ArxivPaper[]; error?: string }>(
    '/api/arxiv/search',
    {
      method: 'POST',
      body: JSON.stringify(payload)
    }
  );
}

export function arxivBibtex(payload: { arxivId: string }) {
  return request<{ ok: boolean; bibtex?: string; entry?: ArxivPaper; error?: string }>(
    '/api/arxiv/bibtex',
    {
      method: 'POST',
      body: JSON.stringify(payload)
    }
  );
}

export function generateGptImage(payload: {
  projectId: string;
  prompt: string;
  size?: '1024x1024' | '1536x1024' | '1024x1536';
  quality?: 'low' | 'medium' | 'high';
  llmConfig?: Partial<LLMConfig>;
}) {
  return request<{ ok: boolean; assetPath?: string; error?: string }>(
    '/api/plot/gpt-image-2',
    { method: 'POST', body: JSON.stringify(payload) }
  );
}

export function callLLM(payload: {
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
  model?: string;
  llmConfig?: Partial<LLMConfig>;
}) {
  return request<{ ok: boolean; content?: string; error?: string }>('/api/llm', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}

export async function importZip(payload: { file: File; projectName?: string }) {
  const form = new FormData();
  form.append('zip', payload.file);
  if (payload.projectName) {
    form.append('projectName', payload.projectName);
  }
  const res = await fetch('/api/projects/import-zip', {
    method: 'POST',
    body: form,
    headers: {
      'x-lang': getLangHeader(),
      ...getAuthHeader()
    }
  });
  if (!res.ok) {
    throw new Error(await res.text());
  }
  return res.json() as Promise<{ ok: boolean; project?: ProjectMeta; error?: string }>;
}

export function importArxivSSE(
  payload: { arxivIdOrUrl: string; projectName?: string },
  onProgress?: (data: { phase: string; percent: number; received?: number; total?: number }) => void
): Promise<{ ok: boolean; project?: ProjectMeta; error?: string }> {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({ arxivIdOrUrl: payload.arxivIdOrUrl });
    if (payload.projectName) params.set('projectName', payload.projectName);
    const token = getCollabToken();
    if (token) params.set('token', token);
    const es = new EventSource(`/api/projects/import-arxiv-sse?${params.toString()}`);

    es.addEventListener('progress', (e) => {
      if (onProgress) {
        try { onProgress(JSON.parse(e.data)); } catch {}
      }
    });
    es.addEventListener('done', (e) => {
      es.close();
      try { resolve(JSON.parse(e.data)); } catch { resolve({ ok: true }); }
    });
    es.addEventListener('error', (e) => {
      es.close();
      const me = e as MessageEvent;
      if (me.data) {
        try {
          const d = JSON.parse(me.data);
          resolve({ ok: false, error: d.error || 'Unknown error' });
          return;
        } catch {}
      }
      reject(new Error('SSE connection failed'));
    });
  });
}

export async function visionToLatex(payload: {
  projectId: string;
  file: File;
  mode: string;
  prompt?: string;
  llmConfig?: Partial<LLMConfig>;
}) {
  const form = new FormData();
  form.append('image', payload.file);
  form.append('projectId', payload.projectId);
  form.append('mode', payload.mode);
  if (payload.prompt) {
    form.append('prompt', payload.prompt);
  }
  if (payload.llmConfig) {
    form.append('llmConfig', JSON.stringify(payload.llmConfig));
  }
  const res = await fetch('/api/vision/latex', {
    method: 'POST',
    body: form,
    headers: {
      'x-lang': getLangHeader(),
      ...getAuthHeader()
    }
  });
  if (!res.ok) {
    throw new Error(await res.text());
  }
  return res.json() as Promise<{ ok: boolean; latex?: string; assetPath?: string; error?: string }>;
}

export type ResearchStageStatus = 'pending' | 'in_progress' | 'awaiting_approval' | 'approved' | 'rejected' | 'skipped';

export interface ResearchStageState {
  id: HarnessResearchStageId;
  status: ResearchStageStatus;
  data: Record<string, unknown>;
  updatedAt: string;
}

/**
 * Who acted. The backend validates this set and refuses an unidentified actor
 * on approval decisions (C-04), so it must never be defaulted on the client.
 */
export type ResearchActor = 'human' | 'ai' | 'system';

export interface ResearchWorkflowState {
  version: number;
  projectId: string;
  title: string;
  currentStage: HarnessResearchStageId;
  stages: ResearchStageState[];
  policy: Record<string, unknown>;
  audit: Array<{
    id: string;
    type: string;
    stage: HarnessResearchStageId;
    at: string;
    actor: ResearchActor;
    details?: Record<string, unknown>;
  }>;
  updatedAt: string;
  skillBindings?: Partial<Record<HarnessResearchStageId, string[]>>;
}

export interface ResearchSkillSummary {
  name: string;
  description: string;
  stages: HarnessResearchStageId[];
  source: 'built-in' | 'project';
  enabled?: boolean;
}

export interface EvidenceRecord {
  id: string;
  kind: string;
  title?: string;
  summary?: string;
  source?: { url?: string | null; path?: string | null; provider?: string | null; locator?: string | null };
  verificationStatus: string;
  version?: string | null;
  sha256?: string | null;
}

export type EvidenceCitationInput = Pick<EvidenceCitation, 'evidenceId' | 'sourceVersion' | 'excerpt' | 'section' | 'page' | 'locator'>;

export interface EvidenceLedgerSnapshot {
  version: number;
  entries: Array<EvidenceRecord & { updatedAt: string; citations?: EvidenceCitation[] }>;
}

export function getEvidenceLedgerSnapshot(projectId: string) {
  return request<{ ok: boolean; ledger: EvidenceLedgerSnapshot }>(`/api/projects/${encodeURIComponent(projectId)}/evidence`);
}

export function saveClaimCitations(projectId: string, claimId: string, citations: EvidenceCitationInput[], expectedVersion: number) {
  return request<{ ok: boolean }>(`/api/projects/${encodeURIComponent(projectId)}/evidence/${encodeURIComponent(claimId)}`, {
    method: 'PUT', body: JSON.stringify({ citations, expectedVersion, actor: 'human' })
  });
}

export interface ManualEvidenceSourceInput {
  title: string;
  summary: string;
  url: string;
  path: string;
  locator: string;
  version: string;
}

export function saveManualEvidenceSource(projectId: string, id: string, input: ManualEvidenceSourceInput, expectedVersion: number) {
  return request<{ ok: boolean; result: { entry: EvidenceRecord; ledgerVersion: number } }>(`/api/projects/${encodeURIComponent(projectId)}/evidence`, {
    method: 'POST', body: JSON.stringify({
      id, title: input.title, summary: input.summary, version: input.version.trim() || null,
      source: { url: input.url.trim() || null, path: input.path.trim() || null, locator: input.locator.trim() || null, provider: '人工补录' },
      kind: 'human-note', verificationStatus: 'unverified', actor: 'human', expectedVersion
    })
  });
}

export interface EvidenceCitation {
  evidenceId: string;
  sourceVersion: string;
  excerpt: string;
  section: string;
  page: string;
  locator: string;
  materialFingerprint: string;
  sourceSnapshot: EvidenceRecord['source'];
  actor: 'human';
  recordedAt: string;
}

export interface ClaimEvidenceRow {
  id: string;
  text: string;
  status: 'supported' | 'unsupported' | 'needs-verification' | string;
  evidenceIds: string[];
  evidence: EvidenceRecord[];
  citations?: EvidenceCitation[];
  contradictingEvidenceIds?: string[];
  missingEvidenceIds: string[];
  unverifiedEvidenceIds: string[];
  staleEvidenceIds: string[];
}

export interface ClaimEvidenceMatrix {
  ok: boolean;
  totalClaims: number;
  supportedClaims: number;
  unsupportedClaims: number;
  needsVerificationClaims: number;
  missingEvidenceIds: string[];
  unverifiedEvidenceIds: string[];
  staleEvidenceIds: string[];
  rows: ClaimEvidenceRow[];
  checkedAt: string;
}

export function getEvidenceClaimMatrix(projectId: string) {
  return request<{ ok: boolean; matrix: ClaimEvidenceMatrix }>(`/api/projects/${projectId}/evidence/claims/matrix`);
}

export function getEvidenceGraph(projectId: string) {
  return request<{ ok: boolean; graph: { nodes: unknown[]; edges: unknown[]; version: number } }>(`/api/projects/${projectId}/evidence/graph`);
}

export function getResearchWorkflow(projectId: string) {
  return request<{ ok: boolean; workflow: ResearchWorkflowState }>(`/api/projects/${projectId}/research-workflow`);
}

export function createResearchWorkflow(projectId: string, payload: { title?: string; policy?: Record<string, unknown> } = {}) {
  return request<{ ok: boolean; workflow: ResearchWorkflowState }>(`/api/projects/${projectId}/research-workflow`, {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}

export function updateResearchWorkflow(projectId: string, payload: {
  stage?: HarnessResearchStageId;
  status?: ResearchStageStatus;
  data?: Record<string, unknown>;
  policy?: Record<string, unknown>;
  title?: string;
}) {
  return request<{ ok: boolean; workflow?: ResearchWorkflowState; error?: string }>(`/api/projects/${projectId}/research-workflow`, {
    method: 'PATCH',
    body: JSON.stringify(payload)
  });
}

// C-04: approval and reset must name their actor. It is required here, not
// defaulted, so a caller cannot inherit a "human" label it never claimed.
export function approveResearchWorkflow(projectId: string, payload: { actor: ResearchActor; stage: HarnessResearchStageId; note?: string }) {
  return request<{ ok: boolean; workflow?: ResearchWorkflowState; error?: string }>(`/api/projects/${projectId}/research-workflow/approve`, {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}

export function resetResearchWorkflow(projectId: string, actor: ResearchActor, stage?: HarnessResearchStageId) {
  return request<{ ok: boolean; workflow?: ResearchWorkflowState; error?: string }>(`/api/projects/${projectId}/research-workflow/reset`, {
    method: 'POST',
    body: JSON.stringify(stage ? { actor, stage } : { actor })
  });
}

export function getResearchWorkflowSkills(projectId: string) {
  return request<{
    ok: boolean;
    skills: ResearchSkillSummary[];
    bindings: Partial<Record<HarnessResearchStageId, string[]>>;
  }>(`/api/projects/${projectId}/research-workflow/skills`);
}

export function updateResearchWorkflowSkillBindings(
  projectId: string,
  bindings: Partial<Record<HarnessResearchStageId, string[]>>,
  note?: string,
  concurrency?: { expectedVersion?: number; idempotencyKey?: string }
) {
  return request<{
    ok: boolean;
    workflow: ResearchWorkflowState;
    bindings: Partial<Record<HarnessResearchStageId, string[]>>;
  }>(`/api/projects/${projectId}/research-workflow/skills/bindings`, {
    method: 'PUT',
    body: JSON.stringify({ bindings, actor: 'human', ...(note ? { note } : {}), ...(concurrency || {}) })
  });
}

// ─── Transfer Agent API ───

export interface TransferStartPayload {
  sourceProjectId: string;
  sourceMainFile: string;
  targetTemplateId: string;
  targetMainFile: string;
  engine?: string;
  layoutCheck?: boolean;
  llmConfig?: Partial<LLMConfig>;
}

export interface TransferStepResult {
  status: string;
  progressLog: string[];
  error?: string;
}

export interface PageImage {
  page: number;
  base64: string;
  mime: string;
}

export function transferStart(payload: TransferStartPayload) {
  return request<{ jobId: string }>('/api/transfer/start', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function transferStep(jobId: string) {
  return request<TransferStepResult>('/api/transfer/step', {
    method: 'POST',
    body: JSON.stringify({ jobId }),
  });
}

export function transferSubmitImages(jobId: string, images: PageImage[]) {
  return request<{ ok: boolean }>('/api/transfer/submit-images', {
    method: 'POST',
    body: JSON.stringify({ jobId, images }),
  });
}

export function transferStatus(jobId: string) {
  return request<TransferStepResult>(`/api/transfer/status/${jobId}`);
}

// ─── MinerU Transfer API ───

export interface MineruConfig {
  apiBase?: string;
  token?: string;
  modelVersion?: string;
}

export interface MineruTransferStartPayload {
  sourceProjectId?: string;
  sourceMainFile?: string;
  targetTemplateId: string;
  targetMainFile: string;
  engine?: string;
  layoutCheck?: boolean;
  llmConfig?: Partial<LLMConfig>;
  mineruConfig?: MineruConfig;
}

export function mineruTransferStart(payload: MineruTransferStartPayload) {
  return request<{ jobId: string; newProjectId: string }>(
    '/api/transfer/start-mineru',
    { method: 'POST', body: JSON.stringify(payload) },
  );
}

export async function mineruTransferUploadPdf(jobId: string, pdfFile: File) {
  const form = new FormData();
  form.append('jobId', jobId);
  form.append('pdf', pdfFile);
  const res = await fetch('/api/transfer/upload-pdf', {
    method: 'POST',
    body: form,
    headers: {
      'x-lang': getLangHeader(),
      ...getAuthHeader(),
    },
  });
  if (!res.ok) {
    throw new Error(await res.text());
  }
  return res.json() as Promise<{ ok: boolean; pdfPath?: string }>;
}
