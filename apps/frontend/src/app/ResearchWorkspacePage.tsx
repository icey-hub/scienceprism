import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  getResearchWorkflowSkills,
  updateResearchWorkflowSkillBindings
} from '../api/workflowAdapter';
import { getEvidenceClaimMatrix, type ClaimEvidenceMatrix } from '../api/evidenceAdapter';
import { getAgentRoles, type AgentRoleSummary } from '../api/client';
import { listProjects, uploadFiles } from '../api/projectAdapter';
import {
  cancelExperimentRun,
  createExperimentRun as createProjectExperimentRun,
  decideExperimentRun,
  listExperimentRuns,
  startExperimentRun,
  type ExperimentRun
} from '../api/experimentAdapter';
import { ResearchStageLayout } from './research/ResearchStageLayout';
import {
  fromHarnessResearchStage,
  isResearchStageId,
  RESEARCH_STAGES,
  toHarnessResearchStage,
  type ExperimentPlan,
  type FilterPolicy,
  type InnovationIdea,
  type MethodDraft,
  type PaperCandidate,
  type ProjectSkill,
  type ReplicationPlan,
  type ResearchDirection,
  type ResearchStageId,
  type ResearchStageStatus,
  type SearchRunSummary,
  type SkillBindings,
  type WritingEvidenceSummary
} from './research/researchStages';
import { DirectionStage } from './research/stages/DirectionStage';
import { SearchStage } from './research/stages/SearchStage';
import { SelectionStage } from './research/stages/SelectionStage';
import { ReplicationStage } from './research/stages/ReplicationStage';
import { InnovationStage } from './research/stages/InnovationStage';
import { MethodStage } from './research/stages/MethodStage';
import { ExperimentStage } from './research/stages/ExperimentStage';
import { WritingStage } from './research/stages/WritingStage';

type StageState = 'locked' | 'ready' | 'active' | 'complete' | 'error';

interface StageRecord {
  id: ResearchStageId;
  state: StageState;
}

interface UiWorkflow {
  projectName?: string;
  version?: number;
  status?: string;
  activeStage?: ResearchStageId;
  currentStage?: ResearchStageId;
  stages?: StageRecord[];
  direction?: Partial<ResearchDirection>;
  search?: { query?: string; count?: number; lastRunAt?: string; sources?: string[]; policy?: Partial<FilterPolicy> };
  replication?: Partial<ReplicationPlan> & { skipped?: boolean };
  papers?: PaperCandidate[];
  ideas?: (InnovationIdea & { selected?: boolean })[];
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
    humanDecision?: { decision?: string; actor?: string } | null;
    error?: { message?: string } | null;
  };
  sourceFailures?: { source?: string; message?: string }[];
}

interface WorkflowEnvelope {
  ok?: boolean;
  workflow?: UiWorkflow;
  data?: UiWorkflow;
  error?: string | { message?: string };
}

const DEFAULT_POLICY: FilterPolicy = { venueLevel: 'CCF-A', publicationType: 'Any', yearFrom: '2022', yearTo: '2026', peerReviewed: true, requireCode: false };
const EMPTY_WORKFLOW: UiWorkflow = {
  activeStage: 'direction', direction: { question: '', keywords: [], scope: '', notes: '' }, search: { query: '', count: 0 }, papers: [],
  replication: { repository: '', environment: '', dataset: '', note: '' }, ideas: [], method: { title: '', hypothesis: '', baselines: [], ablations: [] },
  experiment: { dataset: '', datasetVersion: '', protocol: '', command: '', status: '待规划', metrics: [] }, writing: { ready: false, outline: '' }
};

function getErrorMessage(error: unknown) { return error instanceof Error ? error.message : String(error); }

async function workflowRequest<T>(projectId: string, path = '', options?: RequestInit): Promise<T> {
  const token = typeof window === 'undefined' ? '' : window.sessionStorage.getItem('scienceprism-collab-token') || window.sessionStorage.getItem('openprism-collab-token') || '';
  const headers: Record<string, string> = { 'x-lang': 'zh-CN' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (options?.body) headers['Content-Type'] = 'application/json';
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/research-workflow${path}`, { ...options, headers: { ...headers, ...(options?.headers as Record<string, string> | undefined) } });
  const payload = await response.json().catch(() => ({})) as T & WorkflowEnvelope;
  if (!response.ok || payload.ok === false) {
    const detail = typeof payload.error === 'string' ? payload.error : payload.error?.message;
    throw new Error(detail || `${response.status}:研究流程请求失败`);
  }
  return payload;
}

function mergeWorkflow(input?: UiWorkflow | WorkflowEnvelope): UiWorkflow {
  const raw = input as WorkflowEnvelope | undefined;
  const value = (raw?.workflow || raw?.data || input || {}) as UiWorkflow;
  return {
    ...EMPTY_WORKFLOW, ...value,
    direction: { ...EMPTY_WORKFLOW.direction, ...value.direction }, search: { ...EMPTY_WORKFLOW.search, ...value.search },
    replication: { ...EMPTY_WORKFLOW.replication, ...value.replication }, method: { ...EMPTY_WORKFLOW.method, ...value.method },
    experiment: { ...EMPTY_WORKFLOW.experiment, ...value.experiment }, writing: { ...EMPTY_WORKFLOW.writing, ...value.writing },
    papers: value.papers || [], ideas: value.ideas || []
  };
}

function stageStatuses(workflow: UiWorkflow): Partial<Record<ResearchStageId, ResearchStageStatus>> {
  return Object.fromEntries((workflow.stages || []).map((item) => [item.id, item.state])) as Partial<Record<ResearchStageId, ResearchStageStatus>>;
}

function newIdempotencyKey() {
  return typeof globalThis.crypto?.randomUUID === 'function' ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function mapSkills(skills: Awaited<ReturnType<typeof getResearchWorkflowSkills>>['skills']): ProjectSkill[] {
  return skills.map((skill) => ({ name: skill.name, description: skill.description, source: skill.source, available: true, stages: skill.stages.map((item) => fromHarnessResearchStage(item)) }));
}

function mapBindings(bindings: Awaited<ReturnType<typeof getResearchWorkflowSkills>>['bindings']): SkillBindings {
  const mapped: SkillBindings = {};
  for (const [stage, names] of Object.entries(bindings || {})) {
    if (names) mapped[fromHarnessResearchStage(stage as Parameters<typeof fromHarnessResearchStage>[0])] = names;
  }
  return mapped;
}

function toHarnessBindings(bindings: SkillBindings) {
  return Object.fromEntries(Object.entries(bindings).map(([stage, names]) => [toHarnessResearchStage(stage as ResearchStageId), [...(names || [])]]));
}

function selectedPaperIds(workflow: UiWorkflow) { return (workflow.papers || []).filter((paper) => paper.selected).map((paper) => paper.id); }
function selectedIdeaIds(workflow: UiWorkflow) { return (workflow.ideas || []).filter((idea) => idea.selected).map((idea) => idea.id); }

export interface ResearchWorkspacePageProps {
  embedded?: boolean;
  onStateChange?: (state: ResearchWorkspaceState) => void;
}

export interface ResearchWorkspaceState {
  stage: ResearchStageId;
  activeStage?: ResearchStageId;
  stageStatuses: Partial<Record<ResearchStageId, ResearchStageStatus>>;
  harnessState: 'ready' | 'checking' | 'unavailable';
  projectName: string;
  direction: ResearchDirection;
  policy: FilterPolicy;
  activeSkillNames: string[];
  loading: boolean;
  busy: boolean;
}

export default function ResearchWorkspacePage({ embedded = false, onStateChange }: ResearchWorkspacePageProps) {
  const { projectId = '', stage: rawStage } = useParams<{ projectId: string; stage?: string }>();
  const navigate = useNavigate();
  const stage: ResearchStageId = isResearchStageId(rawStage) ? rawStage : 'direction';
  const [workflow, setWorkflow] = useState<UiWorkflow>(EMPTY_WORKFLOW);
  const [skills, setSkills] = useState<ProjectSkill[]>([]);
  const [skillBindings, setSkillBindings] = useState<SkillBindings>({});
  const [policy, setPolicy] = useState<FilterPolicy>(DEFAULT_POLICY);
  const [paperFilter, setPaperFilter] = useState('');
  const [projectName, setProjectName] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [harnessState, setHarnessState] = useState<'ready' | 'checking' | 'unavailable'>('checking');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [claimMatrix, setClaimMatrix] = useState<ClaimEvidenceMatrix | null>(null);
  const [stageRoles, setStageRoles] = useState<AgentRoleSummary[]>([]);
  const [experimentRun, setExperimentRun] = useState<ExperimentRun | null>(null);
  const skillInputRef = useRef<HTMLInputElement | null>(null);

  const refreshSkills = useCallback(async () => {
    const payload = await getResearchWorkflowSkills(projectId);
    setSkills(mapSkills(payload.skills || []));
    setSkillBindings(mapBindings(payload.bindings || {}));
  }, [projectId]);

  const refreshClaimMatrix = useCallback(async () => {
    if (!projectId) return;
    const payload = await getEvidenceClaimMatrix(projectId);
    setClaimMatrix(payload.matrix || null);
  }, [projectId]);

  const refreshExperimentRun = useCallback(async () => {
    if (!projectId) return;
    const result = await listExperimentRuns(projectId, { limit: '1' });
    setExperimentRun(result.runs?.[0] || null);
  }, [projectId]);

  const loadWorkflow = useCallback(async () => {
    if (!projectId) return;
    setLoading(true); setError('');
    try {
      let payload: WorkflowEnvelope;
      try { payload = await workflowRequest<WorkflowEnvelope>(projectId); }
      catch (requestError) {
        if (!getErrorMessage(requestError).toLowerCase().includes('workflow')) throw requestError;
        payload = await workflowRequest<WorkflowEnvelope>(projectId, '', { method: 'POST', body: JSON.stringify({ actor: 'human' }) });
      }
      const next = mergeWorkflow(payload);
      setWorkflow(next); setPolicy({ ...DEFAULT_POLICY, ...(next.search?.policy || {}) });
      const [skillResult, projectResult, experimentResult] = await Promise.allSettled([refreshSkills(), listProjects(), refreshExperimentRun()]);
      if (skillResult.status === 'rejected') setSkills([]);
      if (projectResult.status === 'fulfilled') setProjectName(projectResult.value.projects?.find((item) => item.id === projectId)?.name || next.projectName || `项目 ${projectId}`);
      else setProjectName(next.projectName || `项目 ${projectId}`);
      if (experimentResult.status === 'rejected') setExperimentRun(null);
    } catch (requestError) { setError(`研究流程加载失败：${getErrorMessage(requestError)}`); }
    finally { setLoading(false); }
  }, [projectId, refreshExperimentRun, refreshSkills]);

  useEffect(() => { if (rawStage && !isResearchStageId(rawStage)) navigate(`/editor/${projectId}/research/direction`, { replace: true }); }, [navigate, projectId, rawStage]);
  useEffect(() => { void loadWorkflow(); }, [loadWorkflow]);
  useEffect(() => {
    if (!experimentRun || !['awaiting_approval', 'approved', 'running'].includes(experimentRun.status)) return undefined;
    const timer = window.setInterval(() => { void refreshExperimentRun().catch((requestError) => setError(`运行状态刷新失败：${getErrorMessage(requestError)}`)); }, 2000);
    return () => window.clearInterval(timer);
  }, [experimentRun, refreshExperimentRun]);
  useEffect(() => {
    fetch('/api/agent/runtime').then((response) => response.ok ? response.json() : null).then((value) => setHarnessState(value?.harnessConfigured === true ? 'ready' : 'unavailable')).catch(() => setHarnessState('unavailable'));
  }, []);
  // Which roles may act at this stage, shown before a run starts. The role
  // registry is keyed by the workflow vocabulary, so the UI stage id is
  // translated the same way every other API call translates it.
  useEffect(() => {
    let cancelled = false;
    getAgentRoles(toHarnessResearchStage(stage))
      .then((result) => { if (!cancelled) setStageRoles(Array.isArray(result?.roles) ? result.roles : []); })
      .catch(() => { if (!cancelled) setStageRoles([]); });
    return () => { cancelled = true; };
  }, [stage]);
  useEffect(() => {
    void refreshClaimMatrix().catch(() => setClaimMatrix(null));
  }, [refreshClaimMatrix, workflow.version]);

  const commitWorkflow = useCallback((payload: UiWorkflow | WorkflowEnvelope) => {
    const next = mergeWorkflow(payload); setWorkflow(next); setPolicy((current) => ({ ...current, ...(next.search?.policy || {}) })); return next;
  }, []);

  const runAction = useCallback(async (action: string, body: Record<string, unknown>, successMessage: string) => {
    setBusy(true); setError(''); setNotice('');
    try {
      const payload = await workflowRequest<WorkflowEnvelope>(projectId, '', { method: 'POST', body: JSON.stringify({ action, ...body, expectedVersion: workflow.version, idempotencyKey: newIdempotencyKey() }) });
      const next = commitWorkflow(payload);
      if (next.task?.status === 'failed') {
        setError(next.task.error?.message || '任务执行失败，请检查配置后重试。');
        return null;
      }
      setNotice(successMessage); return next;
    } catch (requestError) { setError(`操作失败：${getErrorMessage(requestError)}`); return null; }
    finally { setBusy(false); }
  }, [commitWorkflow, projectId, workflow.version]);

  const patchStage = useCallback(async (stageId: ResearchStageId, data: Record<string, unknown>, successMessage: string) => {
    setBusy(true); setError('');
    try {
      const payload = await workflowRequest<WorkflowEnvelope>(projectId, '', { method: 'PATCH', body: JSON.stringify({ stage: toHarnessResearchStage(stageId), data, expectedVersion: workflow.version, idempotencyKey: newIdempotencyKey() }) });
      commitWorkflow(payload); setNotice(successMessage);
    } catch (requestError) { setError(`保存失败：${getErrorMessage(requestError)}`); }
    finally { setBusy(false); }
  }, [commitWorkflow, projectId, workflow.version]);

  const saveDirection = useCallback(async () => {
    const direction = { question: workflow.direction?.question?.trim() || '', keywords: workflow.direction?.keywords || [], scope: workflow.direction?.scope?.trim() || '', notes: workflow.direction?.notes?.trim() || '' };
    setBusy(true); setError('');
    try { const payload = await workflowRequest<WorkflowEnvelope>(projectId, '', { method: 'PATCH', body: JSON.stringify({ direction, expectedVersion: workflow.version, idempotencyKey: newIdempotencyKey() }) }); commitWorkflow(payload); setNotice('研究方向已保存，等待人工确认。'); }
    catch (requestError) { setError(`方向保存失败：${getErrorMessage(requestError)}`); }
    finally { setBusy(false); }
  }, [commitWorkflow, projectId, workflow.direction, workflow.version]);

  const handleSkillBinding = useCallback(async (skillName: string, bindingStage: ResearchStageId, enabled: boolean) => {
    const next: SkillBindings = { ...skillBindings }; const names = new Set(next[bindingStage] || []); if (enabled) names.add(skillName); else names.delete(skillName); next[bindingStage] = [...names]; setSkillBindings(next); setBusy(true);
    try { const payload = await updateResearchWorkflowSkillBindings(projectId, toHarnessBindings(next), '由研究方向页面更新 Skill 绑定', { expectedVersion: workflow.version, idempotencyKey: newIdempotencyKey() }); setSkillBindings(mapBindings(payload.bindings || {})); setNotice('Skill 绑定已保存。'); }
    catch (requestError) { setError(`Skill 绑定保存失败：${getErrorMessage(requestError)}`); await refreshSkills().catch(() => {}); }
    finally { setBusy(false); }
  }, [projectId, refreshSkills, skillBindings, workflow.version]);

  const handleSkillFiles = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []); event.target.value = ''; if (!files.length) return; setBusy(true); setError('');
    const manifests = files
      .map((file) => (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name)
      .filter((path) => path.toLowerCase().endsWith('/skill.md') || path.toLowerCase() === 'skill.md');
    if (!manifests.length || manifests.some((path) => path.split('/').filter(Boolean).length !== 2)) {
      setError('请导入 Skill 文件夹：目录根下必须直接包含 SKILL.md，且文件夹名要与 frontmatter 的 name 一致。');
      setBusy(false);
      return;
    }
    try { await uploadFiles(projectId, files, '.dsh/skills'); await refreshSkills(); setNotice('Skill 已添加到当前项目，请勾选需要启用的阶段。'); }
    catch (requestError) { setError(`Skill 添加失败：${getErrorMessage(requestError)}`); }
    finally { setBusy(false); }
  }, [projectId, refreshSkills]);

  const selectedIds = useMemo(() => selectedPaperIds(workflow), [workflow]);
  const selectedIdeas = useMemo(() => selectedIdeaIds(workflow), [workflow]);
  const visiblePapers = useMemo(() => {
    const term = paperFilter.trim().toLowerCase(); if (!term) return workflow.papers || [];
    return (workflow.papers || []).filter((paper) => `${paper.title} ${paper.venue || ''} ${(paper.authors || []).join(' ')}`.toLowerCase().includes(term));
  }, [paperFilter, workflow.papers]);

  const approveStage = useCallback(async () => {
    setBusy(true); setError('');
    try {
      const payload = await workflowRequest<WorkflowEnvelope>(projectId, '/approve', { method: 'POST', body: JSON.stringify({ actor: 'human', stage, ...(stage === 'replication' ? { decision: 'skip', note: workflow.replication?.note || '人工确认跳过论文复现。' } : {}), expectedVersion: workflow.version, idempotencyKey: newIdempotencyKey() }) });
      const next = commitWorkflow(payload); setNotice(stage === 'replication' ? '已记录跳过论文复现。' : '当前阶段已确认。'); if (next.activeStage && next.activeStage !== stage) navigate(`/editor/${projectId}/research/${next.activeStage}`);
    } catch (requestError) { setError(`审批失败：${getErrorMessage(requestError)}`); }
    finally { setBusy(false); }
  }, [commitWorkflow, navigate, projectId, stage, workflow.replication?.note, workflow.version]);

  const resetWorkflow = useCallback(async () => {
    if (!window.confirm('确定要重置本项目的研究流程吗？已保存的阶段数据可能会被清空。')) return; setBusy(true);
    try { await workflowRequest(projectId, '/reset', { method: 'POST', body: JSON.stringify({ actor: 'human', expectedVersion: workflow.version, idempotencyKey: newIdempotencyKey() }) }); await loadWorkflow(); navigate(`/editor/${projectId}/research/direction`); setNotice('研究流程已重置。'); }
    catch (requestError) { setError(`重置失败：${getErrorMessage(requestError)}`); }
    finally { setBusy(false); }
  }, [loadWorkflow, navigate, projectId, workflow.version]);

  const updateWorkflow = useCallback((patch: Partial<UiWorkflow>) => setWorkflow((current) => mergeWorkflow({ ...current, ...patch })), []);
  const runSearch = useCallback(() => runAction('search', { query: workflow.search?.query || '', direction: workflow.direction || {}, policy }, '检索任务已提交，论文结果会回填到候选列表。'), [policy, runAction, workflow.direction, workflow.search?.query]);
  const savePaperSelection = useCallback(() => runAction('select-papers', { paperIds: selectedIds }, '论文选择已保存，下一步可以生成创新点。'), [runAction, selectedIds]);
  const generateIdeas = useCallback(() => runAction('generate-ideas', { paperIds: selectedIds, direction: workflow.direction || {} }, '创新点候选已生成，请人工比较并选择。'), [runAction, selectedIds, workflow.direction]);
  const saveIdeaSelection = useCallback(() => runAction('select-ideas', { ideaIds: selectedIdeas }, '创新点选择已保存。'), [runAction, selectedIdeas]);
  const generateMethod = useCallback(() => runAction('generate-method', { ideaIds: selectedIdeas }, '方法草案已生成，请补充假设与基线。'), [runAction, selectedIdeas]);
  const saveMethod = useCallback(() => runAction('save-method', { method: workflow.method || {} }, '方法草案已保存。'), [runAction, workflow.method]);
  const saveExperiment = useCallback(() => patchStage('experiment', { ...workflow.experiment, command: workflow.experiment?.command || workflow.experiment?.protocol || '' }, '实验计划已保存。'), [patchStage, workflow.experiment]);
  const runExperiment = useCallback(() => runAction('run-experiment', { experiment: { ...workflow.experiment, command: workflow.experiment?.command || workflow.experiment?.protocol || '' } }, '实验计划已提交，运行状态会同步到本页面。'), [runAction, workflow.experiment]);
  const createControlledExperimentRun = useCallback(async () => {
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await createProjectExperimentRun(projectId, { plan: { ...workflow.experiment, command: workflow.experiment?.command || workflow.experiment?.protocol || '' } });
      setExperimentRun(result.run); setNotice('受控 Run 已创建，等待人工批准。');
    } catch (requestError) { setError(`创建运行失败：${getErrorMessage(requestError)}`); }
    finally { setBusy(false); }
  }, [projectId, workflow.experiment]);
  const approveControlledExperimentRun = useCallback(async () => {
    if (!experimentRun) return;
    setBusy(true); setError('');
    try { const result = await decideExperimentRun(projectId, experimentRun.id, 'approve', '人工批准受控实验运行。'); setExperimentRun(result.run); setNotice('Run 已批准，可以启动隔离执行。'); }
    catch (requestError) { setError(`批准运行失败：${getErrorMessage(requestError)}`); }
    finally { setBusy(false); }
  }, [experimentRun, projectId]);
  const startControlledExperimentRun = useCallback(async () => {
    if (!experimentRun) return;
    setBusy(true); setError('');
    try { const result = await startExperimentRun(projectId, experimentRun.id); setExperimentRun(result.run); setNotice('Run 已启动，日志和产物会写回项目。'); }
    catch (requestError) { setError(`启动运行失败：${getErrorMessage(requestError)}`); }
    finally { setBusy(false); }
  }, [experimentRun, projectId, refreshExperimentRun]);
  const cancelControlledExperimentRun = useCallback(async () => {
    if (!experimentRun) return;
    setBusy(true); setError('');
    try { const result = await cancelExperimentRun(projectId, experimentRun.id); setExperimentRun(result.run); setNotice('Run 已取消。'); }
    catch (requestError) { setError(`取消运行失败：${getErrorMessage(requestError)}`); }
    finally { setBusy(false); }
  }, [experimentRun, projectId]);
  const saveReplication = useCallback(() => patchStage('replication', { replication: workflow.replication || {} }, '复现计划已保存。'), [patchStage, workflow.replication]);
  const skipReplication = useCallback(async () => {
    setBusy(true);
    try { const payload = await workflowRequest<WorkflowEnvelope>(projectId, '/approve', { method: 'POST', body: JSON.stringify({ actor: 'human', stage: 'replication', decision: 'skip', note: workflow.replication?.note || '人工确认跳过论文复现。', expectedVersion: workflow.version, idempotencyKey: newIdempotencyKey() }) }); const next = commitWorkflow(payload); setNotice('已记录跳过论文复现。'); if (next.activeStage) navigate(`/editor/${projectId}/research/${next.activeStage}`); }
    catch (requestError) { setError(`跳过复现失败：${getErrorMessage(requestError)}`); }
    finally { setBusy(false); }
  }, [commitWorkflow, navigate, projectId, workflow.replication?.note, workflow.version]);
  const prepareWriting = useCallback(async () => {
    const next = await runAction('handoff-writing', { paperIds: selectedIds, ideas: (workflow.ideas || []).filter((idea) => idea.selected), method: workflow.method || {}, experiment: workflow.experiment || {} }, '研究材料已整理，可以打开论文写作工作台。');
    const briefPath = next?.writing?.briefPath;
    if (next?.writing?.ready && briefPath) navigate(`/editor/${projectId}?open=${encodeURIComponent(briefPath)}`);
  }, [navigate, projectId, runAction, selectedIds, workflow.experiment, workflow.ideas, workflow.method]);

  const direction: ResearchDirection = { question: workflow.direction?.question || '', keywords: workflow.direction?.keywords || [], scope: workflow.direction?.scope || '', notes: workflow.direction?.notes || '' };
  const search: SearchRunSummary = { query: workflow.search?.query || '', candidateCount: workflow.search?.count || workflow.papers?.length || 0, selectedCount: selectedIds.length, lastRunAt: workflow.search?.lastRunAt, sources: workflow.search?.sources };
  const replication: ReplicationPlan = { repository: workflow.replication?.repository || '', environment: workflow.replication?.environment || '', dataset: workflow.replication?.dataset || '', note: workflow.replication?.note || '', status: workflow.replication?.status };
  const method: MethodDraft = { title: workflow.method?.title || '', hypothesis: workflow.method?.hypothesis || '', baselines: workflow.method?.baselines || [], ablations: workflow.method?.ablations || [] };
  const experiment: ExperimentPlan = { dataset: workflow.experiment?.dataset || '', datasetVersion: workflow.experiment?.datasetVersion || '', protocol: workflow.experiment?.protocol || workflow.experiment?.command || '', execution: workflow.experiment?.execution, parameters: workflow.experiment?.parameters, seed: workflow.experiment?.seed, successCriteria: workflow.experiment?.successCriteria, artifacts: workflow.experiment?.artifacts, status: workflow.experiment?.status, metrics: workflow.experiment?.metrics || [] };
  const writing: WritingEvidenceSummary = { paperCount: selectedIds.length, innovationCount: selectedIdeas.length, metricCount: experiment.metrics.length, ready: Boolean(workflow.writing?.ready), outline: workflow.writing?.outline || workflow.writing?.evidence?.outline || '', claimMatrix: claimMatrix || undefined };

  useEffect(() => {
    onStateChange?.({
      stage,
      activeStage: workflow.activeStage,
      stageStatuses: stageStatuses(workflow),
      harnessState,
      projectName: projectName || `项目 ${projectId}`,
      direction,
      policy,
      activeSkillNames: skills
        .filter((skill) => (skillBindings[stage] || []).includes(skill.name))
        .map((skill) => skill.name),
      loading,
      busy
    });
  }, [busy, harnessState, loading, onStateChange, policy, projectId, projectName, skillBindings, skills, stage, workflow]);

  const renderStage = (): ReactNode => {
    if (stage === 'direction') return <DirectionStage value={direction} skills={skills} skillBindings={skillBindings} busy={busy} onChange={(next) => updateWorkflow({ direction: next })} onSave={saveDirection} onOpenSkillCatalog={() => skillInputRef.current?.click()} onSetSkillStageBinding={handleSkillBinding} />;
    if (stage === 'search') return <SearchStage direction={direction} value={search} busy={busy} onQueryChange={(query) => updateWorkflow({ search: { ...workflow.search, query } })} onRunSearch={runSearch} />;
    if (stage === 'selection') return <SelectionStage policy={policy} papers={visiblePapers} selectedPaperIds={selectedIds} filterValue={paperFilter} totalCandidateCount={workflow.papers?.length || 0} busy={busy} onPolicyChange={setPolicy} onSavePolicy={() => patchStage('selection', { policy }, '筛选规则已保存。')} onFilterValueChange={setPaperFilter} onTogglePaper={(paperId, selected) => updateWorkflow({ papers: (workflow.papers || []).map((paper) => paper.id === paperId ? { ...paper, selected } : paper) })} onSaveSelection={savePaperSelection} onOpenSearchStage={() => navigate(`/editor/${projectId}/research/search`)} />;
    if (stage === 'replication') return <ReplicationStage selectedPapers={(workflow.papers || []).filter((paper) => selectedIds.includes(paper.id))} value={replication} busy={busy} onChange={(next) => updateWorkflow({ replication: next })} onSavePlan={saveReplication} onSkip={skipReplication} />;
    if (stage === 'innovation') return <InnovationStage ideas={workflow.ideas || []} comparison={workflow.ideaComparison || []} selectedIdeaIds={selectedIdeas} selectedPaperCount={selectedIds.length} busy={busy} onGenerate={generateIdeas} onToggleIdea={(ideaId, selected) => updateWorkflow({ ideas: (workflow.ideas || []).map((idea) => idea.id === ideaId ? { ...idea, selected } : idea) })} onSaveSelection={saveIdeaSelection} />;
    if (stage === 'method') return <MethodStage value={method} candidates={workflow.methodCandidates || []} selectedIdeaCount={selectedIdeas.length} busy={busy} onChange={(next) => updateWorkflow({ method: next })} onGenerate={generateMethod} onSave={saveMethod} />;
    if (stage === 'experiment') return <ExperimentStage value={experiment} run={experimentRun} busy={busy} onChange={(next) => updateWorkflow({ experiment: { ...next, command: next.protocol } })} onSavePlan={saveExperiment} onSubmitForRun={runExperiment} onCreateRun={createControlledExperimentRun} onApproveRun={approveControlledExperimentRun} onStartRun={startControlledExperimentRun} onCancelRun={cancelControlledExperimentRun} />;
    return <WritingStage value={writing} busy={busy} onOutlineChange={(outline) => updateWorkflow({ writing: { ...workflow.writing, outline } })} onPrepareWriting={prepareWriting} onOpenEditor={() => navigate(`/editor/${projectId}${workflow.writing?.briefPath ? `?open=${encodeURIComponent(workflow.writing.briefPath)}` : ''}`)} />;
  };

  const context = <div className="research-context-content"><span className="research-overline">RUN CONTEXT</span><h3>当前上下文</h3><dl><dt>研究问题</dt><dd>{direction.question || '尚未填写'}</dd><dt>硬约束</dt><dd>{policy.venueLevel} · {policy.publicationType === 'Any' ? '期刊/会议' : policy.publicationType === 'journal' ? '期刊' : '会议'} · {policy.yearFrom}-{policy.yearTo}</dd><dt>当前 Skill</dt><dd>{(skills.filter((skill) => (skillBindings[stage] || []).includes(skill.name)).map((skill) => skill.name).join('、')) || '使用阶段默认配置'}</dd><dt>阶段任务</dt><dd>{workflow.task?.status === 'awaiting_approval' ? '等待人工确认' : workflow.task?.status === 'failed' ? '执行失败，可重试' : workflow.task?.status || '尚未运行'}</dd><dt>Harness</dt><dd>{workflow.task?.harness?.runId || workflow.task?.harness?.adapter || '未创建运行'}</dd><dt>验证</dt><dd>{workflow.task?.validation?.ok === false ? '需要处理' : workflow.task?.validation?.warnings?.length ? '通过但有提示' : '通过'}</dd><dt>人工控制</dt><dd>AI 辅助，人工确认后才能进入下一阶段</dd></dl>{workflow.task?.validation?.warnings?.length ? <div className="research-callout research-callout-warning"><strong>验证提示</strong><ul>{workflow.task.validation.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></div> : null}{workflow.task?.error?.message ? <div className="research-callout research-callout-warning"><strong>任务失败</strong><p>{workflow.task.error.message}</p></div> : null}{workflow.sourceFailures?.length ? <div className="research-callout research-callout-warning"><strong>来源提示</strong><ul>{workflow.sourceFailures.map((failure, index) => <li key={`${failure.source}-${index}`}>{failure.source}: {failure.message || '检索失败'}</li>)}</ul></div> : null}</div>;

  if (loading) return <div className={`research-stage-loading${embedded ? ' is-embedded' : ''}`}>正在加载研究流程…</div>;
  const stageIndex = RESEARCH_STAGES.findIndex((item) => item.id === stage);
  return <>
    <ResearchStageLayout projectId={projectId} projectName={projectName || `项目 ${projectId}`} stage={stage} embedded={embedded} stageStatuses={stageStatuses(workflow)} harnessState={harnessState} roleSummaries={stageRoles.map((role) => ({ id: role.id, authority: role.authority, capabilities: role.capabilities, skills: role.skills }))} busy={busy} context={context} onNavigate={(nextStage) => navigate(`/editor/${projectId}/research/${nextStage}`)} onBackToEditor={() => navigate(`/editor/${projectId}`)} onRefresh={() => void loadWorkflow()} onApprove={workflow.activeStage === stage ? approveStage : undefined} onPrevious={stageIndex > 0 ? () => navigate(`/editor/${projectId}/research/${RESEARCH_STAGES[stageIndex - 1].id}`) : undefined} onNext={stageIndex < RESEARCH_STAGES.length - 1 ? () => navigate(`/editor/${projectId}/research/${RESEARCH_STAGES[stageIndex + 1].id}`) : undefined}>
      {error && <div className="research-callout research-callout-warning" role="alert"><strong>操作未完成</strong><p>{error}</p><button className="research-button research-button-quiet" onClick={() => void loadWorkflow()} disabled={busy}>重新读取状态</button></div>}
      {notice && <div className="research-callout" role="status"><p>{notice}</p></div>}
      {!error && workflow.task?.status === 'failed' && <div className="research-callout research-callout-warning" role="alert"><strong>任务执行失败</strong><p>{workflow.task.error?.message || '请检查配置后重试。'}</p><button className="research-button research-button-quiet" onClick={() => navigate(`/project/${projectId}/tasks`)}>查看任务与重试</button></div>}
      {workflow.sourceFailures?.length ? <div className="research-callout research-callout-warning" role="status"><strong>部分来源未能完成检索</strong><ul>{workflow.sourceFailures.map((failure, index) => <li key={index}>{failure.source}：{failure.message || '检索失败'}</li>)}</ul></div> : null}
      {renderStage()}
      <details className="research-maintenance"><summary>研究流程管理</summary><p>重置会清空已保存的阶段数据，请谨慎操作。</p><button className="research-button research-button-quiet research-reset-button" disabled={busy} onClick={() => void resetWorkflow()} type="button">重置研究流程</button></details>
    </ResearchStageLayout>
    <input ref={skillInputRef} hidden multiple onChange={handleSkillFiles} type="file" {...({ webkitdirectory: '', directory: '' } as Record<string, unknown>)} />
  </>;
}
