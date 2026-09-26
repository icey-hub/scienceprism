import type { ExperimentPlan } from '../researchStages';
import type { ExperimentRun } from '../../../api/client';

export interface ExperimentStageProps {
  value: ExperimentPlan;
  busy?: boolean;
  onChange: (next: ExperimentPlan) => void;
  onSavePlan: () => void;
  onSubmitForRun: () => void;
  run?: ExperimentRun | null;
  onCreateRun?: () => void;
  onApproveRun?: () => void;
  onStartRun?: () => void;
  onCancelRun?: () => void;
  onOpenDatasetAudit?: () => void;
}

export function ExperimentStage({ value, busy = false, onChange, onSavePlan, onSubmitForRun, run, onCreateRun, onApproveRun, onStartRun, onCancelRun, onOpenDatasetAudit }: ExperimentStageProps) {
  const execution = value.execution || { adapter: 'node' as const, entrypoint: '', args: [] };
  const metrics = run?.metrics.length ? run.metrics : value.metrics;
  return (
    <div className="research-page-stack">
      <section className="research-panel">
        <div className="research-panel-heading">
          <div>
            <span className="research-overline">CONTROLLED EXPERIMENT</span>
            <h3>实验计划与结果</h3>
          </div>
          <span className="research-status-note">{value.status || '待规划'}</span>
        </div>
        <div className="research-form-grid">
          <label className="research-field"><span>运行适配器</span><select value={execution.adapter} onChange={(event) => onChange({ ...value, execution: { ...execution, adapter: event.target.value as 'node' | 'python' } })}><option value="node">Node.js</option><option value="python">Python（需配置受信任虚拟环境）</option></select></label>
          <label className="research-field"><span>数据集</span><input value={value.dataset} placeholder="数据集名称或受控路径" onChange={(event) => onChange({ ...value, dataset: event.target.value })} /></label>
          <label className="research-field"><span>数据版本</span><input value={value.datasetVersion} placeholder="版本、提交号或快照日期" onChange={(event) => onChange({ ...value, datasetVersion: event.target.value })} /></label>
          <label className="research-field research-field-wide"><span>实验协议</span><textarea value={value.protocol} rows={5} placeholder="记录训练、评估、资源限制、随机种子和停止条件。" onChange={(event) => onChange({ ...value, protocol: event.target.value })} /></label>
          <label className="research-field"><span>受控入口文件</span><input value={execution.entrypoint} placeholder="例如 experiments/run.mjs" onChange={(event) => onChange({ ...value, execution: { ...execution, entrypoint: event.target.value } })} /></label>
          <label className="research-field"><span>入口参数</span><input value={execution.args.join(' ')} placeholder="可选，按空格分隔" onChange={(event) => onChange({ ...value, execution: { ...execution, args: event.target.value.split(' ').filter(Boolean) } })} /></label>
          <label className="research-field"><span>运行上限（分钟）</span><input type="number" min="1" max="1440" value={Math.round((value.resources?.timeoutMs || 600000) / 60000)} onChange={(event) => onChange({ ...value, resources: { ...value.resources, timeoutMs: Math.max(1, Number(event.target.value) || 1) * 60000 } })} /></label>
          <label className="research-field research-field-wide"><span>归档产物路径（首行为指标 JSON）</span><textarea value={(value.artifacts || []).map((artifact) => artifact.path).join('\n')} rows={3} placeholder={'results/metrics.json\nresults/results.json'} onChange={(event) => onChange({ ...value, artifacts: event.target.value.split('\n').map((item) => item.trim()).filter(Boolean).map((item, index) => ({ path: item, kind: index === 0 ? 'metric' : 'output' })) })} /></label>
          <label className="research-field research-field-wide"><span>运行快照文件（每行一个）</span><textarea value={(value.codePaths || []).join('\n')} rows={3} placeholder={'experiments/run.py\ndatasets/input.json.gz'} onChange={(event) => onChange({ ...value, codePaths: event.target.value.split('\n').map((item) => item.trim()).filter(Boolean) })} /></label>
        </div>
        <div className="research-panel-footer">
          <p>只执行项目内的 Node 或 Python 入口文件；Python 需要服务器配置解释器并启用 macOS 沙箱。shell 命令只作为计划备注保存。</p>
          <div className="research-inline-actions">
            {onOpenDatasetAudit && <button className="research-button research-button-quiet" disabled={busy} onClick={onOpenDatasetAudit} type="button">检查数据集</button>}
            <button className="research-button research-button-quiet" disabled={busy} onClick={onSavePlan} type="button">保存计划</button>
            <button className="research-button research-button-primary" disabled={busy || !value.dataset.trim() || !value.protocol.trim()} onClick={onSubmitForRun} type="button">提交实验计划</button>
          </div>
        </div>
      </section>
      <section className="research-panel">
        <div className="research-panel-heading"><div><span className="research-overline">RUN MANIFEST</span><h3>受控运行</h3></div><span className="research-status-note">{run?.status || '尚未创建'}</span></div>
        {!run ? <div className="research-empty-inline">保存并确认实验计划后，可以创建一次待审批的受控运行。</div> : <>
          <dl className="research-run-summary"><div><dt>代码版本</dt><dd>{run.manifest.code.version}</dd></div><div><dt>数据版本</dt><dd>{run.manifest.dataset.version}</dd></div><div><dt>种子</dt><dd>{run.manifest.seed || '未设置'}</dd></div><div><dt>入口</dt><dd>{run.manifest.command.entrypoint || '受控测试适配器'}</dd></div></dl>
          {run.error?.message && <div className="research-callout research-callout-warning"><strong>运行失败</strong><p>{run.error.message}</p></div>}
          <div className="research-inline-actions">
            {run.status === 'awaiting_approval' && onApproveRun && <button className="research-button research-button-primary" disabled={busy} onClick={onApproveRun} type="button">批准运行</button>}
            {run.status === 'approved' && onStartRun && <button className="research-button research-button-primary" disabled={busy} onClick={onStartRun} type="button">启动运行</button>}
            {['awaiting_approval', 'approved', 'running'].includes(run.status) && onCancelRun && <button className="research-button research-button-quiet" disabled={busy} onClick={onCancelRun} type="button">取消运行</button>}
          </div>
          {run.artifacts.length > 0 && <div className="research-artifact-list"><strong>已归档产物</strong>{run.artifacts.map((artifact) => <span key={artifact.id}>{artifact.kind} · {artifact.name} · {artifact.sha256.slice(0, 12)}</span>)}</div>}
        </>}
        {(!run || ['completed', 'failed', 'cancelled', 'rejected'].includes(run.status)) && onCreateRun && <div className="research-panel-footer"><button className="research-button research-button-quiet" disabled={busy || !execution.entrypoint.trim() || !value.datasetVersion.trim()} onClick={onCreateRun} type="button">{run ? '创建新的 Run' : '创建待审批 Run'}</button></div>}
      </section>
      <section className="research-panel research-metric-panel">
        <div className="research-panel-heading"><div><span className="research-overline">RESULTS</span><h3>实验指标</h3></div></div>
        {metrics.length === 0 ? <div className="research-empty-inline">实验完成后，指标和不确定性会在这里显示。</div> : <div className="research-metric-table"><div><span>指标</span><span>结果</span><span>不确定性</span></div>{metrics.map((metric) => <div key={metric.name}><span>{metric.name}</span><strong>{metric.value === undefined || metric.value === null ? '等待结果' : String(metric.value)}</strong><span>{metric.uncertainty === undefined || metric.uncertainty === null ? '—' : String(metric.uncertainty)}</span></div>)}</div>}
      </section>
    </div>
  );
}
