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
  const stored = window.localStorage.getItem(LANG_KEY) || window.localStorage.getItem(LEGACY_LANG_KEY);
  return stored === 'en-US' ? 'en-US' : 'zh-CN';
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

export function setCollabServer(server: string) {
  if (typeof window === 'undefined') return;
  if (!server) return;
  window.localStorage.setItem(COLLAB_SERVER_KEY, server);
  window.localStorage.removeItem(LEGACY_COLLAB_SERVER_KEY);
}

export function getCollabServer() {
  if (typeof window === 'undefined') return '';
  return window.localStorage.getItem(COLLAB_SERVER_KEY) || window.localStorage.getItem(LEGACY_COLLAB_SERVER_KEY) || '';
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
  if (options?.body) {
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

export function getFile(id: string, filePath: string) {
  const qs = new URLSearchParams({ path: filePath }).toString();
  return request<{ content: string }>(`/api/projects/${id}/file?${qs}`);
}

export function writeFile(id: string, filePath: string, content: string) {
  return request<{ ok: boolean }>(`/api/projects/${id}/file`, {
    method: 'PUT',
    body: JSON.stringify({ path: filePath, content })
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

export interface HarnessRun {
  id: string;
  projectId: string;
  stage: ResearchStageId | string | null;
  task: string;
  adapter: 'deepseek' | 'legacy' | 'fake' | string;
  status: 'created' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled' | string;
  model?: string | null;
  skills?: string[];
  contextHash?: string;
  contextManifest?: Record<string, unknown>;
  capabilities?: { granted?: string[]; denied?: string[]; constraints?: Record<string, unknown> };
  limits?: { timeoutMs?: number; maxTokens?: number; maxConcurrent?: number; retryLimit?: number };
  events?: { type?: string; name?: string; capability?: string; text?: string; at?: string }[];
  patches?: { path: string; diff: string; content: string; deleted?: boolean }[];
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

export function decideHarnessRun(projectId: string, runId: string, decision: 'accept' | 'reject', note = '') {
  return request<{ ok: boolean; run: HarnessRun }>(`/api/projects/${projectId}/harness-runs/${encodeURIComponent(runId)}/decision`, {
    method: 'POST',
    body: JSON.stringify({ decision, note })
  });
}

export function compileProject(payload: {
  projectId: string;
  mainFile: string;
  engine: 'pdflatex' | 'xelatex' | 'lualatex' | 'latexmk' | 'tectonic';
}) {
  return request<{ ok: boolean; pdf?: string; log?: string; status?: number; engine?: string; error?: string }>(
    `/api/compile`,
    {
      method: 'POST',
      body: JSON.stringify(payload)
    }
  );
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
  year?: number | null;
  source?: { provider?: string | null; url?: string | null; path?: string | null };
  sourceRecords?: { provider?: string; id?: string; retrievedAt?: string }[];
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

export interface ProjectTask {
  id: string;
  kind: string;
  title: string;
  status: 'queued' | 'running' | 'paused' | 'awaiting_approval' | 'approved' | 'completed' | 'failed' | 'cancelled' | 'rejected' | string;
  progress: number;
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

export interface ExperimentRun {
  id: string;
  projectId: string;
  planId?: string | null;
  status: 'awaiting_approval' | 'approved' | 'running' | 'completed' | 'failed' | 'cancelled' | 'rejected' | string;
  phase?: string;
  manifest: {
    code: { version: string; snapshotHash: string };
    dataset: { id: string; version: string };
    environment: { node: string; platform: string; arch: string; runner: string };
    command: { adapter: string; entrypoint?: string; args: string[] };
    parameters: Record<string, unknown>;
    seed?: string | null;
    successCriteria: string[];
  };
  approval?: { decision: string; actor: string; note?: string; at: string } | null;
  execution?: { startedAt?: string; finishedAt?: string; exitCode?: number | null; signal?: string | null; error?: { code?: string; message?: string } | null } | null;
  logs?: { stdout?: string; stderr?: string };
  metrics: { name: string; value?: unknown; unit?: string | null; uncertainty?: unknown }[];
  artifacts: { id: string; name: string; kind: string; path: string; sha256: string; bytes: number }[];
  evidence?: { runId?: string | null; artifactIds?: string[] };
  error?: { code?: string; message?: string; retryable?: boolean } | null;
  createdAt: string;
  updatedAt: string;
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

export function createExperimentRun(projectId: string, plan: Record<string, unknown>) {
  return request<{ ok: boolean; run: ExperimentRun }>(`/api/projects/${projectId}/experiment-runs`, {
    method: 'POST',
    body: JSON.stringify({ plan })
  });
}

export function decideExperimentRun(projectId: string, runId: string, decision: 'approve' | 'reject', note = '') {
  return request<{ ok: boolean; run: ExperimentRun }>(`/api/projects/${projectId}/experiment-runs/${encodeURIComponent(runId)}/decision`, {
    method: 'POST',
    body: JSON.stringify({ decision, note })
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

export function plotFromTable(payload: {
  projectId: string;
  tableLatex: string;
  chartType: string;
  title?: string;
  prompt?: string;
  filename?: string;
  retries?: number;
  llmConfig?: Partial<LLMConfig>;
}) {
  return request<{ ok: boolean; assetPath?: string; error?: string }>(
    '/api/plot/from-table',
    {
      method: 'POST',
      body: JSON.stringify(payload)
    }
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

/**
 * Who acted. The backend validates this set and refuses an unidentified actor
 * on approval decisions (C-04), so it must never be defaulted on the client.
 */
export type ResearchActor = 'human' | 'ai' | 'system';

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
    actor: ResearchActor;
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

export interface ClaimEvidenceRow {
  id: string;
  text: string;
  status: 'supported' | 'unsupported' | 'needs-verification' | string;
  evidenceIds: string[];
  evidence: EvidenceRecord[];
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
  stage?: ResearchStageId;
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
export function approveResearchWorkflow(projectId: string, payload: { actor: ResearchActor; stage: ResearchStageId; note?: string }) {
  return request<{ ok: boolean; workflow?: ResearchWorkflowState; error?: string }>(`/api/projects/${projectId}/research-workflow/approve`, {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}

export function resetResearchWorkflow(projectId: string, actor: ResearchActor, stage?: ResearchStageId) {
  return request<{ ok: boolean; workflow?: ResearchWorkflowState; error?: string }>(`/api/projects/${projectId}/research-workflow/reset`, {
    method: 'POST',
    body: JSON.stringify(stage ? { actor, stage } : { actor })
  });
}

export function getResearchWorkflowSkills(projectId: string) {
  return request<{
    ok: boolean;
    skills: ResearchSkillSummary[];
    bindings: Partial<Record<ResearchStageId, string[]>>;
  }>(`/api/projects/${projectId}/research-workflow/skills`);
}

export function updateResearchWorkflowSkillBindings(
  projectId: string,
  bindings: Partial<Record<ResearchStageId, string[]>>,
  note?: string,
  concurrency?: { expectedVersion?: number; idempotencyKey?: string }
) {
  return request<{
    ok: boolean;
    workflow: ResearchWorkflowState;
    bindings: Partial<Record<ResearchStageId, string[]>>;
  }>(`/api/projects/${projectId}/research-workflow/skills/bindings`, {
    method: 'PUT',
    body: JSON.stringify({ bindings, ...(note ? { note } : {}), ...(concurrency || {}) })
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
