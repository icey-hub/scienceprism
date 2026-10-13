import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { listHarnessRuns, type HarnessRun } from '../../api/harnessAdapter';
import { taskHref } from './taskLocation';
import { DecisionStatus } from '../components/DecisionStatus';

export function RunDelegation({ run }: { run: HarnessRun }) {
  const [children, setChildren] = useState<HarnessRun[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setChildren([]);
    setError('');
    if (!run.parentRunId) void listHarnessRuns(run.projectId, { parentRunId: run.id }).then(result => {
      if (active) { setChildren(result.runs); setError(''); }
    }).catch(() => { if (active) setError('子任务记录暂时无法读取。'); });
    return () => { active = false; };
  }, [run.id, run.projectId, run.parentRunId, run.updatedAt]);
  if (run.kind === 'research-stage' && run.parentRunId) return <div className="task-message">
    <strong>自动研究链路的阶段任务</strong><p>输入版本、继续与停止由研究链路统一管理。</p>
    <Link className="hub-text-link" to={taskHref(run.projectId, `harness:${run.parentRunId}`)}>返回研究父任务 →</Link>
    <Link className="hub-text-link" to={`/project/${run.projectId}/explore`}>管理研究链路 →</Link>
  </div>;
  if (run.kind === 'codex-worker' && run.parentRunId) return <div className="task-message">
    <strong>由 DeepSeek Harness 委派的 Codex 子任务</strong>
    <p>修改交回主任务汇总；暂停、重试和应用修改均从主任务操作。</p>
    <Link className="hub-text-link" to={taskHref(run.projectId, `harness:${run.parentRunId}`)}>返回主任务 →</Link>
    {run.output?.codex && <p><small>Codex 会话：{run.output.codex.threadId} · 轮次：{run.output.codex.turnId || '尚未启动'}</small></p>}
  </div>;
  if (!children.length && !error && run.kind !== 'research-coordinator') return null;
  return <section>{run.kind === 'research-coordinator' && <><p>研究链路：<DecisionStatus status={run.coordination?.status || 'queued'}/>。父任务保存调度关系；各阶段结果保留自己的核验状态。</p><Link to={`/project/${run.projectId}/explore`}>管理研究链路 →</Link></>}<h3>协作子任务</h3>{error && <p role="status">{error}</p>}
    {children.map(child => <p key={child.id}><Link className="hub-text-link" to={taskHref(run.projectId, `harness:${child.id}`)}>
      {child.kind === 'codex-worker' ? 'Codex · 编码与检查' : child.delegationTask || child.task}</Link> · {child.status}
      {child.error?.message && <small> · {child.error.message}</small>}</p>)}
  </section>;
}
