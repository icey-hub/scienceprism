import type { FilterPolicy, PaperCandidate, PaperReview } from '../researchStages';

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
  onReviewChange: (review: PaperReview) => void;
  onSaveSelection: () => void;
  onOpenSearchStage: () => void;
}

function eligibilityLabel(eligibility?: PaperCandidate['eligibility']) {
  if (eligibility === 'pass') return '规则通过';
  if (eligibility === 'reject') return '规则拒绝';
  return '待核验';
}

function safeSourceUrl(value?: string) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

function sourceLabel(record: NonNullable<PaperCandidate['sourceRecords']>[number]) {
  return [record.provider, record.id, record.retrievedAt ? `抓取时间：${record.retrievedAt}` : '抓取时间未记录'].filter(Boolean).join(' · ');
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
  onReviewChange,
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
          <button className="research-button research-button-secondary" disabled={busy || totalCandidateCount === 0} onClick={onSaveSelection} type="button">保存选择</button>
        </div>
        <p>人工决定与理由需点击「保存选择」保存。取消纳入不会删除已有证据；进入下一阶段仍需人工确认。</p>
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
              const sourceUrl = safeSourceUrl(paper.url);
              const review = paper.humanReview || { paperId: paper.id, decision: selected(paper.id) ? 'include' as const : 'undecided' as const, reason: '', criterion: '' };
              const updateReview = (patch: Partial<PaperReview>) => onReviewChange({ ...review, ...patch, paperId: paper.id });
              return (
                <article className={`research-paper-row${selected(paper.id) ? ' is-selected' : ''}`} key={paper.id}>
                  <label className="research-paper-select">
                    <input aria-label={`选择论文：${paper.title}`} checked={review.decision === 'include'} disabled={!canSelect || busy} onChange={(event) => updateReview({ decision: event.target.checked ? 'include' : 'undecided' })} type="checkbox" />
                  </label>
                  <div className="research-paper-copy">
                    <div><h3>{paper.title}</h3><span className={`research-eligibility is-${paper.eligibility || 'review'}`}>{eligibilityLabel(paper.eligibility)}</span></div>
                    <p>{paper.venue || '未知 venue'} · {paper.year || '年份未知'}{paper.authors?.length ? ` · ${paper.authors.slice(0, 3).join(', ')}${paper.authors.length > 3 ? ' 等' : ''}` : ''}</p>
                    <small>{paper.reason || '等待质量门禁返回筛选依据。'}</small>
                    <details className="research-paper-materials">
                      <summary>摘要与来源：{paper.title}</summary>
                      <p>{paper.abstract || '未记录摘要，请打开来源核对或补充材料。'}</p>
                      <small>摘要用于初筛，不等于已读取全文；来源链接也不代表全文可获取或结论已验证。</small>
                      {sourceUrl ? <p><a href={sourceUrl} target="_blank" rel="noopener noreferrer">打开来源材料（新标签页）</a></p> : <p>未记录可打开的 HTTP(S) 来源链接。</p>}
                      {paper.sourceRecords?.length ? <ul>{paper.sourceRecords.map((record, index) => <li key={index}>{sourceLabel(record) || '来源记录缺少详情'}</li>)}</ul> : <p>未记录来源详情{paper.source ? `（标记来源：${paper.source}）` : ''}。</p>}
                    </details>
                    <details className="research-paper-review">
                      <summary>人工筛选理由与标准{review.reason ? ' · 已填写理由' : ' · 未填写理由'}</summary>
                      <label className="research-field"><span>人工决定</span><select aria-label={`人工决定：${paper.title}`} value={review.decision} disabled={busy} onChange={(event) => updateReview({ decision: event.target.value as PaperReview['decision'] })}>
                        <option value="undecided">待定</option><option value="include" disabled={!canSelect}>纳入</option><option value="exclude">排除</option>
                      </select></label>
                      <label className="research-field"><span>理由（可选）</span><textarea aria-label={`筛选理由：${paper.title}`} maxLength={2000} value={review.reason} disabled={busy} onChange={(event) => updateReview({ reason: event.target.value })} placeholder="记录这篇论文为何纳入、排除或待定" rows={2} /></label>
                      <label className="research-field"><span>对应标准（可选）</span><input aria-label={`筛选标准：${paper.title}`} maxLength={2000} value={review.criterion} disabled={busy} onChange={(event) => updateReview({ criterion: event.target.value })} placeholder="例如：报告可复现实验" /></label>
                      <button className="research-link-button" disabled={busy} onClick={() => updateReview({ decision: 'undecided', reason: '', criterion: '' })} type="button">撤销决定并清空理由</button>
                    </details>
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
