import { useEffect, useState, type FormEvent } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, BookOpen, Check, ExternalLink, Search } from 'lucide-react';
import { ProjectWorkspaceFrame } from '../components/ProjectWorkspaceFrame';
import { matchPaper, usePaperSearch } from './usePaperSearch';
import type { SearchCandidate, SearchCriteria } from '../../api/paperSearchAdapter';
import '../ProjectDashboard.css';
import './PaperSearch.css';

function sourceUrl(value?: string) {
  try { const url = new URL(value || ''); return ['http:', 'https:'].includes(url.protocol) ? url.href : undefined; } catch { return undefined; }
}
export default function PaperSearchPage() {
  const { projectId = '' } = useParams();
  return <PaperSearchWorkspace key={projectId} projectId={projectId} />;
}
function PaperSearchWorkspace({ projectId }: { projectId: string }) {
  const controller = usePaperSearch(projectId);
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState(params.get('q') || '');
  const [sources, setSources] = useState(['arxiv']);
  const [pageSize, setPageSize] = useState(20);
  const sessionId = params.get('search');
  const session = controller.data?.sessions.find(item => item.id === sessionId);
  useEffect(() => {
    if (session) { setQuery(session.criteria.query); setSources(session.criteria.sources); setPageSize(session.criteria.pageSize); }
  }, [session]);
  const run = async (criteria: SearchCriteria) => {
    const result = await controller.search(criteria);
    if (result) setParams({ q: result.criteria.query, search: result.id });
  };
  const submit = (event: FormEvent) => { event.preventDefault(); void run({ query, sources, pageSize, offset: 0 }); };
  const libraryHref = `/project/${encodeURIComponent(projectId)}/library`;
  return <ProjectWorkspaceFrame projectId={projectId} projectName={controller.data?.projectName || ''} active="search" title="论文搜索">
    <div className="paper-search-workspace">
      <header className="paper-search-heading"><div><span className="paper-search-eyebrow">RESEARCH LIBRARY</span><h1>从一篇论文，开始探索</h1><p>搜索论文、阅读摘要，把值得深入的研究收进文献库。</p></div><Link className="hub-small-button is-quiet" to={libraryHref}><BookOpen size={16} /> 我的文献库</Link></header>
      <form className="paper-search-form" onSubmit={submit} aria-label="论文检索">
        <div className="paper-search-query"><Search size={21} aria-hidden="true" /><input aria-label="论文关键词" value={query} onChange={event => setQuery(event.target.value)} placeholder="研究问题、论文标题或关键词…" maxLength={1000} required /><button type="submit" disabled={controller.loading || controller.busy || !query.trim() || !sources.length}>{controller.busy ? '检索中…' : '搜索论文'}<ArrowRight size={16} /></button></div>
        <div className="paper-search-filters"><fieldset><legend>论文来源</legend>{controller.data?.sources.map(source => <label key={source.id}><input type="checkbox" checked={sources.includes(source.id)} onChange={event => setSources(value => event.target.checked ? [...value, source.id] : value.filter(id => id !== source.id))} />{source.label}</label>)}</fieldset><label>每页 / 来源<select value={pageSize} onChange={event => setPageSize(Number(event.target.value))}><option value={10}>10 篇</option><option value={20}>20 篇</option><option value={40}>40 篇</option></select></label>{controller.busy && <button type="button" className="paper-search-text-button" onClick={controller.cancel}>取消检索</button>}</div>
      </form>
      {controller.error && <p role="alert" className="paper-search-alert">{controller.error}</p>}
      {controller.notice && <p role="status" className="paper-search-notice">{controller.notice}</p>}
      {controller.loading && <p role="status">正在读取检索记录…</p>}
      <div className="paper-search-body"><section aria-label="检索结果" aria-busy={controller.busy}>
        {session ? <>
          <div className="paper-search-results-heading"><h2>检索结果 <span>{session.candidates.length}</span></h2><small>当前批次 · {new Date(session.createdAt).toLocaleString()}</small></div>
          {session.failures.map((failure, index) => <p key={`${failure.source}:${index}`} role="alert" className="paper-search-alert">{failure.source} 暂未完成：{failure.message}</p>)}
          {!session.candidates.length && <div className="paper-search-empty"><Search size={28} /><h3>{session.status === 'failed' ? '这次检索未能完成' : '没有找到匹配论文'}</h3><p>{session.status === 'failed' ? '检查来源提示后重新搜索。已有文献仍保留在资料库。' : '试试更简短的英文关键词，或调整论文来源。'}</p></div>}
          <div className="paper-search-results">{session.candidates.map(candidate => <PaperResult key={`${candidate.source}:${candidate.id}`} candidate={candidate} saved={controller.papers.some(paper => matchPaper(paper, candidate))} saving={controller.saving === candidate.id} disabled={!!controller.saving} onSave={() => void controller.save(candidate)} libraryHref={libraryHref} />)}</div>
          <nav className="paper-search-pagination" aria-label="检索分页"><button disabled={controller.busy || session.criteria.offset === 0} onClick={() => void run({ ...session.criteria, offset: Math.max(0, session.criteria.offset - session.criteria.pageSize) })}><ArrowLeft size={15} />上一批</button><span>来源偏移 {session.criteria.offset + 1} 起</span><button disabled={controller.busy || session.nextOffset === null} onClick={() => void run({ ...session.criteria, offset: session.nextOffset! })}>下一批<ArrowRight size={15} /></button></nav>
        </> : !controller.loading && <div className="paper-search-empty"><div className="paper-search-empty-icon"><BookOpen size={30} strokeWidth={1.4} /></div><h2>{sessionId ? '这条检索记录已过期' : '找到下一条研究线索'}</h2><p>{sessionId ? '项目保留最近 30 次检索，可使用上方关键词重新搜索。' : '输入一个研究问题或关键词。结果保留来源，随时可以返回继续阅读。'}</p></div>}
      </section><aside className="paper-search-history" aria-label="最近检索"><h2>最近检索</h2>{controller.data?.sessions.length ? controller.data.sessions.slice(0, 12).map(item => <Link key={item.id} aria-current={item.id === sessionId ? 'page' : undefined} to={`?${new URLSearchParams({ q: item.criteria.query, search: item.id })}`}><span>{item.criteria.query}</span><small>{item.status === 'failed' ? '检索失败' : `${item.candidates.length} 篇`} · {new Date(item.createdAt).toLocaleDateString()}</small></Link>) : <p>检索记录会保存在这里。</p>}<div className="paper-search-note"><h3>阅读，从积累开始</h3><p>加入文献库后，可以标记阅读进度、收藏和记录笔记。</p><Link to={libraryHref}>打开文献库 <ArrowRight size={14} /></Link></div></aside></div>
    </div>
  </ProjectWorkspaceFrame>;
}
function PaperResult({ candidate, saved, saving, disabled, onSave, libraryHref }: { candidate: SearchCandidate; saved: boolean; saving: boolean; disabled: boolean; onSave: () => void; libraryHref: string }) {
  const url = sourceUrl(candidate.url);
  return <article className="paper-search-result"><div className="paper-search-result-meta"><span>{candidate.source === 'arxiv' ? 'arXiv' : candidate.source}</span><span>{candidate.year || '年份未知'}</span>{candidate.publicationType === 'preprint' && <span>预印本</span>}{candidate.venue && <span>{candidate.venue}</span>}</div><h3>{url ? <a href={url} target="_blank" rel="noreferrer">{candidate.title}<ExternalLink size={14} /></a> : candidate.title}</h3><p className="paper-search-authors">{candidate.authors?.join(' · ') || '作者信息暂缺'}</p>{candidate.abstract && <details className="paper-search-abstract"><summary>摘要</summary><p>{candidate.abstract}</p></details>}<footer><small>{candidate.doi ? `DOI: ${candidate.doi}` : candidate.arxivId ? `arXiv: ${candidate.arxivId}` : '来源记录已保留'}</small>{saved ? <Link className="paper-search-saved" to={libraryHref}><Check size={15} />已入库</Link> : <button onClick={onSave} disabled={disabled}><BookOpen size={15} />{saving ? '正在入库…' : '加入文献库'}</button>}</footer></article>;
}
