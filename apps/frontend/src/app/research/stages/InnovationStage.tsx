import type { InnovationIdea } from '../researchStages';

export interface InnovationStageProps {
  ideas: readonly InnovationIdea[];
  comparison?: readonly { ideaId: string; strengths: string[]; weaknesses: string[]; differentiator: string }[];
  selectedIdeaIds: readonly string[];
  selectedPaperCount: number;
  busy?: boolean;
  onGenerate: () => void;
  onToggleIdea: (ideaId: string, selected: boolean) => void;
  onSaveSelection: () => void;
}

export function InnovationStage({ ideas, comparison = [], selectedIdeaIds, selectedPaperCount, busy = false, onGenerate, onToggleIdea, onSaveSelection }: InnovationStageProps) {
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
                  <div className="research-evidence-list">{(idea.evidence || idea.relatedPaperIds || []).map((evidence) => <span key={evidence}>{evidence}</span>)}</div>
                </div>
              </article>
            );
          })}
          <div className="research-list-footer"><p><strong>{selectedIdeaIds.length}</strong> 个创新点将进入方法设计</p><button className="research-button research-button-secondary" disabled={busy || selectedIdeaIds.length === 0} onClick={onSaveSelection} type="button">保存创新点</button></div>
        </section>
      )}
      {comparison.length > 0 && <section className="research-panel"><div className="research-panel-heading"><div><span className="research-overline">CANDIDATE COMPARISON</span><h3>创新点比较</h3></div><span className="research-status-note">辅助分析</span></div><div className="research-comparison-list">{comparison.map((item) => <article className="research-comparison-row" key={item.ideaId}><strong>{ideas.find((idea) => idea.id === item.ideaId)?.title || item.ideaId}</strong><span>优势：{(item.strengths || []).join('；') || '—'}</span><span>风险：{(item.weaknesses || []).join('；') || '—'}</span><small>差异化：{item.differentiator}</small></article>)}</div></section>}
    </div>
  );
}
