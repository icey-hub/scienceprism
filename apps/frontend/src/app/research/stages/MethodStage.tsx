import type { MethodDraft } from '../researchStages';

export interface MethodStageProps {
  value: MethodDraft;
  selectedIdeaCount: number;
  busy?: boolean;
  onChange: (next: MethodDraft) => void;
  onGenerate: () => void;
  onSave: () => void;
}

function toLines(value: string) {
  return value.split('\n').map((item) => item.trim()).filter(Boolean);
}

export function MethodStage({ value, selectedIdeaCount, busy = false, onChange, onGenerate, onSave }: MethodStageProps) {
  return (
    <div className="research-page-stack">
      <section className="research-panel">
        <div className="research-panel-heading">
          <div>
            <span className="research-overline">METHOD SKETCH</span>
            <h3>把创新点变成实验假设</h3>
          </div>
          <div className="research-inline-actions">
            <button className="research-button research-button-secondary" disabled={busy || selectedIdeaCount === 0} onClick={onGenerate} type="button">让 AI 起草方法</button>
            <button className="research-button research-button-quiet" disabled={busy || !value.title.trim()} onClick={onSave} type="button">保存草案</button>
          </div>
        </div>
        <div className="research-form-grid">
          <label className="research-field research-field-wide"><span>方法名称</span><input value={value.title} placeholder="例如：Evidence-Gated Retrieval" onChange={(event) => onChange({ ...value, title: event.target.value })} /></label>
          <label className="research-field research-field-wide"><span>核心假设</span><textarea value={value.hypothesis} rows={4} placeholder="什么机制会带来可测量的改善？" onChange={(event) => onChange({ ...value, hypothesis: event.target.value })} /></label>
          <label className="research-field"><span>基线方法 <small>每行一个</small></span><textarea value={value.baselines.join('\n')} rows={4} placeholder="RAG baseline" onChange={(event) => onChange({ ...value, baselines: toLines(event.target.value) })} /></label>
          <label className="research-field"><span>消融实验 <small>每行一个</small></span><textarea value={value.ablations.join('\n')} rows={4} placeholder="移除 evidence gate" onChange={(event) => onChange({ ...value, ablations: toLines(event.target.value) })} /></label>
        </div>
      </section>
      <section className="research-callout research-callout-warning"><strong>进入实验前的人工检查</strong><p>核心假设、基线、指标和消融设置必须足够明确，才能进入实验验证。</p></section>
    </div>
  );
}
