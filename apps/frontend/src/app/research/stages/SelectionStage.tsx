import type { FilterPolicy, PaperCandidate } from '../researchStages';

export interface SelectionStageProps {
  policy: FilterPolicy;
  papers: readonly PaperCandidate[];
  selectedPaperIds: readonly string[];
  filterValue: string;
  totalCandidateCount: number;
  busy?: boolean;
  onPolicyChange: (next: FilterPolicy) => void;
  onSavePolicy: () => void;
  onFilterValueChange: (value: string) => void;
  onTogglePaper: (paperId: string, selected: boolean) => void;
  onSaveSelection: () => void;
  onOpenSearchStage: () => void;
}

function eligibilityLabel(eligibility?: PaperCandidate['eligibility']) {
  if (eligibility === 'pass') return '规则通过';
  if (eligibility === 'reject') return '规则拒绝';
  return '待核验';
}

export function SelectionStage({
  policy,
  papers,
  selectedPaperIds,
  filterValue,
  totalCandidateCount,
  busy = false,
  onPolicyChange,
  onSavePolicy,
  onFilterValueChange,
  onTogglePaper,
  onSaveSelection,
  onOpenSearchStage
}: SelectionStageProps) {
  const selected = (id: string) => selectedPaperIds.includes(id);

  return (
    <div className="research-page-stack">
      <section className="research-panel">
        <div className="research-panel-heading">
          <div>
            <span className="research-overline">HARD FILTERS</span>
            <h3>质量规则</h3>
          </div>
          <span className="research-server-chip">服务端强制</span>
        </div>
        <div className="research-policy-grid">
          <label className="research-field"><span>会议 / 期刊等级</span><select value={policy.venueLevel} onChange={(event) => onPolicyChange({ ...policy, venueLevel: event.target.value as FilterPolicy['venueLevel'] })}><option value="CCF-A">CCF-A</option><option value="CCF-B">CCF-B</option><option value="CCF-C">CCF-C</option><option value="Any">不限</option></select></label>
          <label className="research-field"><span>出版物类型</span><select value={policy.publicationType} onChange={(event) => onPolicyChange({ ...policy, publicationType: event.target.value as FilterPolicy['publicationType'] })}><option value="Any">期刊或会议</option><option value="journal">仅期刊</option><option value="conference">仅会议</option></select></label>
          <label className="research-field"><span>发表年份</span><span className="research-range-fields"><input aria-label="起始年份" value={policy.yearFrom} onChange={(event) => onPolicyChange({ ...policy, yearFrom: event.target.value })} /><b>&ndash;</b><input aria-label="结束年份" value={policy.yearTo} onChange={(event) => onPolicyChange({ ...policy, yearTo: event.target.value })} /></span></label>
          <label className="research-check-row"><input checked={policy.peerReviewed} onChange={(event) => onPolicyChange({ ...policy, peerReviewed: event.target.checked })} type="checkbox" /><span>仅同行评审</span></label>
          <label className="research-check-row"><input checked={policy.requireCode} onChange={(event) => onPolicyChange({ ...policy, requireCode: event.target.checked })} type="checkbox" /><span>需要公开代码</span></label>
        </div>
        <div className="research-panel-footer">
          <p>未知 CCF 元数据必须人工核验，不能直接勾选。</p>
          <button className="research-button research-button-quiet" disabled={busy} onClick={onSavePolicy} type="button">保存筛选规则</button>
        </div>
      </section>

      <section className="research-list-section">
        <div className="research-list-toolbar">
          <p><strong>{papers.length}</strong> / {totalCandidateCount} 篇候选论文，已选 {selectedPaperIds.length} 篇</p>
          <input aria-label="筛选论文" value={filterValue} placeholder="筛选标题、作者或 venue" onChange={(event) => onFilterValueChange(event.target.value)} />
          <button className="research-button research-button-secondary" disabled={busy || selectedPaperIds.length === 0} onClick={onSaveSelection} type="button">保存选择</button>
        </div>
        {papers.length === 0 ? (
          <div className="research-empty-state">
            <h3>还没有可筛选的论文</h3>
            <p>先运行论文检索，或等待后端返回候选结果。</p>
            <button className="research-link-button" onClick={onOpenSearchStage} type="button">前往论文检索</button>
          </div>
        ) : (
          <div className="research-paper-list">
            {papers.map((paper) => {
              const canSelect = paper.eligibility === 'pass';
              return (
                <article className={`research-paper-row${selected(paper.id) ? ' is-selected' : ''}`} key={paper.id}>
                  <label className="research-paper-select">
                    <input aria-label={`选择论文：${paper.title}`} checked={selected(paper.id)} disabled={!canSelect || busy} onChange={(event) => onTogglePaper(paper.id, event.target.checked)} type="checkbox" />
                  </label>
                  <div className="research-paper-copy">
                    <div><h3>{paper.title}</h3><span className={`research-eligibility is-${paper.eligibility || 'review'}`}>{eligibilityLabel(paper.eligibility)}</span></div>
                    <p>{paper.venue || '未知 venue'} · {paper.year || '年份未知'}{paper.authors?.length ? ` · ${paper.authors.slice(0, 3).join(', ')}${paper.authors.length > 3 ? ' 等' : ''}` : ''}</p>
                    <small>{paper.reason || '等待质量门禁返回筛选依据。'}</small>
                  </div>
                  <div className="research-paper-score"><strong>{paper.ccf || '—'}</strong><span>CCF</span>{typeof paper.quality === 'number' && <small>{paper.quality}/100</small>}</div>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
