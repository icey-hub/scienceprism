import { getResearchStage, type ResearchStageId } from './researchStages';

type InputStage = Exclude<ResearchStageId, 'writing'>;

const PLACEHOLDERS: Record<InputStage, string> = {
  direction: '补充你的判断和偏好，例如：优先研究可解释性，只考虑公开数据和可复现的方法。',
  search: '补充检索建议，例如：增加反例、负面结果和最新综述，排除只讨论文本生成的论文。',
  selection: '记录选文理由或疑问，例如：优先保留有完整消融的工作；这篇论文的实验设置需要核实。',
  replication: '补充复现目标和限制，例如：先核对原论文的数据划分，再比较不同随机种子的结果。',
  innovation: '输入自己的创新想法或对候选的修改意见，例如：把候选一改为局部解释，并增加稳定性验证。',
  method: '补充方法建议，例如：加入更强的基线，把解释质量和检测性能分别评估。',
  experiment: '记录实验建议和结果解释边界，例如：报告各次运行结果与方差，不把单次提升写成普遍结论。'
};

export function StageHumanInput({ stage, value, savedValue, busy, onChange, onSave }: {
  stage: InputStage;
  value: string;
  savedValue: string;
  busy: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
}) {
  const dirty = value.trim() !== savedValue;
  return <section className="research-panel" aria-label={`${getResearchStage(stage).label}人工建议`}>
    <div className="research-panel-heading">
      <div><span className="research-overline">HUMAN INPUT</span><h3>人工建议</h3></div>
      <span className="research-human-chip">H 人工输入</span>
    </div>
    <p className="research-panel-copy">补充你的想法、修改意见或需要 AI 核查的问题。本阶段及之前阶段的已保存建议会用于后续 AI 分析，不会自动修改已有结果或批准阶段。</p>
    <label className="research-field research-field-wide">
      <span>{getResearchStage(stage).label}的建议 <small>可选</small></span>
      <textarea value={value} rows={3} maxLength={2000} disabled={busy} placeholder={PLACEHOLDERS[stage]} onChange={(event) => onChange(event.target.value)} />
    </label>
    <div className="research-panel-footer">
      <p role="status">{dirty ? '有未保存的修改' : savedValue ? '已保存' : '尚未填写'} · {value.length}/2000</p>
      <button className="research-button research-button-secondary" disabled={busy || !dirty} onClick={onSave} type="button">保存建议</button>
    </div>
  </section>;
}
