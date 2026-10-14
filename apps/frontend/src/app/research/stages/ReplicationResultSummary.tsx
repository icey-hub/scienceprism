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
    case 'unavailable': return '暂时无法读取';
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
  const isReplication = value.provenance.sourceStage === 'replication';
  const supportsConclusion = value.status === 'completed' && value.supportsSuccessfulFinding === true;
  const paper = value.paper;
  const source = typeof paper?.source === 'string' ? paper.source : paper?.source?.provider;
  const sourceRecords = paper?.sourceRecords?.map(record => [record.provider, record.id].filter(Boolean).join(' · ')).filter(Boolean) || [];
  const paperUrl = paper?.url && /^https?:\/\//i.test(paper.url) ? paper.url : null;
  return (
    <section className="research-panel" aria-label={heading}>
      <div className="research-panel-heading">
        <div><span className="research-overline">{isReplication ? 'REPLICATION EVIDENCE' : 'EXPERIMENT EVIDENCE'}</span><h3>{heading}</h3></div>
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
        <div><dt>执行协议</dt><dd>{value.protocol || '未记录'}</dd></div>
        <div><dt>随机种子</dt><dd>{value.seed ?? '未记录'}</dd></div>
        <div><dt>评价条件</dt><dd>{value.successCriteria?.length ? value.successCriteria.join('；') : '未记录'}</dd></div>
        <div><dt>退出码</dt><dd>{value.exitCode ?? '未报告'}</dd></div>
      </dl>
      {isReplication && <div className="research-callout"><strong>论文与评价协议来源</strong>
        {paper ? <><p>{paperUrl ? <a href={paperUrl} target="_blank" rel="noreferrer">{paper.title}</a> : paper.title}</p>
          <dl className="research-run-summary">
            <div><dt>论文标识</dt><dd>{paper.id}{paper.doi ? ` · DOI ${paper.doi}` : ''}</dd></div>
            <div><dt>作者 / 年份</dt><dd>{paper.authors?.join('、') || '作者未记录'} · {paper.year ?? '年份未记录'}</dd></div>
            <div><dt>文献来源</dt><dd>{[source, ...sourceRecords].filter(Boolean).join('；') || '来源未记录'}</dd></div>
            <div><dt>来源摘要</dt><dd>{paper.sha256 || '未记录'}</dd></div>
          </dl></> : <p>未绑定论文。此历史运行不能自动归属于当前已选论文。</p>}
        {value.evaluationProtocol ? <dl className="research-run-summary">
          <div><dt>数据划分</dt><dd>{value.evaluationProtocol.datasetSplit}</dd></div>
          <div><dt>指标提取方式</dt><dd>{value.evaluationProtocol.metricExtraction}</dd></div>
          <div><dt>论文页码 / 图表定位</dt><dd>{value.evaluationProtocol.referenceLocation}</dd></div>
        </dl> : <p>缺少评价协议：数据划分、指标提取方式与论文页码 / 图表定位未完整记录。</p>}
      </div>}
      {value.errorMessage && <div className="research-callout research-callout-warning"><strong>运行错误</strong><p>{value.errorMessage}</p></div>}
      {value.status !== 'completed' && <div className="research-callout research-callout-warning"><strong>结果不支持成功结论</strong><p>失败、取消或尚未完成的 Run 仅保留为执行记录，不能作为复现成功或方法有效性的证据。</p></div>}
      {value.status === 'completed' && !supportsConclusion && <div className="research-callout research-callout-warning"><strong>仍需人工核验</strong><p>服务端已记录运行结果，但当前 Evidence 状态为“{statusLabel(value.evidenceStatus)}”，不会自动进入已支持主张。</p></div>}
      {value.metrics.length > 0 && <div className="research-metric-table" aria-label={isReplication ? '复现指标' : '实验指标'}><div><span>指标</span><span>结果</span><span>不确定性</span></div>{value.metrics.map((metric) => <div key={metric.name}><span>{metric.name}</span><strong>{metric.value === undefined || metric.value === null ? '等待结果' : String(metric.value)}</strong><span>{metric.uncertainty === undefined || metric.uncertainty === null ? '—' : String(metric.uncertainty)}</span></div>)}</div>}
      {value.metrics.length === 0 && <div className="research-empty-inline">指标未报告；运行记录与归档产物不能代替实际指标。</div>}
      {value.artifacts.length > 0 && <div className="research-artifact-list"><strong>归档产物</strong>{value.artifacts.map((artifact) => <span key={artifact.id}>{artifact.kind} · {artifact.path} · {evidenceLabel(artifact.evidenceStatus)} · {artifact.sha256.slice(0, 12)}</span>)}</div>}
    </section>
  );
}
