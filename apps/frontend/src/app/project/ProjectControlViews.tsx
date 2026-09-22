import { useCallback, useEffect, useState } from 'react';
import {
  cancelHarnessRun,
  decideHarnessRun,
  listHarnessRuns,
  pauseHarnessRun,
  replayHarnessRun,
  resumeHarnessRun,
  startHarnessRun,
  type HarnessRun
} from '../../api/harnessAdapter';
import { getEvidenceClaimMatrix, getEvidenceGraph, type ClaimEvidenceMatrix } from '../../api/evidenceAdapter';
import type { ProjectDashboard } from '../../api/projectAdapter';
import { DecisionStatus } from '../components/DecisionStatus';
import { EmptyState, ErrorState, LoadingState, ProgressBar } from '../components/AsyncState';

type ActionState = { id: string; action: string } | null;

function formatTime(value?: string | null) {
  if (!value) return '尚未记录';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function runLabel(run: HarnessRun) {
  return `${run.stage || '项目'} / ${run.task || 'Harness 任务'}`;
}

export function ConstraintsPanel({ constraints }: { constraints: ProjectDashboard['constraints'] }) {
  const rows = [
    ['能力', constraints.capabilities.join(', ') || '默认只读'],
    ['允许路径', constraints.allowedPaths.join(', ') || '未额外限制'],
    ['网络白名单', constraints.networkAllowlist.join(', ') || '禁止网络'],
    ['上下文预算', constraints.contextTokenBudget ? `${constraints.contextTokenBudget.toLocaleString()} tokens` : '默认'],
    ['最长运行', constraints.timeoutMs ? `${Math.round(constraints.timeoutMs / 1000)} 秒` : '默认']
  ];
  return <section className="hub-panel control-panel">
    <div className="hub-section-heading"><div><span className="hub-kicker">PROJECT CONSTRAINTS</span><h3>项目约束</h3></div><span className="decision-status is-applied">后端投影</span></div>
    <p className="hub-panel-intro">这些限制由后端解释并在 Harness 运行前强制执行。页面只展示当前项目的有效策略。</p>
    <dl className="constraint-list">{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
  </section>;
}

export function ApprovalsInbox({ projectId, approvals }: { projectId: string; approvals: ProjectDashboard['approvals'] }) {
  return <section className="hub-panel control-panel">
    <div className="hub-section-heading"><div><span className="hub-kicker">HUMAN INBOX</span><h3>待审批收件箱</h3></div><span className="hub-heading-count">{approvals.length}</span></div>
    {approvals.length ? <div className="approval-list">{approvals.map((approval) => <a className="approval-row" href={`/editor/${projectId}/research/${approval.stageId === 'ideation' ? 'innovation' : approval.stageId}`} key={approval.stageId}><span className="approval-index">!</span><span><strong>{approval.label}</strong><small>{approval.readiness?.missing?.length ? `还缺少：${approval.readiness.missing.join('、')}` : '结构校验已通过，等待人工决定'}</small></span><b>打开 →</b></a>)}</div> : <EmptyState title="没有待审批事项" detail="阶段输出通过校验后会出现在这里。" />}
  </section>;
}

export function HarnessConsole({ projectId }: { projectId: string }) {
  const [runs, setRuns] = useState<HarnessRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [action, setAction] = useState<ActionState>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError('');
    try {
      const result = await listHarnessRuns(projectId, { limit: '30' });
      setRuns(result.runs || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!runs.some((run) => run.status === 'running')) return;
    const timer = window.setInterval(() => { void load(); }, 4000);
    return () => window.clearInterval(timer);
  }, [load, runs]);

  const runAction = async (run: HarnessRun, name: 'start' | 'pause' | 'resume' | 'cancel' | 'replay' | 'accept' | 'reject') => {
    setAction({ id: run.id, action: name });
    setError('');
    try {
      if (name === 'start') await startHarnessRun(projectId, run.id);
      if (name === 'pause') await pauseHarnessRun(projectId, run.id);
      if (name === 'resume') await resumeHarnessRun(projectId, run.id);
      if (name === 'cancel') await cancelHarnessRun(projectId, run.id);
      if (name === 'replay') await replayHarnessRun(projectId, run.id);
      if (name === 'accept' || name === 'reject') await decideHarnessRun(projectId, run.id, name);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAction(null);
    }
  };

  if (loading) return <section className="hub-panel control-panel"><LoadingState label="正在读取 Harness 运行…" /></section>;
  return <section className="hub-panel control-panel">
    <div className="hub-section-heading"><div><span className="hub-kicker">HARNESS RUNS</span><h3>Harness 运行控制台</h3></div><button className="hub-small-button is-quiet" onClick={() => void load()} type="button">刷新</button></div>
    <p className="hub-panel-intro">查看模型上下文、工具事件、验证结果和待确认 Patch。所有运行都保留恢复、重放和人工决定入口。</p>
    {error && <ErrorState message={error} onRetry={() => void load()} />}
    {!error && !runs.length && <EmptyState title="还没有 Harness 运行" detail="从研究阶段启动一次结构化任务后，运行记录会显示在这里。" />}
    <div className="harness-run-list">{runs.map((run) => {
      const busy = action?.id === run.id;
      const expanded = selectedId === run.id;
      const canStart = ['created', 'failed'].includes(run.status);
      return <article className="harness-run-row" key={run.id}>
        <button className="harness-run-summary" type="button" onClick={() => setSelectedId(expanded ? null : run.id)} aria-expanded={expanded}>
          <span className={`hub-status-dot ${run.status}`} /><span className="harness-run-copy"><strong>{runLabel(run)}</strong><small>{run.adapter} · {run.model || '未指定模型'} · 更新于 {formatTime(run.updatedAt)}</small></span><DecisionStatus status={run.status} /><span className="harness-chevron" aria-hidden="true">{expanded ? '⌃' : '⌄'}</span>
        </button>
        {expanded && <div className="harness-run-detail">
          <div className="harness-run-meta"><span>Run ID <code>{run.id.slice(0, 12)}</code></span><span>Context <code>{run.contextHash?.slice(0, 12) || '未记录'}</code></span><span>创建于 {formatTime(run.createdAt)}</span></div>
          {run.status === 'running' && <ProgressBar value={60} label="Harness 正在运行" />}
          {run.error?.message && <p className="hub-error">{run.error.message}</p>}
          {run.outputValidation && <div className="validation-note">输出校验：{run.outputValidation.ok === false ? '未通过' : '通过'}{run.outputValidation.warnings?.length ? ` · ${run.outputValidation.warnings.length} 条提示` : ''}</div>}
          {run.patches?.length ? <div className="patch-summary">待确认 Patch：{run.patches.length} 个文件 <a href={`/editor/${projectId}?right=diff`}>打开编辑器 Diff</a></div> : null}
          {run.events?.length ? <details className="run-events"><summary>事件日志（{run.events.length}）</summary><pre>{run.events.slice(-20).map((event) => `[${event.at || ''}] ${event.type || 'event'} ${event.name || event.capability || ''} ${event.text || ''}`).join('\n')}</pre></details> : null}
          <div className="harness-run-actions">
            {canStart && <button className="hub-small-button" disabled={Boolean(action)} onClick={() => void runAction(run, 'start')} type="button">{busy && action?.action === 'start' ? '启动中…' : '启动'}</button>}
            {run.status === 'running' && <><button className="hub-small-button is-quiet" disabled={Boolean(action)} onClick={() => void runAction(run, 'pause')} type="button">暂停</button><button className="hub-small-button is-danger" disabled={Boolean(action)} onClick={() => void runAction(run, 'cancel')} type="button">取消</button></>}
            {run.status === 'paused' && <button className="hub-small-button" disabled={Boolean(action)} onClick={() => void runAction(run, 'resume')} type="button">恢复</button>}
            {['completed', 'failed', 'cancelled'].includes(run.status) && (
              <>
                <button className="hub-small-button is-quiet" disabled={Boolean(action)} onClick={() => void runAction(run, 'replay')} type="button">重放</button>
                {run.humanDecision?.status !== 'accepted' && <button className="hub-small-button" disabled={Boolean(action)} onClick={() => void runAction(run, 'accept')} type="button">接受结果</button>}
                {run.humanDecision?.status !== 'rejected' && <button className="hub-small-button is-quiet" disabled={Boolean(action)} onClick={() => void runAction(run, 'reject')} type="button">拒绝结果</button>}
              </>
            )}
          </div>
        </div>}
      </article>;
    })}</div>
  </section>;
}

export function EvidenceView({ projectId }: { projectId: string }) {
  const [matrix, setMatrix] = useState<ClaimEvidenceMatrix | null>(null);
  const [graph, setGraph] = useState<{ nodes: unknown[]; edges: unknown[]; version: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    setError('');
    try {
      const [matrixResult, graphResult] = await Promise.all([getEvidenceClaimMatrix(projectId), getEvidenceGraph(projectId)]);
      setMatrix(matrixResult.matrix);
      setGraph(graphResult.graph);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setLoading(false); }
  }, [projectId]);
  useEffect(() => { void load(); }, [load]);
  if (loading) return <section className="hub-panel control-panel"><LoadingState label="正在读取 Evidence Ledger…" /></section>;
  if (error) return <section className="hub-panel control-panel"><ErrorState message={error} onRetry={() => void load()} /></section>;
  if (!matrix || !graph) return <section className="hub-panel control-panel"><EmptyState title="还没有 Evidence" detail="完成论文筛选、实验或写作交接后，证据关系会出现在这里。" /></section>;
  return <section className="hub-panel control-panel evidence-view">
    <div className="hub-section-heading"><div><span className="hub-kicker">EVIDENCE LEDGER</span><h3>证据链视图</h3></div><span className={`hub-quality-badge ${matrix.ok ? 'pass' : 'warning'}`}>{matrix.ok ? '引用完整' : '需要核验'}</span></div>
    <div className="evidence-stat-grid"><div><strong>{matrix.totalClaims}</strong><span>论文主张</span></div><div><strong>{matrix.supportedClaims}</strong><span>已支持</span></div><div><strong>{matrix.needsVerificationClaims}</strong><span>待核验</span></div><div><strong>{graph.nodes.length}</strong><span>证据节点</span></div><div><strong>{graph.edges.length}</strong><span>关系</span></div></div>
    <div className="evidence-claim-list">{matrix.rows.length ? matrix.rows.map((row) => <article className="evidence-claim-row" key={row.id}><div><strong>{row.text}</strong><small>{row.evidenceIds.length ? `Evidence：${row.evidenceIds.join('、')}` : '尚未关联 Evidence'}</small></div><DecisionStatus status={row.status === 'supported' ? 'accepted' : row.status === 'needs-verification' ? 'awaiting_approval' : 'rejected'} /></article>) : <EmptyState title="暂无论文主张" detail="写作交接生成主张后会在这里建立关联。" />}</div>
  </section>;
}
