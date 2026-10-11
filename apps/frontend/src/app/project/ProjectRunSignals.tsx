import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getProjectObservability, type ProjectObservability } from '../../api/observabilityAdapter';

export function ProjectRunSignals({ projectId }: { projectId: string }) {
  const [data, setData] = useState<ProjectObservability | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setError('');
    getProjectObservability(projectId).then(result => { if (active) setData(result.observability); }).catch(error => { if (active) setError(String(error)); });
    return () => { active = false; };
  }, [projectId, revision]);
  return <section className="hub-panel hub-run-signals" aria-label="实际运行统计">
    <div className="hub-section-heading"><h3>运行统计</h3><button className="hub-small-button is-quiet" onClick={() => setRevision(value => value + 1)}>刷新统计</button></div>
    {error && <p className="hub-error" role="alert">{error} · {data ? '保留上次读取结果' : '统计尚未读取'}</p>}
    {!data && !error && <p role="status">正在读取运行记录…</p>}
    {data && <>
      <div className="hub-stat-grid">
        <div><span>Harness 运行</span><strong>{data.harness.total}</strong><small>{data.harness.failed} 次失败 · {data.harness.cancelled} 次取消</small></div>
        <div><span>已报告 Token</span><strong>{data.harness.usageReports ? data.harness.tokens.total.toLocaleString() : '未报告'}</strong><small>{data.harness.usageReports} 个终态 Run 报告用量 · {data.harness.unreportedUsage} 个未报告</small></div>
        <div><span>终态平均耗时</span><strong>{data.harness.durationSamples ? `${(data.harness.averageDurationMs / 1000).toFixed(1)}s` : '未报告'}</strong><small>{data.harness.durationSamples} 个有效时间样本</small></div>
        <div><span>受控实验</span><strong>{data.experiments.total}</strong><small>{data.experiments.completed} 次执行完成 · 仍需科研核验</small></div>
      </div>
      <p className="hub-muted">仅已保留记录：最多 {data.scope.harnessLimit} 个 Harness、{data.scope.experimentLimit} 个实验。{data.scope.oldestAt ? `${new Date(data.scope.oldestAt).toLocaleString()} 至 ${new Date(data.scope.newestAt!).toLocaleString()}` : '尚无运行样本'}。采集于 {new Date(data.generatedAt).toLocaleString()}。</p>
      <Link className="hub-text-link" to={`/project/${encodeURIComponent(projectId)}/runs`}>查看运行记录 →</Link>
    </>}
  </section>;
}
