import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { getProjectDashboard, getProjectTask, cancelProjectTask, retryProjectTask, type ProjectTask } from '../../api/projectAdapter';
import { getHarnessRun, startHarnessRun, pauseHarnessRun, resumeHarnessRun, cancelHarnessRun, replayHarnessRun, recoverHarnessRun, decideHarnessRun, type HarnessRun } from '../../api/harnessAdapter';
import { applyHarnessRunPatches } from '../../api/assistantAdapter';
import { getExperimentRun, type ExperimentRun } from '../../api/experimentAdapter';
import { ProjectWorkspaceFrame } from '../components/ProjectWorkspaceFrame';
import { RuntimeEventsView, RuntimeToolCalls } from './RuntimeEventsView';
import { EvidenceSourceLocation } from './ClaimMaterials';
import { DecisionStatus } from '../components/DecisionStatus';
import { RunDelegation } from './RunDelegation';
import { ErrorState, LoadingState } from '../components/AsyncState';

const TABS = { summary: '概览', session: '会话', execution: '执行', evidence: '证据', artifacts: '产物', logs: '日志' } as const;
type Tab = keyof typeof TABS;
const pretty = (value: unknown) => JSON.stringify(value, null, 2) || '未记录';
export { taskHref } from './taskLocation';
import { taskHref } from './taskLocation';

export default function TaskDetailPage() {
  const { projectId = '', taskId = '' } = useParams();
  return <TaskDetail key={`${projectId}:${taskId}`} projectId={projectId} taskId={taskId} />;
}
function TaskDetail({ projectId, taskId }: { projectId: string; taskId: string }) {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const candidate = params.get('tab') || 'summary';
  const tab: Tab = Object.prototype.hasOwnProperty.call(TABS, candidate) ? candidate as Tab : 'summary';
  const [task, setTask] = useState<ProjectTask | null>(null);
  const [run, setRun] = useState<HarnessRun | null>(null);
  const [experiment, setExperiment] = useState<ExperimentRun | null>(null);
  const [projectName, setProjectName] = useState('');
  const [error, setError] = useState('');
  const [sourceError, setSourceError] = useState('');
  const [busy, setBusy] = useState(false);
  const [paths, setPaths] = useState<string[]>([]);
  const load = useCallback(async () => {
    const result = await getProjectTask(projectId, taskId);
    setTask(result.task); setError(''); setSourceError('');
    const reference = result.task.metadata;
    const harnessId = result.task.kind === 'harness' ? reference?.runId : reference?.harnessRunId;
    try {
      if (typeof harnessId === 'string') setRun((await getHarnessRun(projectId, harnessId)).run);
      if (result.task.kind === 'experiment-run' && typeof reference?.runId === 'string') setExperiment((await getExperimentRun(projectId, reference.runId)).run);
    } catch (error) { setSourceError(`源记录不可读取：${String(error)}`); }
  }, [projectId, taskId]);
  useEffect(() => { void load().catch(error => setError(String(error))); }, [load]);
  useEffect(() => { let active = true; getProjectDashboard(projectId).then(result => { if (active) setProjectName(result.dashboard.project.name); }).catch(() => {}); return () => { active = false; }; }, [projectId]);
  useEffect(() => {
    if (!task || !['running', 'queued'].includes(task.status)) return;
    const timer = window.setInterval(() => { void load().catch(error => setError(String(error))); }, 2500);
    return () => window.clearInterval(timer);
  }, [task?.status, load]);
  const action = async (work: () => Promise<unknown>) => { setBusy(true); setError(''); try { await work(); await load(); } catch (error) { setError(String(error)); } finally { setBusy(false); } };
  const stageHref = task?.stage ? `/editor/${encodeURIComponent(projectId)}/research/${task.stage === 'ideation' ? 'innovation' : task.stage}` : null;
  return <ProjectWorkspaceFrame projectId={projectId} projectName={projectName} active="activity" title="任务详情">
    <Link className="hub-text-link" to={`/project/${encodeURIComponent(projectId)}/tasks`}>← 全部任务</Link>
    {error && <ErrorState message={error} onRetry={() => void load().catch(error => setError(String(error)))} />}
    {!task && !error && <LoadingState label="正在读取任务及源记录…" />}
    {task && <>
      <div className="hub-page-heading task-detail-heading"><div><h2>{task.title}</h2><p><code>{task.id}</code> · {task.kind}</p></div><DecisionStatus status={task.status} /></div>
      <div className="task-detail-actions">
        {task.kind === 'paper-download' && typeof task.metadata?.paperId === 'string' && <Link className="hub-small-button" to={`/project/${encodeURIComponent(projectId)}/papers/${encodeURIComponent(task.metadata.paperId)}/read`}>打开 PDF 阅读</Link>}
        {stageHref && <Link className="hub-small-button is-quiet" to={stageHref}>打开相关工作</Link>}
        {run && !run.archived && run.kind !== 'codex-worker' ? <>
          {run.status === 'created' && <button className="hub-small-button" disabled={busy} onClick={() => void action(() => startHarnessRun(projectId, run.id))}>启动</button>}
          {run.status === 'running' && <button className="hub-small-button" disabled={busy} onClick={() => void action(() => pauseHarnessRun(projectId, run.id))}>暂停</button>}
          {run.adapter === 'deepseek' && run.retainedWorkspace && ['paused','failed','cancelled'].includes(run.status) && <button className="hub-small-button" disabled={busy} onClick={() => void action(() => recoverHarnessRun(projectId, run.id))}>{busy ? '正在对账…' : '恢复已有结果'}</button>}
          {run.status === 'paused' && (!run.retainedWorkspace || run.recovery?.status === 'ready') && <button className="hub-small-button" disabled={busy} onClick={() => void action(() => resumeHarnessRun(projectId, run.id))}>{run.recovery?.status === 'ready' ? '继续剩余工作' : '恢复'}</button>}
          {['created','running','paused'].includes(run.status) && <button className="hub-small-button is-quiet" disabled={busy} onClick={() => void action(() => cancelHarnessRun(projectId, run.id))}>取消</button>}
          {['completed','failed','cancelled'].includes(run.status) && <button className="hub-small-button is-quiet" disabled={busy} onClick={() => void action(async () => { const result = await replayHarnessRun(projectId, run.id); navigate(taskHref(projectId, `harness:${result.run.id}`)); })}>新 Run 重放</button>}
          {['completed','failed','cancelled'].includes(run.status) && <><button className="hub-small-button" disabled={busy || run.humanDecision?.status === 'accepted'} onClick={() => void action(() => decideHarnessRun(projectId, run.id, 'accept'))}>接受结果</button><button className="hub-small-button is-quiet" disabled={busy || run.humanDecision?.status === 'rejected'} onClick={() => void action(() => decideHarnessRun(projectId, run.id, 'reject'))}>拒绝结果</button></>}
        </> : !run && <>{task.retryable && <button className="hub-small-button" disabled={busy} onClick={() => void action(() => retryProjectTask(projectId, task.id))}>重试</button>}{['queued','running','paused'].includes(task.status) && <button className="hub-small-button" disabled={busy} onClick={() => void action(() => cancelProjectTask(projectId, task.id))}>取消</button>}</>}
        <button className="hub-small-button is-quiet" disabled={busy} onClick={() => void action(load)}>刷新</button>
      </div>
      {run && <RunDelegation run={run} />}
      {run?.recovery?.status === 'ready' && <p className="hub-muted" role="status">已恢复 {run.recovery.children.length} 个子任务结果和已有提案。对账没有重新调用模型；继续工作会使用这些结果，已完成的同一编码任务不会重新启动。</p>}
      {sourceError && <p className="hub-error" role="alert">{sourceError}</p>}
      {run?.archived && <p className="hub-muted">此 Run 仅保留归档摘要；会话正文、事件、上下文和 Patch 未留存。</p>}
      <nav className="task-detail-tabs" aria-label="任务内容">{Object.entries(TABS).map(([id,label]) => <button key={id} className={tab === id ? 'is-active' : ''} aria-current={tab === id ? 'page' : undefined} onClick={() => setParams({ tab: id }, { replace: true })}>{label}</button>)}</nav>
      <section className="task-detail-body">
        {tab === 'summary' && <><dl className="hub-detail-list"><div><dt>状态</dt><dd>{task.status} · {run?.humanDecision?.status || String(task.metadata?.humanDecision ? '已记录人工决定' : '未记录人工决定')}</dd></div><div><dt>创建 / 更新</dt><dd>{task.createdAt} / {task.updatedAt}</dd></div><div><dt>运行实现 / 模型</dt><dd>{run?.adapter || '非 Harness 任务'} / {run?.model || '未记录'}</dd></div><div><dt>尝试 / 会话</dt><dd>{run?.attempt ?? '未记录'} / {(run as HarnessRun & { sessionId?: string })?.sessionId || '未记录'}</dd></div></dl><p className="hub-muted">运行完成仅表示执行结束；人工接受、Patch 应用和科研核验各自记录。</p>{task.error && <pre className="task-record">{pretty(task.error)}</pre>}</>}
        {tab === 'session' && <div className="task-session"><article className="task-message is-user"><small>任务输入</small><p>{run?.request?.prompt || '此源记录未保存会话输入。'}</p></article><article className="task-message"><small>运行输出</small><p>{run?.reply || '此记录没有可读取的会话输出。'}</p></article></div>}
        {tab === 'execution' && <><dl className="hub-detail-list"><div><dt>角色 / Skills</dt><dd>{run?.role || '未记录'} / {run?.skills?.join(', ') || '未选择'}</dd></div><div><dt>能力</dt><dd>{run?.capabilities?.granted?.join(', ') || '未记录'}</dd></div><div><dt>重放来源</dt><dd>{run?.replayOf ? <Link to={taskHref(projectId,`harness:${run.replayOf}`)}>{run.replayOf}</Link> : '无'}</dd></div><div><dt>父 Run</dt><dd>{run?.parentRunId ? <Link to={taskHref(projectId,`harness:${run.parentRunId}`)}>{run.parentRunId}</Link> : '无'}</dd></div></dl><details><summary>上下文 / 降级 / 预算</summary><pre className="task-record">{pretty(run ? { contextHash:run.contextHash, manifest:run.contextManifest, adapterHistory:run.adapterHistory, limits:run.limits, documentVersions:run.documentVersions } : experiment?.manifest || task.metadata)}</pre></details>{run && <RuntimeToolCalls run={run} />}</>}
        {tab === 'evidence' && <><p>证据和科学状态来自项目账本及实验记录。</p>{experiment?.evidence && <pre className="task-record">{pretty(experiment.evidence)}</pre>}<Link className="hub-small-button" to={`/project/${encodeURIComponent(projectId)}/evidence`}>查看项目证据</Link><p className="hub-muted">没有明确的源引用时，此任务不自动关联证据。</p></>}
        {tab === 'artifacts' && <>{experiment && <><h3>原始产物</h3>{experiment.artifacts?.length ? experiment.artifacts.map(artifact => <article className="task-artifact" key={artifact.id}><strong>{artifact.name}</strong><code>{artifact.path}</code><small>{artifact.bytes} bytes · SHA256 {artifact.sha256}</small><EvidenceSourceLocation projectId={projectId} source={{ path: artifact.path }} /></article>) : <p>未记录产物。</p>}<h3>指标</h3><pre className="task-record">{pretty(experiment.metrics)}</pre></>}{run?.patches?.map(patch => <article className="task-artifact" key={patch.path}><label><input type="checkbox" checked={paths.includes(patch.path)} onChange={() => setPaths(current => current.includes(patch.path) ? current.filter(path => path !== patch.path) : [...current,patch.path])} /> {patch.path} · {run.appliedPatches?.includes(patch.path) ? '已应用' : '提议修改'}</label><pre className="task-record">{patch.diff || patch.content || (patch.deleted ? '删除文件' : '未留存内容')}</pre></article>)}{run?.patches?.length ? <button className="hub-small-button" disabled={busy || run.kind === 'codex-worker' || run.humanDecision?.status !== 'accepted' || !paths.length} onClick={() => void action(() => applyHarnessRunPatches(projectId, run.id, paths))}>应用所选 Patch</button> : !experiment && <p>此任务没有留存产物或 Patch。</p>}</>}
        {tab === 'logs' && <><p className="hub-muted">显示源记录保留的日志。旧记录或归档缺失字段明确留空。</p><pre className="task-record">{task.log.length ? task.log.join('\n') : '没有任务日志。'}</pre>{experiment?.logs && <pre className="task-record">{pretty(experiment.logs)}</pre>}{run && <RuntimeEventsView run={run} />}</>}
      </section>
    </>}
  </ProjectWorkspaceFrame>;
}
