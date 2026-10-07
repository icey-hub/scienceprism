import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { NavigateFunction } from 'react-router-dom';
import {
  getResearchWorkflowSkills,
  updateResearchWorkflowSkillBindings,
  workflowSession
} from '../../api/workflowAdapter';
import { getEvidenceClaimMatrix, type ClaimEvidenceMatrix } from '../../api/evidenceAdapter';
import { getAgentRoles, getAgentRuntime, getEvidenceLedgerSnapshot, type AgentRoleSummary, type EvidenceRecord, type LLMConfig } from '../../api/client';
import { listProjects, uploadFiles } from '../../api/projectAdapter';
import {
  cancelExperimentRun,
  createExperimentRun as createProjectExperimentRun,
  createReplicationExperimentRun,
  decideExperimentRun,
  listExperimentRuns,
  startExperimentRun,
  type ExperimentRun,
  type ReplicationRunPlan
} from '../../api/experimentAdapter';
import { fromHarnessResearchStage, toHarnessResearchStage, type FilterPolicy, type ProjectSkill, type ResearchStageId, type SkillBindings } from './researchStages';
import { DEFAULT_POLICY, EMPTY_WORKFLOW, mergeWorkflow, selectedPaperIds, selectedIdeaIds, type UiWorkflow, type WorkflowEnvelope } from './workflowViewModel';

function getErrorMessage(error: unknown) { return error instanceof Error ? error.message : String(error); }

class StaleProjectRequest extends Error {
  constructor() {
    super('研究项目已切换，丢弃旧请求结果。');
    this.name = 'StaleProjectRequest';
  }
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

export function useResearchSession(projectId: string, stage: ResearchStageId, navigate: NavigateFunction, llmConfig?: Partial<LLMConfig>) {
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
  const [instructionDrafts, setInstructionDrafts] = useState<Partial<Record<ResearchStageId, string>>>({});
  const [claimMatrix, setClaimMatrix] = useState<ClaimEvidenceMatrix | null>(null);
  const [citationRefreshError, setCitationRefreshError] = useState('');
  const [stageRoles, setStageRoles] = useState<AgentRoleSummary[]>([]);
  const [experimentRun, setExperimentRun] = useState<ExperimentRun | null>(null);
  const [replicationRun, setReplicationRun] = useState<ExperimentRun | null>(null);
  const [evidenceEntries, setEvidenceEntries] = useState<EvidenceRecord[] | null>(null);
  const [evidenceLedgerError, setEvidenceLedgerError] = useState('');
  const [writingAgentMode, setWritingAgentMode] = useState<'single-agent' | 'multi-agent'>('single-agent');
  const projectEpoch = useRef(0);
  const activeProjectId = useRef(projectId);
  activeProjectId.current = projectId;
  const isCurrentProject = useCallback((epoch: number) => activeProjectId.current === projectId && projectEpoch.current === epoch, [projectId]);
  const assertCurrentProject = useCallback((epoch: number) => {
    if (!isCurrentProject(epoch)) throw new StaleProjectRequest();
  }, [isCurrentProject]);

  const refreshSkills = useCallback(async () => {
    const epoch = projectEpoch.current;
    const payload = await getResearchWorkflowSkills(projectId);
    if (!isCurrentProject(epoch)) return;
    setSkills(mapSkills(payload.skills || []));
    setSkillBindings(mapBindings(payload.bindings || {}));
  }, [isCurrentProject, projectId]);

  const refreshClaimMatrix = useCallback(async () => {
    if (!projectId) return;
    const epoch = projectEpoch.current;
    const payload = await getEvidenceClaimMatrix(projectId);
    if (!isCurrentProject(epoch)) return;
    setClaimMatrix(payload.matrix || null);
  }, [isCurrentProject, projectId]);

  const refreshCitations = useCallback(() => {
    const epoch = projectEpoch.current;
    setCitationRefreshError('');
    void refreshClaimMatrix().catch((requestError) => {
      if (isCurrentProject(epoch)) setCitationRefreshError(`引用已保存，但证据矩阵刷新失败：${getErrorMessage(requestError)}。请重新读取证据矩阵。`);
    });
  }, [isCurrentProject, refreshClaimMatrix]);

  const refreshExperimentRuns = useCallback(async () => {
    if (!projectId) return;
    const epoch = projectEpoch.current;
    const [runResult, ledgerResult] = await Promise.allSettled([
      listExperimentRuns(projectId, { limit: '50' }),
      getEvidenceLedgerSnapshot(projectId)
    ]);
    if (runResult.status === 'rejected') throw runResult.reason;
    if (projectEpoch.current !== epoch) return;
    const runs = [...(runResult.value.runs || [])].sort((left, right) => {
      const leftTime = Date.parse(left.updatedAt || left.createdAt || '') || 0;
      const rightTime = Date.parse(right.updatedAt || right.createdAt || '') || 0;
      return rightTime - leftTime;
    });
    setExperimentRun(runs.find((run) => !run.manifest?.replication) || null);
    setReplicationRun(runs.find((run) => Boolean(run.manifest?.replication)) || null);
    if (ledgerResult.status === 'fulfilled') {
      setEvidenceEntries(ledgerResult.value.ledger.entries || []);
      setEvidenceLedgerError('');
    } else {
      setEvidenceEntries(null);
      setEvidenceLedgerError(`Evidence Ledger 暂时无法读取：${getErrorMessage(ledgerResult.reason)}`);
    }
  }, [projectId]);

  const loadWorkflow = useCallback(async () => {
    if (!projectId) return;
    const epoch = projectEpoch.current;
    setLoading(true); setError('');
    try {
      let payload: WorkflowEnvelope;
      try { payload = await workflowSession.load<WorkflowEnvelope>(projectId); }
      catch (requestError) {
        if (!getErrorMessage(requestError).toLowerCase().includes('workflow')) throw requestError;
        payload = await workflowSession.initialize<WorkflowEnvelope>(projectId);
      }
      if (projectEpoch.current !== epoch) return;
      const next = mergeWorkflow(payload);
      setWorkflow(next); setPolicy({ ...DEFAULT_POLICY, ...(next.search?.policy || {}) });
      const [skillResult, projectResult, experimentResult] = await Promise.allSettled([refreshSkills(), listProjects(), refreshExperimentRuns()]);
      if (projectEpoch.current !== epoch) return;
      if (skillResult.status === 'rejected') setSkills([]);
      if (projectResult.status === 'fulfilled') setProjectName(projectResult.value.projects?.find((item) => item.id === projectId)?.name || next.projectName || `项目 ${projectId}`);
      else setProjectName(next.projectName || `项目 ${projectId}`);
      if (experimentResult.status === 'rejected') { setExperimentRun(null); setReplicationRun(null); }
    } catch (requestError) {
      if (projectEpoch.current === epoch) setError(`研究流程加载失败：${getErrorMessage(requestError)}`);
    } finally {
      if (projectEpoch.current === epoch) setLoading(false);
    }
  }, [projectId, refreshExperimentRuns, refreshSkills]);

  useEffect(() => {
    projectEpoch.current += 1;
    setWorkflow(EMPTY_WORKFLOW);
    setInstructionDrafts({});
    setExperimentRun(null);
    setReplicationRun(null);
    setEvidenceEntries(null);
    setEvidenceLedgerError('');
    setClaimMatrix(null);
  }, [projectId]);
  useEffect(() => { void loadWorkflow(); }, [loadWorkflow]);
  useEffect(() => {
    setWritingAgentMode(workflow.task?.delegation?.mode === 'multi-agent' ? 'multi-agent' : 'single-agent');
  }, [projectId, workflow.task?.id]);
  useEffect(() => {
    const activeRuns = [experimentRun, replicationRun].filter((run): run is ExperimentRun => Boolean(run && ['awaiting_approval', 'approved', 'running'].includes(run.status)));
    if (activeRuns.length === 0) return undefined;
    const timer = window.setInterval(() => { void refreshExperimentRuns().catch((requestError) => setError(`运行状态刷新失败：${getErrorMessage(requestError)}`)); }, 2000);
    return () => window.clearInterval(timer);
  }, [experimentRun, refreshExperimentRuns, replicationRun]);
  useEffect(() => {
    getAgentRuntime().then((value) => setHarnessState(value.harnessConfigured === true ? 'ready' : 'unavailable')).catch(() => setHarnessState('unavailable'));
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

  const persistHumanInstructions = useCallback(async () => {
    const saved = workflow.humanInstructions?.[stage] || '';
    const text = (instructionDrafts[stage] ?? saved).trim();
    if (text === saved) return workflow.version;
    const payload = await workflowSession.saveInstructions<WorkflowEnvelope>(projectId, stage, text, { expectedVersion: workflow.version, idempotencyKey: newIdempotencyKey() });
    const next = mergeWorkflow(payload);
    // Saving suggestions must preserve unsaved stage forms and selections.
    setWorkflow((current) => ({ ...current, version: next.version, humanInstructions: next.humanInstructions }));
    setInstructionDrafts((current) => { const drafts = { ...current }; delete drafts[stage]; return drafts; });
    return next.version;
  }, [instructionDrafts, projectId, stage, workflow.humanInstructions, workflow.version]);

  const saveHumanInstructions = useCallback(async () => {
    setBusy(true); setError(''); setNotice('');
    try { await persistHumanInstructions(); setNotice('人工建议已保存，将用于后续 AI 分析。'); }
    catch (requestError) { setError(`建议保存失败：${getErrorMessage(requestError)}`); }
    finally { setBusy(false); }
  }, [persistHumanInstructions]);

  const runAction = useCallback(async (action: string, body: Record<string, unknown>, successMessage: string) => {
    setBusy(true); setError(''); setNotice('');
    try {
      const expectedVersion = await persistHumanInstructions();
      const payload = await workflowSession.run<WorkflowEnvelope>(projectId, action, { ...body, llmConfig }, { expectedVersion, idempotencyKey: newIdempotencyKey() });
      const next = commitWorkflow(payload);
      if (next.task?.status === 'failed') {
        setError(next.task.error?.message || '任务执行失败，请检查配置后重试。');
        return null;
      }
      setNotice(successMessage); return next;
    } catch (requestError) { setError(`操作失败：${getErrorMessage(requestError)}`); return null; }
    finally { setBusy(false); }
  }, [commitWorkflow, llmConfig, persistHumanInstructions, projectId]);

  const patchStage = useCallback(async (stageId: ResearchStageId, data: Record<string, unknown>, successMessage: string) => {
    setBusy(true); setError('');
    try {
      const expectedVersion = await persistHumanInstructions();
      const payload = await workflowSession.saveStage<WorkflowEnvelope>(projectId, stageId, data, { expectedVersion, idempotencyKey: newIdempotencyKey() });
      commitWorkflow(payload); setNotice(successMessage);
    } catch (requestError) { setError(`保存失败：${getErrorMessage(requestError)}`); }
    finally { setBusy(false); }
  }, [commitWorkflow, persistHumanInstructions, projectId]);

  const saveDirection = useCallback(async () => {
    const direction = { question: workflow.direction?.question?.trim() || '', keywords: workflow.direction?.keywords || [], scope: workflow.direction?.scope?.trim() || '', notes: workflow.direction?.notes?.trim() || '', falsificationCondition: workflow.direction?.falsificationCondition?.trim() || '' };
    setBusy(true); setError('');
    try { const expectedVersion = await persistHumanInstructions(); const payload = await workflowSession.saveDirection<WorkflowEnvelope>(projectId, direction, { expectedVersion, idempotencyKey: newIdempotencyKey() }); commitWorkflow(payload); setNotice('研究方向已保存，等待人工确认。'); }
    catch (requestError) { setError(`方向保存失败：${getErrorMessage(requestError)}`); }
    finally { setBusy(false); }
  }, [commitWorkflow, persistHumanInstructions, projectId, workflow.direction]);

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

  const decideStage = useCallback(async (decision: 'approve' | 'reject') => {
    const note = decision === 'reject' ? window.prompt('请说明拒绝原因，保存后可修改当前阶段：', '') : undefined;
    if (decision === 'reject' && note === null) return;
    if (decision === 'reject' && !note?.trim()) { setError('拒绝阶段必须填写原因。'); return; }
    setBusy(true); setError('');
    try {
      const expectedVersion = await persistHumanInstructions();
      const payload = await workflowSession.approve<WorkflowEnvelope>(projectId, stage, decision === 'reject' ? { decision, note: note?.trim() } : {}, { expectedVersion, idempotencyKey: newIdempotencyKey() });
      const next = mergeWorkflow(payload);
      if (decision === 'reject') {
        // A decision changes status, not the researcher's unsaved form edits.
        setWorkflow((current) => ({ ...current, version: next.version, status: next.status, stages: next.stages, task: next.task }));
        setNotice('已记录拒绝，请修改当前阶段后再确认。');
      } else {
        commitWorkflow(payload); setNotice('当前阶段已确认。');
        if (next.activeStage && next.activeStage !== stage) navigate(`/editor/${projectId}/research/${next.activeStage}`);
      }
    } catch (requestError) { setError(`审批失败：${getErrorMessage(requestError)}`); }
    finally { setBusy(false); }
  }, [commitWorkflow, navigate, persistHumanInstructions, projectId, stage]);

  const approveStage = useCallback(() => decideStage('approve'), [decideStage]);
  const rejectStage = useCallback(() => decideStage('reject'), [decideStage]);

  const resetWorkflow = useCallback(async () => {
    if (!window.confirm('确定要重置本项目的研究流程吗？已保存的阶段数据可能会被清空。')) return; setBusy(true);
    try { await workflowSession.reset(projectId, { expectedVersion: workflow.version, idempotencyKey: newIdempotencyKey() }); setInstructionDrafts({}); await loadWorkflow(); navigate(`/editor/${projectId}/research/direction`); setNotice('研究流程已重置。'); }
    catch (requestError) { setError(`重置失败：${getErrorMessage(requestError)}`); }
    finally { setBusy(false); }
  }, [loadWorkflow, navigate, projectId, workflow.version]);

  const updateWorkflow = useCallback((patch: Partial<UiWorkflow>) => setWorkflow((current) => mergeWorkflow({ ...current, ...patch })), []);
  const runSearch = useCallback(() => runAction('search', { query: workflow.search?.query || '', direction: workflow.direction || {}, policy }, '检索任务已提交，论文结果会回填到候选列表。'), [policy, runAction, workflow.direction, workflow.search?.query]);
  const savePaperSelection = useCallback(() => runAction('select-papers', {
    actor: 'human', paperIds: selectedIds,
    reviews: (workflow.papers || []).flatMap((paper) => paper.humanReview ? [{
      paperId: paper.id, decision: paper.humanReview.decision,
      reason: paper.humanReview.reason, criterion: paper.humanReview.criterion
    }] : [])
  }, '人工筛选决定与理由已保存，请审阅后确认阶段。'), [runAction, selectedIds, workflow.papers]);
  const generateIdeas = useCallback(() => runAction('generate-ideas', { paperIds: selectedIds, direction: workflow.direction || {} }, '创新点候选已生成，请人工比较并选择。'), [runAction, selectedIds, workflow.direction]);
  const saveIdeaSelection = useCallback(async () => {
    setBusy(true); setError(''); setNotice('');
    try {
      const expectedVersion = await persistHumanInstructions();
      const payload = await workflowSession.run<WorkflowEnvelope>(projectId, 'select-ideas', {
        actor: 'human', ideaIds: selectedIdeas,
        reviews: (workflow.ideas || []).flatMap(idea => idea.humanReview ? [{ ideaId: idea.id, falsificationCondition: idea.humanReview.falsificationCondition }] : [])
      }, { expectedVersion, idempotencyKey: newIdempotencyKey() });
      commitWorkflow(payload);
      setNotice(selectedIdeas.length ? '已保存创新点选择与人工条件，请审阅后确认阶段。' : '已保存创新点人工条件，当前未选择候选，请选择后再确认阶段。');
    } catch (requestError) { setError(`保存创新点失败：${getErrorMessage(requestError)}`); }
    finally { setBusy(false); }
  }, [commitWorkflow, persistHumanInstructions, projectId, selectedIdeas, workflow.ideas]);
  const generateMethod = useCallback(() => runAction('generate-method', { ideaIds: selectedIdeas }, '方法草案已生成，请补充假设与基线。'), [runAction, selectedIdeas]);
  const saveMethod = useCallback(() => runAction('save-method', { method: workflow.method || {} }, '方法草案已保存。'), [runAction, workflow.method]);
  const saveExperiment = useCallback(() => patchStage('experiment', { ...workflow.experiment, command: workflow.experiment?.command || workflow.experiment?.protocol || '' }, '实验计划已保存。'), [patchStage, workflow.experiment]);
  const runExperiment = useCallback(() => runAction('run-experiment', { experiment: { ...workflow.experiment, command: workflow.experiment?.command || workflow.experiment?.protocol || '' } }, '实验计划已提交，运行状态会同步到本页面。'), [runAction, workflow.experiment]);
  const createControlledExperimentRun = useCallback(async () => {
    setBusy(true); setError(''); setNotice('');
    try {
      await persistHumanInstructions();
      const result = await createProjectExperimentRun(projectId, { ...workflow.experiment, command: workflow.experiment?.command || workflow.experiment?.protocol || '' });
      setExperimentRun(result.run); setNotice('受控 Run 已创建，等待人工批准。');
    } catch (requestError) { setError(`创建运行失败：${getErrorMessage(requestError)}`); }
    finally { setBusy(false); }
  }, [persistHumanInstructions, projectId, workflow.experiment]);
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
  }, [experimentRun, projectId]);
  const cancelControlledExperimentRun = useCallback(async () => {
    if (!experimentRun) return;
    setBusy(true); setError('');
    try { const result = await cancelExperimentRun(projectId, experimentRun.id); setExperimentRun(result.run); setNotice('Run 已取消。'); }
    catch (requestError) { setError(`取消运行失败：${getErrorMessage(requestError)}`); }
    finally { setBusy(false); }
  }, [experimentRun, projectId]);
  const saveReplication = useCallback(() => patchStage('replication', { replication: workflow.replication || {} }, '复现计划已保存。'), [patchStage, workflow.replication]);
  const replicationStageApproved = workflow.stages?.some((item) => item.id === 'replication' && item.status === 'approved') === true;
  const replicationExecution = workflow.replication?.execution;
  const createControlledReplicationRun = useCallback(async () => {
    if (!replicationStageApproved) { setError('请先人工确认复现阶段，再创建受控 Run。'); return; }
    if (!replicationExecution?.entrypoint?.trim()) { setError('请先填写项目内的执行入口。'); return; }
    if (!workflow.replication?.datasetVersion?.trim() || !workflow.replication?.note?.trim()) { setError('创建复现 Run 前必须填写数据版本和复现备注。'); return; }
    setBusy(true); setError(''); setNotice('');
    try {
      const plan: ReplicationRunPlan = {
        execution: { adapter: replicationExecution.adapter, entrypoint: replicationExecution.entrypoint.trim(), args: replicationExecution.args || [] },
        ...(workflow.replication.parameters ? { parameters: workflow.replication.parameters } : {}),
        ...(workflow.replication.seed ? { seed: workflow.replication.seed } : {}),
        ...(workflow.replication.resources ? { resources: workflow.replication.resources } : {}),
        ...(workflow.replication.artifacts?.length ? { artifacts: workflow.replication.artifacts } : {})
      };
      const result = await createReplicationExperimentRun(projectId, Number(workflow.version), plan);
      setReplicationRun(result.run); setNotice('复现 Run 已创建，等待人工批准；来源与版本由服务端快照生成。');
    } catch (requestError) { setError(`创建复现 Run 失败：${getErrorMessage(requestError)}`); }
    finally { setBusy(false); }
  }, [projectId, replicationExecution, replicationStageApproved, workflow.replication, workflow.version]);
  const approveControlledReplicationRun = useCallback(async () => {
    if (!replicationRun) return;
    setBusy(true); setError('');
    try { const result = await decideExperimentRun(projectId, replicationRun.id, 'approve', '人工批准论文复现受控运行。'); setReplicationRun(result.run); setNotice('复现 Run 已批准，可以启动隔离执行。'); }
    catch (requestError) { setError(`批准复现 Run 失败：${getErrorMessage(requestError)}`); }
    finally { setBusy(false); }
  }, [projectId, replicationRun]);
  const startControlledReplicationRun = useCallback(async () => {
    if (!replicationRun) return;
    setBusy(true); setError('');
    try { const result = await startExperimentRun(projectId, replicationRun.id); setReplicationRun(result.run); setNotice('复现 Run 已启动，完成后请人工核对产物和指标。'); }
    catch (requestError) { setError(`启动复现 Run 失败：${getErrorMessage(requestError)}`); }
    finally { setBusy(false); }
  }, [projectId, replicationRun]);
  const cancelControlledReplicationRun = useCallback(async () => {
    if (!replicationRun) return;
    setBusy(true); setError('');
    try { const result = await cancelExperimentRun(projectId, replicationRun.id); setReplicationRun(result.run); setNotice('复现 Run 已取消，未将其视为成功证据。'); }
    catch (requestError) { setError(`取消复现 Run 失败：${getErrorMessage(requestError)}`); }
    finally { setBusy(false); }
  }, [projectId, replicationRun]);
  const skipReplication = useCallback(async () => {
    const note = workflow.replication?.note?.trim() || '';
    setError(''); setNotice('');
    if (!note) { setError('请填写复现备注或跳过原因，再跳过复现。'); return; }
    setBusy(true);
    try { const expectedVersion = await persistHumanInstructions(); const payload = await workflowSession.approve<WorkflowEnvelope>(projectId, 'replication', { decision: 'skip', note }, { expectedVersion, idempotencyKey: newIdempotencyKey() }); const next = commitWorkflow(payload); setNotice('已记录跳过论文复现。'); if (next.activeStage) navigate(`/editor/${projectId}/research/${next.activeStage}`); }
    catch (requestError) { setError(`跳过复现失败：${getErrorMessage(requestError)}`); }
    finally { setBusy(false); }
  }, [commitWorkflow, navigate, persistHumanInstructions, projectId, workflow.replication?.note]);
  const prepareWriting = useCallback(async () => {
    const completedRun = experimentRun?.status === 'completed' ? experimentRun : null;
    const experiment = completedRun ? { ...workflow.experiment, status: completedRun.status, metrics: completedRun.metrics } : workflow.experiment || {};
    const next = await runAction('handoff-writing', {
      paperIds: selectedIds,
      ideas: (workflow.ideas || []).filter((idea) => idea.selected),
      method: workflow.method || {},
      experiment,
      ...(replicationRun ? { replicationRunId: replicationRun.id } : {}),
      agentMode: writingAgentMode
    }, writingAgentMode === 'multi-agent' ? '子 Agent 审查已完成，请检查审查记录与写作材料。' : '研究材料已整理，可以打开论文写作工作台。');
    const briefPath = next?.writing?.briefPath;
    if (writingAgentMode === 'single-agent' && next?.writing?.ready && briefPath) navigate(`/editor/${projectId}?open=${encodeURIComponent(briefPath)}`);
  }, [experimentRun, navigate, projectId, replicationRun, runAction, selectedIds, workflow.experiment, workflow.ideas, workflow.method, writingAgentMode]);

  return { workflow, skills, skillBindings, policy, setPolicy, paperFilter, setPaperFilter, projectName, loading, busy, harnessState, error, notice, instructionDrafts, setInstructionDrafts, claimMatrix, refreshCitations, citationRefreshError, stageRoles, experimentRun, replicationRun, evidenceEntries, evidenceLedgerError, writingAgentMode, setWritingAgentMode, loadWorkflow, saveHumanInstructions, patchStage, saveDirection, handleSkillBinding, handleSkillFiles, selectedIds, selectedIdeas, visiblePapers, approveStage, rejectStage, resetWorkflow, updateWorkflow, runSearch, savePaperSelection, generateIdeas, saveIdeaSelection, generateMethod, saveMethod, saveExperiment, runExperiment, createControlledExperimentRun, approveControlledExperimentRun, startControlledExperimentRun, cancelControlledExperimentRun, saveReplication, createControlledReplicationRun, approveControlledReplicationRun, startControlledReplicationRun, cancelControlledReplicationRun, skipReplication, prepareWriting };
}
