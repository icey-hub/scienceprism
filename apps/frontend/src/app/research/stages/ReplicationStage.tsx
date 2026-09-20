import type { PaperCandidate, ReplicationPlan } from '../researchStages';

export interface ReplicationStageProps {
  selectedPapers: readonly PaperCandidate[];
  value: ReplicationPlan;
  busy?: boolean;
  onChange: (next: ReplicationPlan) => void;
  onSavePlan: () => void;
  onSkip: () => void;
}

export function ReplicationStage({ selectedPapers, value, busy = false, onChange, onSavePlan, onSkip }: ReplicationStageProps) {
  const qualityPassed = selectedPapers.filter((paper) => paper.eligibility === 'pass').length;

  return (
    <div className="research-page-stack">
      <section className="research-panel">
        <div className="research-panel-heading">
          <div>
            <span className="research-overline">OPTIONAL REPRODUCTION</span>
            <h3>验证已有工作</h3>
          </div>
          <span className="research-status-note">可选阶段</span>
        </div>
        <p className="research-panel-copy">记录代码、数据和环境的复现准备情况。此阶段只保存计划，不会执行外部命令。</p>
        <div className="research-summary-grid research-summary-grid-compact">
          <div><strong>{selectedPapers.length}</strong><span>已选论文</span></div>
          <div><strong>{qualityPassed}</strong><span>通过质量门禁</span></div>
          <div><strong>H</strong><span>人工决定是否复现</span></div>
        </div>
      </section>
      <section className="research-panel">
        <div className="research-form-grid">
          <label className="research-field research-field-wide"><span>代码仓库</span><input value={value.repository} placeholder="仓库 URL 或项目内路径" onChange={(event) => onChange({ ...value, repository: event.target.value })} /></label>
          <label className="research-field"><span>运行环境</span><input value={value.environment} placeholder="例如：Python 3.11 / CUDA 12" onChange={(event) => onChange({ ...value, environment: event.target.value })} /></label>
          <label className="research-field"><span>复现数据集</span><input value={value.dataset} placeholder="名称、版本或访问位置" onChange={(event) => onChange({ ...value, dataset: event.target.value })} /></label>
          <label className="research-field research-field-wide"><span>复现备注或跳过原因</span><textarea value={value.note} rows={4} placeholder="写下目标、预期对照或缺失材料。" onChange={(event) => onChange({ ...value, note: event.target.value })} /></label>
        </div>
        <div className="research-panel-footer">
          <button className="research-button research-button-quiet" disabled={busy} onClick={onSkip} type="button">跳过复现并记录原因</button>
          <button className="research-button research-button-primary" disabled={busy} onClick={onSavePlan} type="button">保存复现计划</button>
        </div>
      </section>
    </div>
  );
}
