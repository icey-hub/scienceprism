import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  getResearchWorkflowSkills,
  listProjects,
  uploadFiles,
  updateResearchWorkflowSkillBindings
} from '../api/client';
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
  state?: StageState;
}

interface UiWorkflow {
  projectName?: string;
  status?: string;
  activeStage?: ResearchStageId;
  currentStage?: ResearchStageId;
  stages?: StageRecord[];
  direction?: Partial<ResearchDirection>;
  search?: { query?: string; count?: number; lastRunAt?: string; sources?: string[]; policy?: Partial<FilterPolicy> };
  replication?: Partial<ReplicationPlan> & { skipped?: boolean };
  papers?: PaperCandidate[];
  ideas?: (InnovationIdea & { selected?: boolean })[];
  method?: Partial<MethodDraft>;
  experiment?: Partial<ExperimentPlan> & { command?: string };
  writing?: Partial<WritingEvidenceSummary> & { handoffAt?: string; evidence?: { outline?: string } };
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
  const token = typeof window === 'undefined' ? '' : window.sessionStorage.getItem('openprism-collab-token') || '';
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

function stageState(stage: ResearchStageId, workflow: UiWorkflow): StageState {
  const explicit = workflow.stages?.find((item) => item.id === stage)?.state;
  if (explicit) return explicit;
  if (workflow.activeStage === stage) return 'active';
  const activeIndex = RESEARCH_STAGES.findIndex((item) => item.id === workflow.activeStage);
  const index = RESEARCH_STAGES.findIndex((item) => item.id === stage);
  if (activeIndex < 0 || index < 0) return 'locked';
  if (index < activeIndex) return 'complete';
  return index === activeIndex + 1 ? 'ready' : 'locked';
}

function stageStatuses(workflow: UiWorkflow): Partial<Record<ResearchStageId, ResearchStageStatus>> {
  return Object.fromEntries(RESEARCH_STAGES.map((item) => [item.id, stageState(item.id, workflow)])) as Partial<Record<ResearchStageId, ResearchStageStatus>>;
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
  const skillInputRef = useRef<HTMLInputElement | null>(null);

  const refreshSkills = useCallback(async () => {
    const payload = await getResearchWorkflowSkills(projectId);
    setSkills(mapSkills(payload.skills || []));
    setSkillBindings(mapBindings(payload.bindings || {}));
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
      const [skillResult, projectResult] = await Promise.allSettled([refreshSkills(), listProjects()]);
      if (skillResult.status === 'rejected') setSkills([]);
      if (projectResult.status === 'fulfilled') setProjectName(projectResult.value.projects?.find((item) => item.id === projectId)?.name || next.projectName || `项目 ${projectId}`);
      else setProjectName(next.projectName || `项目 ${projectId}`);
    } catch (requestError) { setError(`研究流程加载失败：${getErrorMessage(requestError)}`); }
    finally { setLoading(false); }
  }, [projectId, refreshSkills]);

  useEffect(() => { if (rawStage && !isResearchStageId(rawStage)) navigate(`/editor/${projectId}/research/direction`, { replace: true }); }, [navigate, projectId, rawStage]);
  useEffect(() => { void loadWorkflow(); }, [loadWorkflow]);
  useEffect(() => {
    fetch('/api/agent/runtime').then((response) => response.ok ? response.json() : null).then((value) => setHarnessState(value?.harnessConfigured === true ? 'ready' : 'unavailable')).catch(() => setHarnessState('unavailable'));
  }, []);

  const commitWorkflow = useCallback((payload: UiWorkflow | WorkflowEnvelope) => {
    const next = mergeWorkflow(payload); setWorkflow(next); setPolicy((current) => ({ ...current, ...(next.search?.policy || {}) })); return next;
  }, []);

  const runAction = useCallback(async (action: string, body: Record<string, unknown>, successMessage: string) => {
    setBusy(true); setError(''); setNotice('');
    try {
      const payload = await workflowRequest<WorkflowEnvelope>(projectId, '', { method: 'POST', body: JSON.stringify({ action, ...body }) });
      const next = commitWorkflow(payload); setNotice(successMessage); return next;
    } catch (requestError) { setError(`操作失败：${getErrorMessage(requestError)}`); return null; }
    finally { setBusy(false); }
  }, [commitWorkflow, projectId]);

  const patchStage = useCallback(async (stageId: ResearchStageId, data: Record<string, unknown>, successMessage: string) => {
    setBusy(true); setError('');
    try {
      const payload = await workflowRequest<WorkflowEnvelope>(projectId, '', { method: 'PATCH', body: JSON.stringify({ stage: toHarnessResearchStage(stageId), data }) });
      commitWorkflow(payload); setNotice(successMessage);
    } catch (requestError) { setError(`保存失败：${getErrorMessage(requestError)}`); }
    finally { setBusy(false); }
  }, [commitWorkflow, projectId]);

  const saveDirection = useCallback(async () => {
    const direction = { question: workflow.direction?.question?.trim() || '', keywords: workflow.direction?.keywords || [], scope: workflow.direction?.scope?.trim() || '', notes: workflow.direction?.notes?.trim() || '' };
    setBusy(true); setError('');
    try { const payload = await workflowRequest<WorkflowEnvelope>(projectId, '', { method: 'PATCH', body: JSON.stringify({ direction }) }); commitWorkflow(payload); setNotice('研究方向已保存，等待人工确认。'); }
    catch (requestError) { setError(`方向保存失败：${getErrorMessage(requestError)}`); }
    finally { setBusy(false); }
  }, [commitWorkflow, projectId, workflow.direction]);

  const handleSkillBinding = useCallback(async (skillName: string, bindingStage: ResearchStageId, enabled: boolean) => {
    const next: SkillBindings = { ...skillBindings }; const names = new Set(next[bindingStage] || []); if (enabled) names.add(skillName); else names.delete(skillName); next[bindingStage] = [...names]; setSkillBindings(next); setBusy(true);
    try { const payload = await updateResearchWorkflowSkillBindings(projectId, toHarnessBindings(next), '由研究方向页面更新 Skill 绑定'); setSkillBindings(mapBindings(payload.bindings || {})); setNotice('Skill 绑定已保存。'); }
    catch (requestError) { setError(`Skill 绑定保存失败：${getErrorMessage(requestError)}`); await refreshSkills().catch(() => {}); }
    finally { setBusy(false); }
  }, [projectId, refreshSkills, skillBindings]);

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
      const payload = await workflowRequest<WorkflowEnvelope>(projectId, '/approve', { method: 'POST', body: JSON.stringify({ stage, ...(stage === 'replication' ? { decision: 'skip', note: workflow.replication?.note || '人工确认跳过论文复现。' } : {}) }) });
      const next = commitWorkflow(payload); setNotice(stage === 'replication' ? '已记录跳过论文复现。' : '当前阶段已确认。'); if (next.activeStage && next.activeStage !== stage) navigate(`/editor/${projectId}/research/${next.activeStage}`);
    } catch (requestError) { setError(`审批失败：${getErrorMessage(requestError)}`); }
    finally { setBusy(false); }
  }, [commitWorkflow, navigate, projectId, stage, workflow.replication?.note]);

  const resetWorkflow = useCallback(async () => {
    if (!window.confirm('确定要重置本项目的研究流程吗？已保存的阶段数据可能会被清空。')) return; setBusy(true);
    try { await workflowRequest(projectId, '/reset', { method: 'POST', body: JSON.stringify({}) }); await loadWorkflow(); navigate(`/editor/${projectId}/research/direction`); setNotice('研究流程已重置。'); }
    catch (requestError) { setError(`重置失败：${getErrorMessage(requestError)}`); }
    finally { setBusy(false); }
  }, [loadWorkflow, navigate, projectId]);

  const updateWorkflow = useCallback((patch: Partial<UiWorkflow>) => setWorkflow((current) => mergeWorkflow({ ...current, ...patch })), []);
  const runSearch = useCallback(() => runAction('search', { query: workflow.search?.query || '', direction: workflow.direction || {}, policy }, '检索任务已提交，论文结果会回填到候选列表。'), [policy, runAction, workflow.direction, workflow.search?.query]);
  const savePaperSelection = useCallback(() => runAction('select-papers', { paperIds: selectedIds }, '论文选择已保存，下一步可以生成创新点。'), [runAction, selectedIds]);
  const generateIdeas = useCallback(() => runAction('generate-ideas', { paperIds: selectedIds, direction: workflow.direction || {} }, '创新点候选已生成，请人工比较并选择。'), [runAction, selectedIds, workflow.direction]);
  const saveIdeaSelection = useCallback(() => runAction('select-ideas', { ideaIds: selectedIdeas }, '创新点选择已保存。'), [runAction, selectedIdeas]);
  const generateMethod = useCallback(() => runAction('generate-method', { ideaIds: selectedIdeas }, '方法草案已生成，请补充假设与基线。'), [runAction, selectedIdeas]);
  const saveMethod = useCallback(() => runAction('save-method', { method: workflow.method || {} }, '方法草案已保存。'), [runAction, workflow.method]);
  const saveExperiment = useCallback(() => patchStage('experiment', { ...workflow.experiment, command: workflow.experiment?.command || workflow.experiment?.protocol || '' }, '实验计划已保存。'), [patchStage, workflow.experiment]);
  const runExperiment = useCallback(() => runAction('run-experiment', { experiment: { ...workflow.experiment, command: workflow.experiment?.command || workflow.experiment?.protocol || '' } }, '实验计划已提交，运行状态会同步到本页面。'), [runAction, workflow.experiment]);
  const saveReplication = useCallback(() => patchStage('replication', { replication: workflow.replication || {} }, '复现计划已保存。'), [patchStage, workflow.replication]);
  const skipReplication = useCallback(async () => {
    setBusy(true);
    try { const payload = await workflowRequest<WorkflowEnvelope>(projectId, '/approve', { method: 'POST', body: JSON.stringify({ stage: 'replication', decision: 'skip', note: workflow.replication?.note || '人工确认跳过论文复现。' }) }); const next = commitWorkflow(payload); setNotice('已记录跳过论文复现。'); if (next.activeStage) navigate(`/editor/${projectId}/research/${next.activeStage}`); }
    catch (requestError) { setError(`跳过复现失败：${getErrorMessage(requestError)}`); }
    finally { setBusy(false); }
  }, [commitWorkflow, navigate, projectId, workflow.replication?.note]);
  const prepareWriting = useCallback(() => runAction('handoff-writing', { paperIds: selectedIds, ideas: (workflow.ideas || []).filter((idea) => idea.selected), method: workflow.method || {}, experiment: workflow.experiment || {} }, '研究材料已整理，可以打开论文写作工作台。'), [runAction, selectedIds, workflow.experiment, workflow.ideas, workflow.method]);

  const direction: ResearchDirection = { question: workflow.direction?.question || '', keywords: workflow.direction?.keywords || [], scope: workflow.direction?.scope || '', notes: workflow.direction?.notes || '' };
  const search: SearchRunSummary = { query: workflow.search?.query || '', candidateCount: workflow.search?.count || workflow.papers?.length || 0, selectedCount: selectedIds.length, lastRunAt: workflow.search?.lastRunAt, sources: workflow.search?.sources };
  const replication: ReplicationPlan = { repository: workflow.replication?.repository || '', environment: workflow.replication?.environment || '', dataset: workflow.replication?.dataset || '', note: workflow.replication?.note || '', status: workflow.replication?.status };
  const method: MethodDraft = { title: workflow.method?.title || '', hypothesis: workflow.method?.hypothesis || '', baselines: workflow.method?.baselines || [], ablations: workflow.method?.ablations || [] };
  const experiment: ExperimentPlan = { dataset: workflow.experiment?.dataset || '', datasetVersion: workflow.experiment?.datasetVersion || '', protocol: workflow.experiment?.protocol || workflow.experiment?.command || '', status: workflow.experiment?.status, metrics: workflow.experiment?.metrics || [] };
  const writing: WritingEvidenceSummary = { paperCount: selectedIds.length, innovationCount: selectedIdeas.length, metricCount: experiment.metrics.length, ready: Boolean(workflow.writing?.ready), outline: workflow.writing?.outline || workflow.writing?.evidence?.outline || '' };

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
    if (stage === 'innovation') return <InnovationStage ideas={workflow.ideas || []} selectedIdeaIds={selectedIdeas} selectedPaperCount={selectedIds.length} busy={busy} onGenerate={generateIdeas} onToggleIdea={(ideaId, selected) => updateWorkflow({ ideas: (workflow.ideas || []).map((idea) => idea.id === ideaId ? { ...idea, selected } : idea) })} onSaveSelection={saveIdeaSelection} />;
    if (stage === 'method') return <MethodStage value={method} selectedIdeaCount={selectedIdeas.length} busy={busy} onChange={(next) => updateWorkflow({ method: next })} onGenerate={generateMethod} onSave={saveMethod} />;
    if (stage === 'experiment') return <ExperimentStage value={experiment} busy={busy} onChange={(next) => updateWorkflow({ experiment: { ...next, command: next.protocol } })} onSavePlan={saveExperiment} onSubmitForRun={runExperiment} />;
    return <WritingStage value={writing} busy={busy} onOutlineChange={(outline) => updateWorkflow({ writing: { ...workflow.writing, outline } })} onPrepareWriting={prepareWriting} onOpenEditor={() => navigate(`/editor/${projectId}`)} />;
  };

  const context = <div className="research-context-content"><span className="research-overline">RUN CONTEXT</span><h3>当前上下文</h3><dl><dt>研究问题</dt><dd>{direction.question || '尚未填写'}</dd><dt>硬约束</dt><dd>{policy.venueLevel} · {policy.publicationType === 'Any' ? '期刊/会议' : policy.publicationType === 'journal' ? '期刊' : '会议'} · {policy.yearFrom}-{policy.yearTo}</dd><dt>当前 Skill</dt><dd>{(skills.filter((skill) => (skillBindings[stage] || []).includes(skill.name)).map((skill) => skill.name).join('、')) || '使用阶段默认配置'}</dd><dt>人工控制</dt><dd>AI 辅助，人工确认后才能进入下一阶段</dd></dl></div>;

  if (loading) return <div className={`research-stage-loading${embedded ? ' is-embedded' : ''}`}>正在加载研究流程…</div>;
  const stageIndex = RESEARCH_STAGES.findIndex((item) => item.id === stage);
  return <>
    <ResearchStageLayout projectName={projectName || `项目 ${projectId}`} stage={stage} embedded={embedded} stageStatuses={stageStatuses(workflow)} harnessState={harnessState} busy={busy} context={context} onNavigate={(nextStage) => navigate(`/editor/${projectId}/research/${nextStage}`)} onBackToEditor={() => navigate(`/editor/${projectId}`)} onRefresh={() => void loadWorkflow()} onApprove={workflow.activeStage === stage ? approveStage : undefined} onPrevious={stageIndex > 0 ? () => navigate(`/editor/${projectId}/research/${RESEARCH_STAGES[stageIndex - 1].id}`) : undefined} onNext={stageIndex < RESEARCH_STAGES.length - 1 ? () => navigate(`/editor/${projectId}/research/${RESEARCH_STAGES[stageIndex + 1].id}`) : undefined}>
      {error && <div className="research-callout research-callout-warning"><strong>操作未完成</strong><p>{error}</p></div>}
      {notice && <div className="research-callout"><strong>已更新</strong><p>{notice}</p></div>}
      {renderStage()}
      <button className="research-button research-button-quiet research-reset-button" disabled={busy} onClick={() => void resetWorkflow()} type="button">重置研究流程</button>
    </ResearchStageLayout>
    <input ref={skillInputRef} hidden multiple onChange={handleSkillFiles} type="file" {...({ webkitdirectory: '', directory: '' } as Record<string, unknown>)} />
  </>;
}
