import type { ExperimentRun } from '../../../api/client';
import type { PaperCandidate, ReplicationPlan } from '../researchStages';

export interface ReplicationStageProps {
  selectedPapers: readonly PaperCandidate[];
  value: ReplicationPlan;
  busy?: boolean;
  stageApproved?: boolean;
  stageStatus?: string;
  run?: ExperimentRun | null;
  onChange: (next: ReplicationPlan) => void;
  onSavePlan: () => void;
  onSkip: () => void;
  onCreateRun?: () => void;
  onApproveRun?: () => void;
  onStartRun?: () => void;
  onCancelRun?: () => void;
}

function executionFor(value: ReplicationPlan) {
  return value.execution || { adapter: 'node' as const, entrypoint: '', args: [] };
}

function artifactDeclarations(value: ReplicationPlan) {
  return (value.artifacts || []).map((artifact) => artifact.path).join('\n');
}

export function ReplicationStage({ selectedPapers, value, busy = false, stageApproved = false, stageStatus = 'in_progress', run, onChange, onSavePlan, onSkip, onCreateRun, onApproveRun, onStartRun, onCancelRun }: ReplicationStageProps) {
  const qualityPassed = selectedPapers.filter((paper) => paper.eligibility === 'pass').length;
  const execution = executionFor(value);
  const hasRequiredPreparation = Boolean(value.repository.trim() && value.environment.trim() && value.dataset.trim() && value.datasetVersion?.trim() && value.note.trim());
  const canCreateRun = stageApproved && hasRequiredPreparation && Boolean(execution.entrypoint.trim());
  const metrics = run?.metrics || [];
  return (
    <div className="research-page-stack">
      <section className="research-panel">
        <div className="research-panel-heading">
          <div><span className="research-overline">OPTIONAL REPRODUCTION</span><h3>验证已有工作</h3></div>
          <span className="research-status-note">{value.status || (stageApproved ? '已确认' : '待确认')}</span>
        </div>
        <p className="research-panel-copy">记录已有代码、数据和环境，并注明版本、预期指标及缺失材料。保存计划不代表复现成功；受控 Run 只使用项目内入口，不会下载、安装或执行外部命令。</p>
        <div className="research-summary-grid research-summary-grid-compact"><div><strong>{selectedPapers.length}</strong><span>已选论文</span></div><div><strong>{qualityPassed}</strong><span>通过质量门禁</span></div><div><strong>{stageApproved ? '已确认' : '需确认'}</strong><span>复现阶段</span></div></div>
      </section>
      <section className="research-panel">
        <fieldset className="research-form-grid" disabled={busy || stageApproved}>
          <label className="research-field research-field-wide"><span>代码仓库</span><input value={value.repository} placeholder="仓库 URL 或项目内路径" onChange={(event) => onChange({ ...value, repository: event.target.value })} /></label>
          <label className="research-field"><span>运行环境</span><input value={value.environment} placeholder="例如：Python 3.11 / CUDA 12" onChange={(event) => onChange({ ...value, environment: event.target.value })} /></label>
          <label className="research-field"><span>复现数据集</span><input value={value.dataset} placeholder="名称、版本或访问位置" onChange={(event) => onChange({ ...value, dataset: event.target.value })} /></label>
          <label className="research-field"><span>代码版本</span><input value={value.codeVersion || ''} maxLength={2000} placeholder="commit、tag 或文件摘要；未知可留空" onChange={(event) => onChange({ ...value, codeVersion: event.target.value })} /></label>
          <label className="research-field"><span>数据版本</span><input value={value.datasetVersion || ''} maxLength={2000} placeholder="发布版本、划分或校验和" onChange={(event) => onChange({ ...value, datasetVersion: event.target.value })} /></label>
          <label className="research-field research-field-wide"><span>预期指标与对照</span><textarea value={value.expectedMetrics || ''} rows={3} maxLength={2000} placeholder="来源中的指标、评估条件及允许差异；尚未实测" onChange={(event) => onChange({ ...value, expectedMetrics: event.target.value })} /></label>
          <label className="research-field research-field-wide"><span>材料缺口与版本差异</span><textarea value={value.gaps || ''} rows={3} maxLength={2000} placeholder="缺失数据、版本不符、依赖或环境限制，以及待核查事项" onChange={(event) => onChange({ ...value, gaps: event.target.value })} /></label>
          <label className="research-field research-field-wide"><span>复现备注或跳过原因</span><textarea value={value.note} rows={4} placeholder="写下目标、预期对照或缺失材料。" onChange={(event) => onChange({ ...value, note: event.target.value })} /></label>
        </fieldset>
        <div className="research-panel-footer"><button className="research-button research-button-quiet" disabled={busy || stageApproved} onClick={onSkip} type="button">跳过复现并记录原因</button><button className="research-button research-button-primary" disabled={busy || stageApproved} onClick={onSavePlan} type="button">保存复现计划</button></div>
      </section>
      <section className="research-panel">
        <div className="research-panel-heading"><div><span className="research-overline">CONTROLLED ENTRYPOINT</span><h3>受控执行入口</h3></div><span className="research-status-note">{execution.entrypoint ? '已填写' : '未填写'}</span></div>
        <p className="research-panel-copy">入口和产物声明会进入待审批 Run；来源、数据版本、代码快照和环境记录由服务端从已保存的复现准备生成。</p>
        <fieldset className="research-form-grid" disabled={busy}>
          <label className="research-field"><span>运行适配器</span><select value={execution.adapter} onChange={(event) => onChange({ ...value, execution: { ...execution, adapter: event.target.value as 'node' | 'python' } })}><option value="node">Node.js</option><option value="python">Python</option></select></label>
          <label className="research-field"><span>项目内入口文件</span><input value={execution.entrypoint} placeholder="例如 experiments/reproduce.mjs" onChange={(event) => onChange({ ...value, execution: { ...execution, entrypoint: event.target.value } })} /></label>
          <label className="research-field research-field-wide"><span>入口参数（按空格分隔）</span><input value={execution.args.join(' ')} placeholder="可选" onChange={(event) => onChange({ ...value, execution: { ...execution, args: event.target.value.split(' ').filter(Boolean) } })} /></label>
          <label className="research-field"><span>运行上限（分钟）</span><input type="number" min="1" max="1440" value={Math.round((value.resources?.timeoutMs || 600000) / 60000)} onChange={(event) => onChange({ ...value, resources: { ...value.resources, timeoutMs: Math.max(1, Number(event.target.value) || 1) * 60000 } })} /></label>
          <label className="research-field research-field-wide"><span>声明产物路径（每行一个）</span><textarea value={artifactDeclarations(value)} rows={3} placeholder={'results/metrics.json\nresults/figure.svg'} onChange={(event) => onChange({ ...value, artifacts: event.target.value.split('\n').map((item) => item.trim()).filter(Boolean).map((path, index) => ({ path, kind: index === 0 ? 'metric' : 'output' })) })} /></label>
        </fieldset>
        <div className="research-panel-footer"><span>{!stageApproved ? '请先保存计划并人工确认复现阶段。' : !hasRequiredPreparation ? '还缺少服务端要求的复现准备字段。' : !execution.entrypoint.trim() ? '请填写项目内执行入口。' : '创建后仍需单独批准，系统不会自动启动。'}</span><button className="research-button research-button-primary" disabled={busy || !canCreateRun || Boolean(run && !['completed', 'failed', 'cancelled', 'rejected'].includes(run.status))} onClick={onCreateRun} type="button">{run ? '创建新的复现 Run' : '创建待审批 Run'}</button></div>
      </section>
      <section className="research-panel">
        <div className="research-panel-heading"><div><span className="research-overline">RUN MANIFEST</span><h3>复现运行状态</h3></div><span className="research-status-note">{run?.status || '尚未创建'}</span></div>
        {!run ? <div className="research-empty-inline">创建 Run 后，服务端生成的来源快照、代码版本和数据版本会在这里显示。</div> : <>
          <dl className="research-run-summary"><div><dt>来源阶段</dt><dd>{run.manifest?.replication?.sourceStage || 'replication'}</dd></div><div><dt>数据版本</dt><dd>{run.manifest?.dataset?.version || '未记录'}</dd></div><div><dt>代码快照</dt><dd>{(run.manifest?.code?.snapshotHash || '未记录').slice(0, 16)}</dd></div><div><dt>入口</dt><dd>{run.manifest?.command?.entrypoint || '受控适配器'}</dd></div></dl>
          <div className="research-callout"><strong>证据状态</strong><p>{run.status === 'completed' ? '产物已归档为 pending，仍需人工核对后确认；运行成功不等于科学结论。' : run.status === 'failed' || run.status === 'cancelled' ? '该 Run 保持 unverified，未视为复现成功。' : '结果尚未完成，不能作为科学证据。'}</p></div>
          {run.error?.message && <div className="research-callout research-callout-warning"><strong>运行失败</strong><p>{run.error.message}</p></div>}
          <div className="research-inline-actions">{run.status === 'awaiting_approval' && onApproveRun && <button className="research-button research-button-primary" disabled={busy} onClick={onApproveRun} type="button">批准运行</button>}{run.status === 'approved' && onStartRun && <button className="research-button research-button-primary" disabled={busy} onClick={onStartRun} type="button">启动运行</button>}{['awaiting_approval', 'approved', 'running'].includes(run.status) && onCancelRun && <button className="research-button research-button-quiet" disabled={busy} onClick={onCancelRun} type="button">取消运行</button>}</div>
          {Boolean(run.artifacts?.length) && <div className="research-artifact-list"><strong>已归档产物（待人工验证）</strong>{(run.artifacts || []).map((artifact) => <span key={artifact.id}>{artifact.kind} · {artifact.name} · {artifact.sha256.slice(0, 12)}</span>)}</div>}
          {metrics.length > 0 && <div className="research-metric-table"><div><span>指标</span><span>结果</span><span>不确定性</span></div>{metrics.map((metric) => <div key={metric.name}><span>{metric.name}</span><strong>{metric.value === undefined || metric.value === null ? '等待结果' : String(metric.value)}</strong><span>{metric.uncertainty === undefined || metric.uncertainty === null ? '—' : String(metric.uncertainty)}</span></div>)}</div>}
        </>}
      </section>
    </div>
  );
}
