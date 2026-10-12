import { useState } from 'react';
import { importRankingCatalog, type RankingCatalogue } from '../../api/paperRankingsAdapter';
import { readerError } from '../../api/paperReaderAdapter';
export function RankingCatalogManager({ projectId, data, onChanged }: { projectId: string; data: RankingCatalogue | null; onChanged: () => Promise<void> }) {
  const [scheme, setScheme] = useState('CCF');
  const [year, setYear] = useState(new Date().getFullYear());
  const [label, setLabel] = useState('');
  const [source, setSource] = useState('');
  const [url, setUrl] = useState('');
  const [csv, setCsv] = useState('');
  const [replace, setReplace] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  return <details className="ranking-manager"><summary>分级目录与来源</summary><p>等级来自已导入的期刊/会议目录。目录年份与论文发表年份分别显示，多个学科等级分别保留。</p>
    {data?.catalogs.filter(item => !item.supersededBy).map(item => <article key={item.id}><strong>{item.label}</strong><span>{item.scheme} · {item.editionYear} · {item.recordCount} 条</span><small>{item.provenance.label}{item.provenance.url && <> · <a href={item.provenance.url} target="_blank" rel="noreferrer">来源说明</a></>}</small></article>)}
    {!data?.catalogs.some(item => !item.supersededBy) && <p>尚未导入目录。当前结果会显示“等级未匹配”。</p>}
    <form onSubmit={event => { event.preventDefault(); if (!data || busy) return; setBusy(true); setMessage(''); void importRankingCatalog(projectId, { expectedVersion: data.version, scheme, editionYear: year, label, provenance: { label: source, ...(url ? { url } : {}) }, csv, ...(replace ? { replaceCatalogId: replace } : {}) }).then(async result => { await onChanged(); setMessage(result.duplicate ? '相同目录已经存在。' : '目录已导入，重新搜索即可应用。'); }).catch(cause => setMessage(readerError(cause))).finally(() => setBusy(false)); }}>
      <h3>导入目录</h3><label>分级体系<select value={scheme} onChange={event => setScheme(event.target.value)}>{['CCF', 'JCR', 'CAS', 'custom'].map(item => <option key={item} value={item}>{item === 'custom' ? '自定义' : item}</option>)}</select></label><label>目录年份<input type="number" min={1900} max={2100} value={year} onChange={event => setYear(Number(event.target.value))} required /></label><label>目录名称<input value={label} onChange={event => setLabel(event.target.value)} maxLength={200} required /></label><label>来源说明<input value={source} onChange={event => setSource(event.target.value)} placeholder="目录发布单位或文件出处" required maxLength={300} /></label><label>来源链接（可选）<input value={url} onChange={event => setUrl(event.target.value)} type="url" /></label><label>导入方式<select value={replace} onChange={event => setReplace(event.target.value)}><option value="">新增目录</option>{data?.catalogs.filter(item => !item.supersededBy).map(item => <option key={item.id} value={item.id}>替换 {item.label}（保留历史）</option>)}</select></label><label>CSV 内容<textarea value={csv} onChange={event => setCsv(event.target.value)} rows={5} placeholder={'venue,issns,subject,rank\n填写期刊或会议全名，ISSN、学科和等级'} required /></label><small>表头为 venue,issns,subject,rank。JCR：Q1–Q4；CAS：1–4；CCF：A–C。仅导入你可使用的目录数据。</small><button disabled={busy || !data}>{busy ? '导入中…' : '导入分级目录'}</button>{message && <p role="status">{message}</p>}
    </form>
  </details>;
}
