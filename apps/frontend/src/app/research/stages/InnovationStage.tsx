import type { InnovationIdea } from '../researchStages';

export interface InnovationStageProps {
  ideas: readonly InnovationIdea[];
  comparison?: readonly { ideaId: string; strengths: string[]; weaknesses: string[]; differentiator: string }[];
  humanDirection?: string;
  caveats?: readonly string[];
  selectedIdeaIds: readonly string[];
  selectedPaperCount: number;
  busy?: boolean;
  onGenerate: () => void;
  onToggleIdea: (ideaId: string, selected: boolean) => void;
  onConditionChange: (ideaId: string, condition: string) => void;
  onSaveSelection: () => void;
}

export function InnovationStage({ ideas, comparison = [], humanDirection = '', caveats = [], selectedIdeaIds, selectedPaperCount, busy = false, onGenerate, onToggleIdea, onConditionChange, onSaveSelection }: InnovationStageProps) {
  return (
    <div className="research-page-stack">
      <section className="research-panel research-split-panel">
        <div>
          <span className="research-overline">ASSISTED DISCOVERY</span>
          <h3>从已选论文中寻找可检验的空白</h3>
          <p>AI 将候选创新点绑定到论文证据。只有人工确认的方向会进入方法设计。</p>
        </div>
        <button className="research-button research-button-primary" disabled={busy || selectedPaperCount === 0} onClick={onGenerate} type="button">生成创新点</button>
      </section>
      {ideas.length > 0 && <section className="research-panel" aria-label="创新分析依据与局限">
        <h3>AI 分析依据与局限</h3>
        <p>以下是辅助分析，假设与新颖性仍需研究者核查；查看详情不会选择或批准候选。</p>
        <p><strong>对研究方向的理解：</strong>{humanDirection || '未记录分析依据。'}</p>
        {caveats.length > 0 ? <ul>{caveats.map((caveat, index) => <li key={index}>{caveat}</li>)}</ul> : <p>未记录分析局限，请人工补充核查。</p>}
      </section>}
      {ideas.length === 0 ? (
        <div className="research-empty-state">
          <h3>尚未生成创新点</h3>
          <p>先确认至少一篇通过质量门禁的论文，再运行对比分析。</p>
        </div>
      ) : (
        <section className="research-idea-list" aria-label="创新点候选">
          {ideas.map((idea, index) => {
            const isSelected = selectedIdeaIds.includes(idea.id);
            return (
              <article className={`research-idea-row${isSelected ? ' is-selected' : ''}`} key={idea.id}>
                <label className="research-paper-select"><input aria-label={`选择创新点：${idea.title}`} checked={isSelected} disabled={busy} onChange={(event) => onToggleIdea(idea.id, event.target.checked)} type="checkbox" /></label>
                <div>
                  <span className="research-overline">候选 {String(index + 1).padStart(2, '0')}</span>
                  <h3>{idea.title}</h3>
                  <p>{idea.summary || idea.problem || idea.motivation || '尚未补充候选创新点说明。'}</p>
                  <details className="research-skill-binding-details">
                    <summary>假设与验证详情：{idea.title}</summary>
                    <p><strong>AI 假设：</strong>{idea.hypothesis || '未记录假设。'}</p>
                    <p><strong>创新性主张：</strong>{idea.novelty || '未记录创新性主张。'}</p>
                    <strong>建议验证计划</strong>
                    {idea.validationPlan?.length ? <ol>{idea.validationPlan.map((step, stepIndex) => <li key={stepIndex}>{step}</li>)}</ol> : <p>未记录验证计划。</p>}
                    <strong>已识别风险</strong>
                    {idea.risks?.length ? <ul>{idea.risks.map((risk, riskIndex) => <li key={riskIndex}>{risk}</li>)}</ul> : <p>未记录风险，不代表没有风险。</p>}
                  </details>
                  <div className="research-form-grid">
                    <label className="research-field research-field-wide">
                      <span>人工可证伪条件（可选）</span>
                      <textarea aria-label={`人工可证伪条件：${idea.title}`} aria-describedby={`idea-condition-help-${index}`} disabled={busy} maxLength={2000} rows={3} value={idea.humanReview?.falsificationCondition || ''} onChange={(event) => onConditionChange(idea.id, event.target.value)} placeholder="什么可观察结果会否定这项假设？" />
                      <small id={`idea-condition-help-${index}`}>由研究者填写，可更正或清空。编辑后请保存创新点；填写条件不代表假设已验证。</small>
                    </label>
                  </div>
                  <div className="research-evidence-list">{(idea.evidence || idea.relatedPaperIds || []).map((evidence) => <span key={evidence}>{evidence}</span>)}</div>
                </div>
              </article>
            );
          })}
          <div className="research-list-footer"><p><strong>{selectedIdeaIds.length}</strong> 个创新点将进入方法设计</p><button className="research-button research-button-secondary" disabled={busy} onClick={onSaveSelection} type="button">保存创新点</button></div>
        </section>
      )}
      {comparison.length > 0 && <section className="research-panel"><div className="research-panel-heading"><div><span className="research-overline">CANDIDATE COMPARISON</span><h3>创新点比较</h3></div><span className="research-status-note">辅助分析</span></div><div className="research-comparison-list">{comparison.map((item) => <article className="research-comparison-row" key={item.ideaId}><strong>{ideas.find((idea) => idea.id === item.ideaId)?.title || item.ideaId}</strong><span>优势：{(item.strengths || []).join('；') || '—'}</span><span>风险：{(item.weaknesses || []).join('；') || '—'}</span><small>差异化：{item.differentiator}</small></article>)}</div></section>}
    </div>
  );
}
