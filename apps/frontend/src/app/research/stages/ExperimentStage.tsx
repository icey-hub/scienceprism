import type { ExperimentPlan } from '../researchStages';
import type { ExperimentRun } from '../../../api/client';
import { PythonEnvironmentPanel } from './PythonEnvironmentPanel';
import { DatasetVersionPicker } from './DatasetVersionPicker';

export interface ExperimentStageProps {
  projectId?: string;
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

export function ExperimentStage({ projectId, value, busy = false, onChange, onSavePlan, onSubmitForRun, run, onCreateRun, onApproveRun, onStartRun, onCancelRun, onOpenDatasetAudit }: ExperimentStageProps) {
  const execution = value.execution || { adapter: 'node' as const, entrypoint: '', args: [] };
  const metrics = run?.metrics?.length ? run.metrics : value.metrics;
  return (
    <div className="research-page-stack">
      {projectId && execution.adapter === 'python' && <PythonEnvironmentPanel key={projectId} projectId={projectId} value={execution.environmentId} disabled={busy} onChange={environmentId => onChange({ ...value, execution: { ...execution, environmentId: environmentId || undefined } })} />}
      <section className="research-panel">
        <div className="research-panel-heading">
          <div>
            <span className="research-overline">CONTROLLED EXPERIMENT</span>
            <h3>实验计划与结果</h3>
          </div>
          <span className="research-status-note">{value.status || '待规划'}</span>
        </div>
        <div className="research-form-grid">
          {projectId && <DatasetVersionPicker projectId={projectId} value={value.dataset} disabled={busy} onChange={(dataset, datasetVersion) => onChange({ ...value, dataset, datasetVersion })} />}
          <label className="research-field"><span>运行适配器</span><select value={execution.adapter} onChange={(event) => onChange({ ...value, execution: { ...execution, adapter: event.target.value as 'node' | 'python', environmentId: event.target.value === 'python' ? execution.environmentId : undefined } })}><option value="node">Node.js</option><option value="python">Python</option></select></label>
          <label className="research-field"><span>数据集</span><input value={value.dataset} placeholder="数据集名称或受控路径" onChange={(event) => onChange({ ...value, dataset: event.target.value })} /></label>
          <label className="research-field"><span>数据版本</span><input value={value.datasetVersion} placeholder="版本、提交号或快照日期" onChange={(event) => onChange({ ...value, datasetVersion: event.target.value })} /></label>
          <label className="research-field"><span>关联方法 ID</span><input value={value.methodId || ''} placeholder="已批准的方法标识" onChange={(event) => onChange({ ...value, methodId: event.target.value })} /></label>
          <label className="research-field"><span>重复次数</span><input type="number" min="1" max="100" value={value.repetitions || 1} onChange={(event) => onChange({ ...value, repetitions: Math.min(100, Math.max(1, Number(event.target.value) || 1)) })} /></label>
          <label className="research-field"><span>预算说明</span><input value={value.budget || ''} placeholder="例如：最多 2 GPU 小时；实际运行上限另行设置" onChange={(event) => onChange({ ...value, budget: event.target.value })} /></label>
          <label className="research-field"><span>随机种子</span><input value={value.seed ?? ''} onChange={(event) => onChange({ ...value, seed: event.target.value })} /></label>
          <label className="research-field research-field-wide"><span>成功标准 <small>每行一个</small></span><textarea value={(value.successCriteria || []).join('\n')} rows={3} onChange={(event) => onChange({ ...value, successCriteria: event.target.value.split('\n').map((item) => item.trim()).filter(Boolean) })} /></label>
          <label className="research-field research-field-wide"><span>实验协议</span><textarea value={value.protocol} rows={5} placeholder="记录训练、评估、资源限制、随机种子和停止条件。" onChange={(event) => onChange({ ...value, protocol: event.target.value })} /></label>
          <label className="research-field research-field-wide"><span>预期失败与停止条件 <small>每行一个</small></span><textarea value={(value.expectedFailures || []).join('\n')} rows={3} onChange={(event) => onChange({ ...value, expectedFailures: event.target.value.split('\n').map((item) => item.trim()).filter(Boolean) })} /></label>
          <label className="research-field"><span>受控入口文件</span><input value={execution.entrypoint} placeholder="例如 experiments/run.mjs" onChange={(event) => onChange({ ...value, execution: { ...execution, entrypoint: event.target.value } })} /></label>
          <label className="research-field"><span>入口参数</span><input value={execution.args.join(' ')} placeholder="可选，按空格分隔" onChange={(event) => onChange({ ...value, execution: { ...execution, args: event.target.value.split(' ').filter(Boolean) } })} /></label>
          <label className="research-field"><span>运行上限（分钟）</span><input type="number" min="1" max="1440" value={Math.round((value.resources?.timeoutMs || 600000) / 60000)} onChange={(event) => onChange({ ...value, resources: { ...value.resources, timeoutMs: Math.max(1, Number(event.target.value) || 1) * 60000 } })} /></label>
          <label className="research-field research-field-wide"><span>归档产物路径（首行为指标 JSON）</span><textarea value={(value.artifacts || []).map((artifact) => artifact.path).join('\n')} rows={3} placeholder={'results/metrics.json\nresults/results.json'} onChange={(event) => onChange({ ...value, artifacts: event.target.value.split('\n').map((item) => item.trim()).filter(Boolean).map((item, index) => ({ path: item, kind: index === 0 ? 'metric' : 'output' })) })} /></label>
          <label className="research-field research-field-wide"><span>运行快照文件（每行一个）</span><textarea value={(value.codePaths || []).join('\n')} rows={3} placeholder={'experiments/run.py\ndatasets/input.json.gz'} onChange={(event) => onChange({ ...value, codePaths: event.target.value.split('\n').map((item) => item.trim()).filter(Boolean) })} /></label>
        </div>
        <div className="research-panel-footer">
          <p>执行项目内的入口文件，并记录代码、数据和环境版本。Python 可使用上方准备的环境。</p>
          <div className="research-inline-actions">
            {onOpenDatasetAudit && <button className="research-button research-button-quiet" disabled={busy} onClick={onOpenDatasetAudit} type="button">检查数据集</button>}
            <button className="research-button research-button-quiet" disabled={busy} onClick={onSavePlan} type="button">保存计划</button>
            <button className="research-button research-button-primary" disabled={busy || !value.dataset.trim() || !value.datasetVersion.trim() || !value.protocol.trim() || !(value.methodId || '').trim() || !String(value.seed ?? '').trim() || !value.repetitions || !value.budget?.trim() || !value.successCriteria?.length} onClick={onSubmitForRun} type="button">提交实验计划</button>
          </div>
        </div>
      </section>
      <section className="research-panel">
        <div className="research-panel-heading"><div><span className="research-overline">RUN MANIFEST</span><h3>受控运行</h3></div><span className="research-status-note">{run?.status || '尚未创建'}</span></div>
        {!run ? <div className="research-empty-inline">保存并确认实验计划后，可以创建一次待审批的受控运行。</div> : <>
          {run.manifest?.dataset?.input && <p className="research-panel-copy">固定数据输入：{run.manifest.dataset.input.filename} · {run.manifest.dataset.input.byteLength.toLocaleString()} bytes · SHA256 {run.manifest.dataset.input.sha256.slice(0, 16)}。运行前后核对，原始数据独立归档。</p>}
          <dl className="research-run-summary"><div><dt>代码版本</dt><dd>{run.manifest?.code?.version || '未记录'}</dd></div><div><dt>数据版本</dt><dd>{run.manifest?.dataset?.version || '未记录'}</dd></div><div><dt>Python 环境</dt><dd>{run.manifest?.environment?.python ? `${run.manifest.environment.python.version} · ${run.manifest.environment.preparation?.sha256.slice(0, 12) || '未绑定版本'}` : '未记录'}</dd></div><div><dt>种子</dt><dd>{run.manifest?.seed || '未设置'}</dd></div><div><dt>入口</dt><dd>{run.manifest?.command?.entrypoint || '受控测试适配器'}</dd></div><div><dt>关联方法</dt><dd>{run.manifest?.researchPlan?.plan?.methodId || '未记录'}</dd></div><div><dt>计划重复 / 预算</dt><dd>{run.manifest?.researchPlan?.plan?.repetitions || 1} 次 · {run.manifest?.researchPlan?.plan?.budget || '未记录'}</dd></div></dl>
          {run.error?.message && <div className="research-callout research-callout-warning"><strong>运行失败</strong><p>{run.error.message}</p></div>}
          <div className="research-inline-actions">
            {run.status === 'awaiting_approval' && onApproveRun && <button className="research-button research-button-primary" disabled={busy} onClick={onApproveRun} type="button">批准运行</button>}
            {run.status === 'approved' && onStartRun && <button className="research-button research-button-primary" disabled={busy} onClick={onStartRun} type="button">启动运行</button>}
            {['awaiting_approval', 'approved', 'running'].includes(run.status) && onCancelRun && <button className="research-button research-button-quiet" disabled={busy} onClick={onCancelRun} type="button">取消运行</button>}
          </div>
          {Boolean(run.artifacts?.length) && <div className="research-artifact-list"><strong>已归档产物</strong>{(run.artifacts || []).map((artifact) => <span key={artifact.id}>{artifact.kind} · {artifact.name} · {artifact.sha256.slice(0, 12)}</span>)}</div>}
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
