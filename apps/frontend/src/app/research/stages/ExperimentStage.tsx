import type { ExperimentPlan } from '../researchStages';

export interface ExperimentStageProps {
  value: ExperimentPlan;
  busy?: boolean;
  onChange: (next: ExperimentPlan) => void;
  onSavePlan: () => void;
  onSubmitForRun: () => void;
  onOpenDatasetAudit?: () => void;
}

export function ExperimentStage({ value, busy = false, onChange, onSavePlan, onSubmitForRun, onOpenDatasetAudit }: ExperimentStageProps) {
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
          <label className="research-field"><span>数据集</span><input value={value.dataset} placeholder="数据集名称或受控路径" onChange={(event) => onChange({ ...value, dataset: event.target.value })} /></label>
          <label className="research-field"><span>数据版本</span><input value={value.datasetVersion} placeholder="版本、提交号或快照日期" onChange={(event) => onChange({ ...value, datasetVersion: event.target.value })} /></label>
          <label className="research-field research-field-wide"><span>实验协议</span><textarea value={value.protocol} rows={5} placeholder="记录训练、评估、资源限制、随机种子和停止条件。" onChange={(event) => onChange({ ...value, protocol: event.target.value })} /></label>
        </div>
        <div className="research-panel-footer">
          <p>运行请求会进入受控执行器，界面不会直接执行任意 shell 命令。</p>
          <div className="research-inline-actions">
            {onOpenDatasetAudit && <button className="research-button research-button-quiet" disabled={busy} onClick={onOpenDatasetAudit} type="button">检查数据集</button>}
            <button className="research-button research-button-quiet" disabled={busy} onClick={onSavePlan} type="button">保存计划</button>
            <button className="research-button research-button-primary" disabled={busy || !value.dataset.trim() || !value.protocol.trim()} onClick={onSubmitForRun} type="button">提交实验运行</button>
          </div>
        </div>
      </section>
      <section className="research-panel research-metric-panel">
        <div className="research-panel-heading"><div><span className="research-overline">RESULTS</span><h3>实验指标</h3></div></div>
        {value.metrics.length === 0 ? <div className="research-empty-inline">实验完成后，指标和不确定性会在这里显示。</div> : <div className="research-metric-table"><div><span>指标</span><span>结果</span><span>不确定性</span></div>{value.metrics.map((metric) => <div key={metric.name}><span>{metric.name}</span><strong>{metric.value || '等待结果'}</strong><span>{metric.uncertainty || '—'}</span></div>)}</div>}
      </section>
    </div>
  );
}
