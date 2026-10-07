import { useEffect, useRef, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { LLMConfig } from '../api/client';
import { ResearchStageLayout } from './research/ResearchStageLayout';
import { StageHumanInput } from './research/StageHumanInput';
import {
  isResearchStageId,
  RESEARCH_STAGES,
  type FilterPolicy,
  type ResearchDirection,
  type ResearchStageId,
  type ResearchStageStatus
} from './research/researchStages';
import { DirectionStage } from './research/stages/DirectionStage';
import { SearchStage } from './research/stages/SearchStage';
import { SelectionStage } from './research/stages/SelectionStage';
import { ReplicationStage } from './research/stages/ReplicationStage';
import { InnovationStage } from './research/stages/InnovationStage';
import { MethodStage } from './research/stages/MethodStage';
import { ExperimentStage } from './research/stages/ExperimentStage';
import { WritingStage } from './research/stages/WritingStage';

import { stageStatuses, toResearchView } from './research/workflowViewModel';
import { useResearchSession } from './research/useResearchSession';

export interface ResearchWorkspacePageProps {
  embedded?: boolean;
  onStateChange?: (state: ResearchWorkspaceState) => void;
  llmConfig?: Partial<LLMConfig>;
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

export default function ResearchWorkspacePage({ embedded = false, onStateChange, llmConfig }: ResearchWorkspacePageProps) {
  const { projectId = '', stage: rawStage } = useParams<{ projectId: string; stage?: string }>();
  const navigate = useNavigate();
  const stage: ResearchStageId = isResearchStageId(rawStage) ? rawStage : 'direction';
  const skillInputRef = useRef<HTMLInputElement | null>(null);
  const { workflow, skills, skillBindings, policy, setPolicy, paperFilter, setPaperFilter, projectName, loading, busy, harnessState, error, notice, instructionDrafts, setInstructionDrafts, claimMatrix, refreshCitations, citationRefreshError, stageRoles, experimentRun, replicationRun, evidenceEntries, evidenceLedgerError, writingAgentMode, setWritingAgentMode, loadWorkflow, saveHumanInstructions, patchStage, saveDirection, handleSkillBinding, handleSkillFiles, selectedIds, selectedIdeas, visiblePapers, approveStage, rejectStage, resetWorkflow, updateWorkflow, runSearch, savePaperSelection, generateIdeas, saveIdeaSelection, generateMethod, saveMethod, saveExperiment, runExperiment, createControlledExperimentRun, approveControlledExperimentRun, startControlledExperimentRun, cancelControlledExperimentRun, saveReplication, createControlledReplicationRun, approveControlledReplicationRun, startControlledReplicationRun, cancelControlledReplicationRun, skipReplication, prepareWriting } = useResearchSession(projectId, stage, navigate, llmConfig);
  useEffect(() => { if (rawStage && !isResearchStageId(rawStage)) navigate(`/editor/${projectId}/research/direction`, { replace: true }); }, [navigate, projectId, rawStage]);

  const { direction, search, replication, replicationResult, method, experiment, writing } = toResearchView(workflow, claimMatrix || undefined, experimentRun, replicationRun, evidenceEntries || []);

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
    if (stage === 'selection') return <SelectionStage policy={policy} papers={visiblePapers} selectedPaperIds={selectedIds} filterValue={paperFilter} totalCandidateCount={workflow.papers?.length || 0} busy={busy} onPolicyChange={setPolicy} onSavePolicy={() => patchStage('selection', { policy }, '筛选规则已保存。')} onFilterValueChange={setPaperFilter} onReviewChange={(review) => updateWorkflow({ papers: (workflow.papers || []).map((paper) => paper.id === review.paperId ? { ...paper, selected: review.decision === 'include', humanReview: review } : paper) })} onSaveSelection={savePaperSelection} onOpenSearchStage={() => navigate(`/editor/${projectId}/research/search`)} />;
    if (stage === 'replication') {
       const replicationStage = workflow.stages?.find((item) => item.id === 'replication');
       const stageApproved = replicationStage?.status === 'approved';
       return <ReplicationStage selectedPapers={(workflow.papers || []).filter((paper) => selectedIds.includes(paper.id))} value={replication} busy={busy} onChange={(next) => updateWorkflow({ replication: next })} onSavePlan={saveReplication} stageApproved={stageApproved} stageStatus={replicationStage?.status} run={replicationRun} onSkip={skipReplication} onCreateRun={createControlledReplicationRun} onApproveRun={approveControlledReplicationRun} onStartRun={startControlledReplicationRun} onCancelRun={cancelControlledReplicationRun} />;
    }
     if (stage === 'innovation') return <InnovationStage ideas={workflow.ideas || []} comparison={workflow.ideaComparison || []} humanDirection={workflow.ideaHumanDirection} caveats={workflow.ideaCaveats} selectedIdeaIds={selectedIdeas} selectedPaperCount={selectedIds.length} busy={busy} onGenerate={generateIdeas} onToggleIdea={(ideaId, selected) => updateWorkflow({ ideas: (workflow.ideas || []).map((idea) => idea.id === ideaId ? { ...idea, selected } : idea) })} onConditionChange={(ideaId, condition) => updateWorkflow({ ideas: (workflow.ideas || []).map((idea) => idea.id === ideaId ? { ...idea, humanReview: { falsificationCondition: condition } } : idea) })} onSaveSelection={saveIdeaSelection} />;
    if (stage === 'method') return <MethodStage value={method} replicationResult={replicationResult} candidates={workflow.methodCandidates || []} selectedIdeaCount={selectedIdeas.length} busy={busy} onChange={(next) => updateWorkflow({ method: next })} onGenerate={generateMethod} onSave={saveMethod} />;
    if (stage === 'experiment') return <ExperimentStage value={experiment} run={experimentRun} busy={busy} onChange={(next) => updateWorkflow({ experiment: { ...next, command: next.protocol } })} onSavePlan={saveExperiment} onSubmitForRun={runExperiment} onCreateRun={createControlledExperimentRun} onApproveRun={approveControlledExperimentRun} onStartRun={startControlledExperimentRun} onCancelRun={cancelControlledExperimentRun} />;
    return <WritingStage projectId={projectId} onCitationsSaved={refreshCitations} citationRefreshError={citationRefreshError} value={writing} busy={busy} agentMode={writingAgentMode} delegation={workflow.task?.delegation} onAgentModeChange={setWritingAgentMode} onOutlineChange={(outline) => updateWorkflow({ writing: { ...workflow.writing, outline } })} onPrepareWriting={prepareWriting} onOpenEditor={() => navigate(`/editor/${projectId}${workflow.writing?.briefPath ? `?open=${encodeURIComponent(workflow.writing.briefPath)}` : ''}`)} />;
  };

  const context = <div className="research-context-content"><span className="research-overline">RUN CONTEXT</span><h3>当前上下文</h3><dl><dt>研究问题</dt><dd>{direction.question || '尚未填写'}</dd><dt>硬约束</dt><dd>{policy.venueLevel} · {policy.publicationType === 'Any' ? '期刊/会议' : policy.publicationType === 'journal' ? '期刊' : '会议'} · {policy.yearFrom}-{policy.yearTo}</dd><dt>当前 Skill</dt><dd>{(skills.filter((skill) => (skillBindings[stage] || []).includes(skill.name)).map((skill) => skill.name).join('、')) || '使用阶段默认配置'}</dd><dt>阶段任务</dt><dd>{workflow.task?.status === 'awaiting_approval' ? '等待人工确认' : workflow.task?.status === 'failed' ? '执行失败，可重试' : workflow.task?.status || '尚未运行'}</dd><dt>Harness</dt><dd>{workflow.task?.harness?.runId || workflow.task?.harness?.adapter || '未创建运行'}</dd><dt>验证</dt><dd>{workflow.task?.validation?.ok === false ? '需要处理' : workflow.task?.validation?.warnings?.length ? '通过但有提示' : '通过'}</dd><dt>人工控制</dt><dd>AI 辅助，人工确认后才能进入下一阶段</dd></dl>{workflow.task?.validation?.warnings?.length ? <div className="research-callout research-callout-warning"><strong>验证提示</strong><ul>{workflow.task.validation.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></div> : null}{workflow.task?.error?.message ? <div className="research-callout research-callout-warning"><strong>任务失败</strong><p>{workflow.task.error.message}</p></div> : null}{workflow.sourceFailures?.length ? <div className="research-callout research-callout-warning"><strong>来源提示</strong><ul>{workflow.sourceFailures.map((failure, index) => <li key={`${failure.source}-${index}`}>{failure.source}: {failure.message || '检索失败'}</li>)}</ul></div> : null}</div>;

  if (loading) return <div className={`research-stage-loading${embedded ? ' is-embedded' : ''}`}>正在加载研究流程…</div>;
  const stageIndex = RESEARCH_STAGES.findIndex((item) => item.id === stage);
  return <>
    <ResearchStageLayout projectId={projectId} projectName={projectName || `项目 ${projectId}`} stage={stage} embedded={embedded} stageStatuses={stageStatuses(workflow)} harnessState={harnessState} roleSummaries={stageRoles.map((role) => ({ id: role.id, authority: role.authority, capabilities: role.capabilities, skills: role.skills }))} busy={busy} context={context} onNavigate={(nextStage) => navigate(`/editor/${projectId}/research/${nextStage}`)} onBackToEditor={() => navigate(`/editor/${projectId}`)} onRefresh={() => void loadWorkflow()} onApprove={workflow.activeStage === stage && workflow.status !== 'blocked' && workflow.status !== 'completed' ? approveStage : undefined} onReject={workflow.activeStage === stage && workflow.status !== 'blocked' && workflow.status !== 'completed' ? rejectStage : undefined} onPrevious={stageIndex > 0 ? () => navigate(`/editor/${projectId}/research/${RESEARCH_STAGES[stageIndex - 1].id}`) : undefined} onNext={stageIndex < RESEARCH_STAGES.length - 1 ? () => navigate(`/editor/${projectId}/research/${RESEARCH_STAGES[stageIndex + 1].id}`) : undefined}>
      <div className="research-page-stack">
        {workflow.status === 'blocked' && workflow.activeStage === stage && <div className="research-callout research-callout-warning" role="status"><strong>阶段已拒绝，等待修订</strong><p>修改并保存当前阶段，或重新运行分析后再人工确认。已保存内容与拒绝记录保留。</p></div>}
        {error && <div className="research-callout research-callout-warning" role="alert"><strong>操作未完成</strong><p>{error}</p><button className="research-button research-button-quiet" onClick={() => void loadWorkflow()} disabled={busy}>重新读取状态</button></div>}
        {notice && <div className="research-callout" role="status"><p>{notice}</p></div>}
        {evidenceLedgerError && (stage === 'replication' || stage === 'method' || stage === 'writing') && <div className="research-callout research-callout-warning" role="alert"><strong>Evidence 状态暂不可用</strong><p>{evidenceLedgerError} 复现 Run 与产物均不可显示为已确认；可刷新页面重试。</p></div>}
        {stage !== 'writing' && <StageHumanInput stage={stage} value={instructionDrafts[stage] ?? workflow.humanInstructions?.[stage] ?? ''} savedValue={workflow.humanInstructions?.[stage] || ''} busy={busy} onChange={(value) => setInstructionDrafts((current) => ({ ...current, [stage]: value }))} onSave={() => void saveHumanInstructions()} />}
        {!error && workflow.task?.status === 'failed' && <div className="research-callout research-callout-warning" role="alert"><strong>任务执行失败</strong><p>{workflow.task.error?.message || '请检查配置后重试。'}</p><button className="research-button research-button-quiet" onClick={() => navigate(`/project/${projectId}/tasks`)}>查看任务与重试</button></div>}
        {workflow.sourceFailures?.length ? <div className="research-callout research-callout-warning" role="status"><strong>部分来源未能完成检索</strong><ul>{workflow.sourceFailures.map((failure, index) => <li key={index}>{failure.source}：{failure.message || '检索失败'}</li>)}</ul></div> : null}
        {renderStage()}
        <details className="research-maintenance"><summary>研究流程管理</summary><p>重置会清空已保存的阶段数据，请谨慎操作。</p><button className="research-button research-button-quiet research-reset-button" disabled={busy} onClick={() => void resetWorkflow()} type="button">重置研究流程</button></details>
      </div>
    </ResearchStageLayout>
    <input ref={skillInputRef} hidden multiple onChange={handleSkillFiles} type="file" {...({ webkitdirectory: '', directory: '' } as Record<string, unknown>)} />
  </>;
}
