import { useEffect, useRef, useState } from 'react';
import { confirmProjectPaperSource, lookupProjectPaperSource, type PaperLibraryRecord, type PaperSourceLookup } from '../../api/projectAdapter';

const labels: Record<string, string> = { title: '标题', authors: '作者', year: '年份', venue: '期刊/会议', url: '链接', abstract: '摘要', externalVersion: '来源版本' };
const display = (value: unknown) => value == null || value === '' ? '未提供' : Array.isArray(value) ? value.join('、') || '未提供' : typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
const versionOf = (preview: PaperSourceLookup) => preview.externalVersion ?? preview.candidate.sourceRecords?.[0]?.externalVersion;

export function SourceReviewHistory({ paper }: { paper: PaperLibraryRecord }) {
  if (!paper.sourceReviews?.length) return null;
  return <details className="hub-source-history">
    <summary>来源审阅记录（{paper.sourceReviews.length}）</summary>
    <p className="hub-muted">书目审阅不代表科学结论已核实。</p>
    {paper.sourceReviews.map((review) => <article key={review.id}>
      <strong>{review.provider} · {review.identifier}</strong>
      <p>来源版本：{review.externalVersion || '未提供'} · 抓取时间：{review.retrievedAt}</p>
      <p>人工决定：{review.decision.action === 'create' ? '创建论文' : '合并书目'} · {review.decision.fields.map((field) => labels[field] || field).join('、') || (review.decision.action === 'merge' ? '仅保存来源审阅' : '全部候选字段')}</p>
      <p>审阅人：{review.decision.actor} · {review.decision.at}</p>
      <details><summary>原始来源记录</summary><pre>{display(review.record)}</pre></details>
    </article>)}
  </details>;
}

export function PaperSourceReview({ projectId, papers, onSaved }: { projectId: string; papers: PaperLibraryRecord[]; onSaved: () => Promise<void> }) {
  const [provider, setProvider] = useState<'doi' | 'arxivId'>('doi');
  const [identifier, setIdentifier] = useState('');
  const [preview, setPreview] = useState<PaperSourceLookup | null>(null);
  const [action, setAction] = useState<'create' | 'keep' | 'merge'>('keep');
  const [paperId, setPaperId] = useState('');
  const [fields, setFields] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const match = preview?.matches.find((item) => item.paperId === paperId);
  const target = papers.find((paper) => paper.id === paperId);

  async function lookup() {
    setBusy(true); setPreview(null); setMessage('正在查询来源…');
    try {
      const result = await lookupProjectPaperSource(projectId, provider === 'doi' ? { doi: identifier.trim() } : { arxivId: identifier.trim() });
      if (!alive.current) return;
      setPreview(result.lookup); setAction(result.lookup.matches.length ? 'keep' : 'create');
      setPaperId(result.lookup.matches.length === 1 ? result.lookup.matches[0].paperId : ''); setFields([]);
      setMessage('查询完成，尚未写入资料库。请审阅后确认。');
    } catch (error) { if (alive.current) setMessage(`查询失败：${error instanceof Error ? error.message : String(error)}`); }
    finally { if (alive.current) setBusy(false); }
  }

  async function confirm() {
    if (!preview || (action === 'merge' && !match)) return;
    if (Date.parse(preview.expiresAt) <= Date.now()) { setPreview(null); setMessage('预览已过期，输入已保留，请重新查询。'); return; }
    setBusy(true);
    try {
      await confirmProjectPaperSource(projectId, { previewToken: preview.previewToken, action, ...(action === 'merge' ? { paperId, fields } : {}) });
      if (!alive.current) return;
      setPreview(null); setMessage(action === 'keep' ? '已保留资料，未写入本次来源审阅。' : '已保存书目与来源审阅；科学结论仍待核实。');
      if (action !== 'keep') await onSaved().catch(() => { if (alive.current) setMessage('来源审阅已保存，但列表刷新失败；请刷新页面查看。'); });
    } catch (error) {
      if (!alive.current) return;
      setPreview(null);
      setMessage(`确认未完成：${error instanceof Error ? error.message : String(error)}。输入已保留，请先刷新资料，再重新查询。`);
    } finally { if (alive.current) setBusy(false); }
  }

  return <section className="hub-panel hub-source-panel" aria-label="来源查询与审阅" aria-busy={busy}>
    <div className="hub-section-heading"><h3>查询 DOI / arXiv 来源</h3><span className="hub-muted">查询 → 审阅 → 人工确认</span></div>
    <form className="hub-source-query" onSubmit={(event) => { event.preventDefault(); if (!busy && identifier.trim()) void lookup(); }}>
      <label>来源<select value={provider} disabled={busy} onChange={(event) => { setProvider(event.target.value as 'doi' | 'arxivId'); setPreview(null); setMessage(''); }}><option value="doi">DOI（Crossref）</option><option value="arxivId">arXiv</option></select></label>
      <label>来源标识<input value={identifier} disabled={busy} onChange={(event) => { setIdentifier(event.target.value); setPreview(null); setMessage(''); }} placeholder={provider === 'doi' ? '10.1038/nphys1170 或 DOI 地址' : '1706.03762v1 或 arXiv 地址'} /></label>
      <button className="hub-small-button" disabled={busy || !identifier.trim()}>查询来源</button>
    </form>
    <p className="hub-muted">arXiv 可指定 v1 等版本；未指定时查询最新版本。来源身份匹配和字段完整性不代表科学结论已核实。</p>
    <p role="status">{message}</p>
    {preview && <div className="hub-source-preview">
      <h4>{preview.candidate.title || '无标题'}</h4>
      <p>{(preview.candidate.authors || []).join('、') || '作者未提供'} · {preview.candidate.year || '年份未提供'}</p>
      <p>来源：{preview.provider} · {preview.identifier} · {preview.provider === 'arxiv' ? `请求版本：${preview.requestedVersion || '最新'}` : 'DOI 元数据'}</p>
      <p>返回版本：{versionOf(preview) || '未提供'} · 抓取时间：{preview.retrievedAt}</p>
      <div className="hub-import-flags"><span>{preview.checks.fields.status === 'complete' ? '字段完整' : `字段待补：${preview.checks.fields.issues.join('、')}`}</span><span>{preview.checks.source.status === 'identifier-matched' ? '来源标识匹配' : '来源标识待核对'}</span><span className="is-warning">科学结论未核实</span></div>
      <details><summary>查看候选字段与原始来源</summary><dl>{preview.allowedFields.map((field) => <div key={field}><dt>{labels[field] || field}</dt><dd>{display(preview.candidate[field as keyof PaperLibraryRecord])}</dd></div>)}</dl><pre>{display(preview.record)}</pre></details>
      <p>{preview.matches.length ? `项目内有 ${preview.matches.length} 条同标识资料，默认保留。` : '项目中尚无同标识资料。'}</p>
      <fieldset disabled={busy}><legend>写入决定</legend><div className="hub-source-decisions">
        {!preview.matches.length && <label><input type="radio" name="source-action" checked={action === 'create'} onChange={() => setAction('create')} />创建论文</label>}
        <label><input type="radio" name="source-action" checked={action === 'keep'} onChange={() => setAction('keep')} />{preview.matches.length ? '保留已有资料' : '跳过，不写入'}</label>
        {!!preview.matches.length && <label><input type="radio" name="source-action" checked={action === 'merge'} onChange={() => setAction('merge')} />选择字段合并</label>}
      </div>
      {action === 'merge' && <div className="hub-source-merge">
        <label>合并到<select value={paperId} onChange={(event) => { setPaperId(event.target.value); setFields([]); }}><option value="">请选择资料</option>{preview.matches.map((item) => <option key={item.paperId} value={item.paperId}>{papers.find((paper) => paper.id === item.paperId)?.title || item.paperId}</option>)}</select></label>
        <p className="hub-muted">只覆盖勾选字段；不勾选时仅保存来源审阅。笔记、标签、批注和 BibTeX 保留。</p>
        {match && <><ul className="hub-source-differences">{match.conflicts.map((conflict) => <li key={conflict.field}><b>{labels[conflict.field] || conflict.field}</b> · 现有：{display(conflict.local)} → 来源：{display(conflict.external)}</li>)}</ul>
          {preview.allowedFields.map((field) => <label className="hub-source-field" key={field}><input type="checkbox" checked={fields.includes(field)} onChange={() => setFields((current) => current.includes(field) ? current.filter((item) => item !== field) : [...current, field])} /><span><b>{labels[field] || field}</b><small>现有：{display(match.conflicts.some((conflict) => conflict.field === field) ? match.conflicts.find((conflict) => conflict.field === field)?.local : target?.[field as keyof PaperLibraryRecord])}</small><small>来源：{display(preview.candidate[field as keyof PaperLibraryRecord])}</small></span></label>)}</>}
      </div>}
      <button className="hub-small-button hub-source-confirm" onClick={() => void confirm()} disabled={action === 'merge' && !match}>确认本次决定</button>
      </fieldset>
      <p className="hub-muted">预览有效至 {new Date(preview.expiresAt).toLocaleTimeString()}；资料发生变化后需重新查询。</p>
    </div>}
  </section>;
}
