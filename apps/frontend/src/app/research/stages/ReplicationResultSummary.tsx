import type { ReplicationResultSummary } from '../researchStages';

function statusLabel(status: string) {
  switch (status) {
    case 'completed': return '运行完成';
    case 'failed': return '运行失败';
    case 'cancelled': return '运行已取消';
    case 'awaiting_approval': return '等待批准';
    case 'approved': return '已批准';
    case 'running': return '运行中';
    case 'pending': return '待人工核验';
    case 'unverified': return '未核验';
    case 'human-confirmed': return '人工已确认';
    case 'verified': return '已核验';
    default: return status || '未记录';
  }
}

function evidenceLabel(status: string) {
  return `Evidence：${statusLabel(status)}`;
}

export interface ReplicationResultSummaryProps {
  value?: ReplicationResultSummary;
  heading?: string;
}

export function ReplicationResultSummary({ value, heading = '论文复现结果' }: ReplicationResultSummaryProps) {
  if (!value) return null;
  const supportsConclusion = value.status === 'completed' && value.supportsSuccessfulFinding === true;
  return (
    <section className="research-panel" aria-label={heading}>
      <div className="research-panel-heading">
        <div><span className="research-overline">REPLICATION EVIDENCE</span><h3>{heading}</h3></div>
        <span className={`research-status-note${supportsConclusion ? ' is-ready' : ''}`}>{statusLabel(value.status)}</span>
      </div>
      <p className="research-panel-copy">Run、来源和产物状态来自当前项目服务端记录。运行完成不等于科学结论；只有人工核验后的 Evidence 才能支持正文主张。</p>
      <dl className="research-run-summary">
        <div><dt>Run ID</dt><dd><code>{value.id}</code></dd></div>
        <div><dt>Evidence 状态</dt><dd>{evidenceLabel(value.evidenceStatus)}</dd></div>
        <div><dt>工作流版本</dt><dd>{value.provenance.workflowVersion}</dd></div>
        <div><dt>阶段状态</dt><dd>{value.provenance.stageStatus}</dd></div>
        <div><dt>代码版本</dt><dd>{value.codeVersion}</dd></div>
        <div><dt>数据版本</dt><dd>{value.dataset.version}</dd></div>
        <div><dt>执行环境</dt><dd>{value.environment.node} · {value.environment.platform}/{value.environment.arch}</dd></div>
        <div><dt>入口运行器</dt><dd>{value.environment.runner}</dd></div>
      </dl>
      {value.status !== 'completed' && <div className="research-callout research-callout-warning"><strong>结果不支持成功结论</strong><p>失败、取消或尚未完成的 Run 仅保留为执行记录，不能作为复现成功或方法有效性的证据。</p></div>}
      {value.status === 'completed' && !supportsConclusion && <div className="research-callout research-callout-warning"><strong>仍需人工核验</strong><p>服务端已记录运行结果，但当前 Evidence 状态为“{statusLabel(value.evidenceStatus)}”，不会自动进入已支持主张。</p></div>}
      {value.metrics.length > 0 && <div className="research-metric-table" aria-label="复现指标"><div><span>指标</span><span>结果</span><span>不确定性</span></div>{value.metrics.map((metric) => <div key={metric.name}><span>{metric.name}</span><strong>{metric.value === undefined || metric.value === null ? '等待结果' : String(metric.value)}</strong><span>{metric.uncertainty === undefined || metric.uncertainty === null ? '—' : String(metric.uncertainty)}</span></div>)}</div>}
      {value.artifacts.length > 0 && <div className="research-artifact-list"><strong>归档产物</strong>{value.artifacts.map((artifact) => <span key={artifact.id}>{artifact.kind} · {artifact.path} · {evidenceLabel(artifact.evidenceStatus)} · {artifact.sha256.slice(0, 12)}</span>)}</div>}
    </section>
  );
}
