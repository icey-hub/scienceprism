import type { WritingEvidenceSummary } from '../researchStages';

export interface WritingStageProps {
  value: WritingEvidenceSummary;
  busy?: boolean;
  onOutlineChange: (outline: string) => void;
  onPrepareWriting: () => void;
  onOpenEditor: () => void;
}

export function WritingStage({ value, busy = false, onOutlineChange, onPrepareWriting, onOpenEditor }: WritingStageProps) {
  return (
    <div className="research-page-stack">
      <section className="research-panel research-writing-summary">
        <div>
          <span className="research-overline">EVIDENCE HANDOFF</span>
          <h3>在同一项目中进入论文写作</h3>
          <p>只将已确认的论文、创新点、方法和实验结果带入正文，避免把未经验证的内容写成结论。</p>
        </div>
        <div className="research-summary-grid research-summary-grid-compact">
          <div><strong>{value.paperCount}</strong><span>已确认论文</span></div>
          <div><strong>{value.innovationCount}</strong><span>已确认创新点</span></div>
          <div><strong>{value.metricCount}</strong><span>实验指标</span></div>
        </div>
      </section>
      <section className="research-panel">
        <div className="research-panel-heading"><div><span className="research-overline">OUTLINE</span><h3>论文结构建议</h3></div><span className={`research-status-note${value.ready ? ' is-ready' : ''}`}>{value.ready ? '材料已就绪' : '等待整理'}</span></div>
        <label className="research-field"><span>提纲与证据映射</span><textarea value={value.outline} rows={10} placeholder="先生成并确认论文提纲，再在编辑器中扩写正文。" onChange={(event) => onOutlineChange(event.target.value)} /></label>
        <div className="research-panel-footer">
          <p>正文编辑、引用和 PDF 预览仍由当前项目的编辑器承载。</p>
          <div className="research-inline-actions"><button className="research-button research-button-quiet" disabled={busy} onClick={onPrepareWriting} type="button">整理写作材料</button><button className="research-button research-button-primary" disabled={busy || !value.ready} onClick={onOpenEditor} type="button">打开论文编辑器</button></div>
        </div>
      </section>
    </div>
  );
}
