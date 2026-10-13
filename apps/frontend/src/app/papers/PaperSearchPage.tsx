import { lazy, Suspense, useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, BookOpen, Check, ExternalLink, Search } from 'lucide-react';
import { ProjectWorkspaceFrame } from '../components/ProjectWorkspaceFrame';
import { findUniquePaper, usePaperSearch } from './usePaperSearch';
import { getRankingCatalogs, type RankingCatalogue, type RankingFilter } from '../../api/paperRankingsAdapter';
import type { SearchCandidate, SearchCriteria, SearchFilters } from '../../api/paperSearchAdapter';
import type { PaperLibraryRecord } from '../../api/client';
import { RankingCatalogManager } from './RankingCatalogManager';
import { readerError } from '../../api/paperReaderAdapter';
import '../ProjectDashboard.css';
import './PaperSearch.css';

const PaperCitationPanel = lazy(() => import('./PaperCitationPanel'));
function sourceUrl(value?: string) { try { const url = new URL(value || ''); return ['http:', 'https:'].includes(url.protocol) ? url.href : undefined; } catch { return undefined; } }
const sourceLabel = (value: string) => ({ arxiv: 'arXiv', openalex: 'OpenAlex' }[value] || value);
const emptyFilters: SearchFilters = { yearFrom: null, yearTo: null, publicationType: '', openAccessOnly: false };
const emptyRanking: RankingFilter = { scheme: null, editionYear: null, subject: null, ranks: [], unknown: 'include' };
export default function PaperSearchPage() { const { projectId = '' } = useParams(); return <PaperSearchWorkspace key={projectId} projectId={projectId} />; }
function PaperSearchWorkspace({ projectId }: { projectId: string }) {
  const controller = usePaperSearch(projectId);
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState(params.get('q') || '');
  const [sources, setSources] = useState(['arxiv', 'openalex']);
  const [pageSize, setPageSize] = useState(20);
  const [filters, setFilters] = useState<SearchFilters>(emptyFilters);
  const [ranking, setRanking] = useState<RankingFilter>(emptyRanking);
  const [catalogs, setCatalogs] = useState<RankingCatalogue | null>(null);
  const [catalogError, setCatalogError] = useState('');
  const [citation, setCitation] = useState<PaperLibraryRecord | null>(null);
  const sessionId = params.get('search');
  const session = controller.data?.sessions.find(item => item.id === sessionId);
  const refreshCatalogs = useCallback(async () => { setCatalogs(await getRankingCatalogs(projectId)); setCatalogError(''); }, [projectId]);
  useEffect(() => { const abort = new AbortController(); void getRankingCatalogs(projectId, abort.signal).then(value => { if (!abort.signal.aborted) setCatalogs(value); }).catch(cause => { if (!abort.signal.aborted) setCatalogError(readerError(cause)); }); return () => abort.abort(); }, [projectId]);
  useEffect(() => { if (session) { setQuery(session.criteria.query); setSources(session.criteria.sources); setPageSize(session.criteria.pageSize); setFilters(session.criteria.filters || emptyFilters); setRanking(session.criteria.ranking || emptyRanking); } }, [session]);
  const criteria = (): SearchCriteria => ({ query, sources, pageSize, offset: 0, filters, ranking });
  const run = async (input: SearchCriteria) => { const result = await controller.search(input); if (result) setParams({ q: result.criteria.query, search: result.id }); };
  const submit = (event: FormEvent) => { event.preventDefault(); void run(criteria()); };
  const libraryHref = `/project/${encodeURIComponent(projectId)}/library`;
  const choosePaper = async (candidate: SearchCandidate, action: 'read' | 'cite') => {
    const paper = findUniquePaper(controller.papers, candidate) || await controller.save(candidate);
    if (paper) { if (action === 'cite') setCitation(paper); else navigate(`/project/${encodeURIComponent(projectId)}/papers/${encodeURIComponent(paper.id)}/read`); }
  };
  const activeCatalogs = catalogs?.catalogs.filter(item => !item.supersededBy && (!ranking.scheme || item.scheme === ranking.scheme)) || [];
  const ranks = ranking.scheme === 'JCR' ? ['Q1', 'Q2', 'Q3', 'Q4'] : ranking.scheme === 'CAS' ? ['1', '2', '3', '4'] : ranking.scheme === 'CCF' ? ['A', 'B', 'C'] : [...new Set(activeCatalogs.flatMap(item => item.ranks))];
  return <ProjectWorkspaceFrame projectId={projectId} projectName={controller.data?.projectName || ''} active="search" title="论文搜索">
    <div className="paper-search-workspace">
      <header className="paper-search-heading"><h1>论文搜索</h1><Link to={libraryHref}><BookOpen size={15} />我的文献库</Link></header>
      <form className="paper-search-form" onSubmit={submit} aria-label="论文检索"><div className="paper-search-query"><Search size={19} /><input aria-label="论文关键词" value={query} onChange={event => setQuery(event.target.value)} placeholder="论文标题、作者、研究问题或关键词" maxLength={1000} required /><button type="submit" disabled={controller.loading || controller.busy || !query.trim() || !sources.length}>{controller.busy ? '检索中…' : '搜索'}</button>{controller.busy && <button type="button" className="paper-search-cancel" onClick={controller.cancel}>取消检索</button>}</div></form>
      {controller.error && <p role="alert" className="paper-search-alert">{controller.error}</p>}{controller.notice && <p role="status" className="paper-search-notice">{controller.notice}</p>}
      {citation && <Suspense fallback={<p>正在读取引用选项…</p>}><PaperCitationPanel projectId={projectId} paper={citation} onClose={() => setCitation(null)} /></Suspense>}
      <div className="paper-search-body">
        <aside className="paper-search-facets" aria-label="论文筛选">
          <section><h2>论文来源</h2>{controller.data?.sources.map(source => <label className="paper-filter-check" key={source.id}><input type="checkbox" checked={sources.includes(source.id)} onChange={event => setSources(value => event.target.checked ? [...value, source.id] : value.filter(id => id !== source.id))} />{source.label}</label>)}</section>
          <section><h2>发表年份</h2><div className="paper-year-range"><input type="number" aria-label="起始年份" placeholder="起始" min={1800} max={2100} value={filters.yearFrom ?? ''} onChange={event => setFilters(value => ({ ...value, yearFrom: event.target.value ? Number(event.target.value) : null }))} /><span>—</span><input type="number" aria-label="结束年份" placeholder="结束" min={1800} max={2100} value={filters.yearTo ?? ''} onChange={event => setFilters(value => ({ ...value, yearTo: event.target.value ? Number(event.target.value) : null }))} /></div><button className="paper-search-text-button" onClick={() => setFilters(value => ({ ...value, yearFrom: new Date().getFullYear() - 2, yearTo: null }))}>近三年</button></section>
          <section><label>论文类型<select value={filters.publicationType} onChange={event => setFilters(value => ({ ...value, publicationType: event.target.value }))}><option value="">所有类型</option><option value="journal">期刊论文</option><option value="conference">会议论文</option><option value="preprint">预印本</option></select></label><label className="paper-filter-check"><input type="checkbox" checked={filters.openAccessOnly} onChange={event => setFilters(value => ({ ...value, openAccessOnly: event.target.checked }))} />仅开放获取</label></section>
          <section><h2>期刊 / 会议等级</h2><label>分级体系<select value={ranking.scheme || ''} onChange={event => setRanking({ ...emptyRanking, scheme: event.target.value || null })}><option value="">不限体系</option><option>JCR</option><option>CAS</option><option>CCF</option><option value="custom">自定义</option></select></label><label>目录年份<select value={ranking.editionYear || ''} onChange={event => setRanking(value => ({ ...value, editionYear: event.target.value ? Number(event.target.value) : null }))}><option value="">所有目录年份</option>{[...new Set(activeCatalogs.map(item => item.editionYear))].sort((a, b) => b - a).map(year => <option key={year}>{year}</option>)}</select></label><label>等级<select disabled={!ranking.scheme} value={ranking.ranks?.[0] || ''} onChange={event => setRanking(value => ({ ...value, ranks: event.target.value ? [event.target.value] : [] }))}><option value="">不限等级</option>{ranks.map(rank => <option key={rank}>{rank}</option>)}</select></label><label>学科<select value={ranking.subject || ''} onChange={event => setRanking(value => ({ ...value, subject: event.target.value || null }))}><option value="">所有学科</option>{[...new Set(activeCatalogs.flatMap(item => item.subjects))].sort().map(subject => <option key={subject}>{subject}</option>)}</select></label><label>未知等级<select value={ranking.unknown || 'include'} onChange={event => setRanking(value => ({ ...value, unknown: event.target.value as RankingFilter['unknown'] }))}><option value="include">保留未匹配论文</option><option value="exclude">排除未匹配论文</option><option value="only">仅看未匹配论文</option></select></label><small>等级是发表载体的目录分级，不等于论文质量评分。</small></section>
          <button className="paper-filter-apply" disabled={controller.busy || !query.trim() || !sources.length} onClick={() => void run(criteria())}>应用筛选</button><button className="paper-search-text-button" onClick={() => { setFilters(emptyFilters); setRanking(emptyRanking); }}>清除筛选</button>
          {catalogError && <p role="alert">{catalogError}</p>}<RankingCatalogManager projectId={projectId} data={catalogs} onChanged={refreshCatalogs} />
          <details className="paper-search-history"><summary>最近检索</summary>{controller.data?.sessions.slice(0, 10).map(item => <Link key={item.id} aria-current={item.id === sessionId ? 'page' : undefined} to={`?${new URLSearchParams({ q: item.criteria.query, search: item.id })}`}><span>{item.criteria.query}</span><small>{item.candidates.length} 篇 · {new Date(item.createdAt).toLocaleDateString()}</small></Link>)}</details>
        </aside>
        <section className="paper-search-result-area" aria-label="检索结果" aria-busy={controller.busy}>
          {controller.loading && <p role="status">正在读取检索记录…</p>}
          {session ? <>
            <div className="paper-search-results-heading"><div><span>本批次 {session.candidates.length} 篇</span><small> · {new Date(session.createdAt).toLocaleString()}</small></div><label>每页 / 来源<select value={pageSize} onChange={event => setPageSize(Number(event.target.value))}>{[...new Set([10,20,40,pageSize])].sort((a,b) => a-b).map(size => <option key={size} value={size}>{size} 篇</option>)}</select></label></div>
            {!!session.sourceResults?.length && <details className="paper-search-source-status"><summary>检索来源与范围</summary>{session.sourceResults.map(result => <p key={result.source}>{sourceLabel(result.source)}：{result.matched} / {result.received} 篇符合{result.filterMode === 'server' ? '来源端筛选' : '当前批次筛选'}{result.total !== null ? `；来源报告 ${result.total.toLocaleString()} 条，未跨源去重` : '；来源总数未知'}</p>)}<p>等级筛选在返回批次内应用；继续下一批可检索更多论文。</p></details>}
            {session.rankingCoverage && <div className="paper-ranking-coverage">本批分级匹配 {session.rankingCoverage.matched} / {session.rankingCoverage.total} 篇{!session.rankingCoverage.catalogCount ? ' · 尚无所选体系的目录，可展开“分级目录与来源”导入' : ` · 目录版本 ${session.rankingCoverage.catalogVersion}`}<details><summary>查看未匹配项</summary>{session.rankingCoverage.unmatchedPapers.map((item, index) => <div key={index}>{item.venue || '发表载体未提供'} · {{ 'missing-venue': '缺少载体信息', 'no-catalog': '没有目录', 'not-in-catalog': '目录未匹配', 'ambiguous-venue': '载体同名，需 ISSN 区分' }[item.reason] || item.reason}</div>)}</details></div>}
            {session.failures.map((failure, index) => <p key={index} role="alert" className="paper-search-alert">{sourceLabel(failure.source)} 暂未完成：{failure.message}</p>)}
            {!session.candidates.length && <div className="paper-search-empty"><Search size={26} /><h2>{session.status === 'failed' ? '这次检索未能完成' : '当前批次没有匹配论文'}</h2><p>可以调整关键词、筛选条件，或继续检索下一批。</p></div>}
            <div className="paper-search-results">{session.candidates.map(candidate => <PaperResult key={`${candidate.source}:${candidate.id}`} candidate={candidate} saved={!!findUniquePaper(controller.papers, candidate)} saving={controller.saving === candidate.id} disabled={!!controller.saving} onSave={() => void controller.save(candidate)} onRead={() => void choosePaper(candidate, 'read')} onCite={() => void choosePaper(candidate, 'cite')} />)}</div>
            <nav className="paper-search-pagination" aria-label="检索分页"><button disabled={controller.busy || session.criteria.offset === 0} onClick={() => void run({ ...session.criteria, offset: Math.max(0, session.criteria.offset - session.criteria.pageSize) })}><ArrowLeft size={15} />上一批</button><span>来源偏移 {session.criteria.offset + 1} 起</span><button disabled={controller.busy || session.nextOffset === null} onClick={() => void run({ ...session.criteria, offset: session.nextOffset! })}>下一批<ArrowRight size={15} /></button></nav>
          </> : !controller.loading && <div className="paper-search-empty"><BookOpen size={32} strokeWidth={1.3} /><h2>{sessionId ? '这条检索记录已过期' : '查找与你的研究相关的论文'}</h2><p>输入关键词。每篇结果保留作者、发表来源、年份和可追溯的分级信息。</p></div>}
        </section>
      </div>
    </div>
  </ProjectWorkspaceFrame>;
}
function PaperResult({ candidate, saved, saving, disabled, onSave, onRead, onCite }: { candidate: SearchCandidate; saved: boolean; saving: boolean; disabled: boolean; onSave: () => void; onRead: () => void; onCite: () => void }) {
  const url = sourceUrl(candidate.url);
  return <article className="paper-search-result"><h2>{url ? <a href={url} target="_blank" rel="noreferrer">{candidate.title}</a> : candidate.title}</h2><p className="paper-search-byline">{candidate.authors?.slice(0, 6).join(', ') || '作者未知'}{(candidate.authors?.length || 0) > 6 ? ' 等' : ''}<span> — {candidate.venue || (candidate.source === 'arxiv' ? 'arXiv 预印本' : '发表载体未提供')}，{candidate.year || '年份未知'}</span></p><div className="paper-search-result-meta"><span>收录来源：{sourceLabel(candidate.source)}</span>{candidate.publicationType && <span>{{ preprint: '预印本', journal: '期刊论文', conference: '会议论文' }[candidate.publicationType] || candidate.publicationType}</span>}{candidate.isOpenAccess && <span>开放获取</span>}{candidate.rankings?.length ? candidate.rankings.map(item => <details className="paper-ranking-badge" key={`${item.catalogId}:${item.subject}:${item.rank}`}><summary>{item.scheme === 'CAS' ? `CAS ${item.rank} 区` : `${item.scheme === 'custom' ? '自定义' : item.scheme} ${item.rank}`} · {item.editionYear}</summary><p>{item.venue} · {item.subject}<br />目录：{item.catalogLabel}<br />来源：{item.provenance.label}{sourceUrl(item.provenance.url) && <> · <a href={sourceUrl(item.provenance.url)} target="_blank" rel="noreferrer">查看</a></>}<br />匹配方式：{item.matchedBy === 'issn' ? 'ISSN' : '载体名称'}</p></details>) : <span className="paper-rank-unknown">等级未匹配</span>}</div>{candidate.abstract && <details className="paper-search-abstract"><summary><span>{candidate.abstract}</span><em>展开摘要</em></summary><p>{candidate.abstract}</p></details>}<footer><button disabled={disabled || saved} onClick={onSave}>{saved ? <Check size={13} /> : <BookOpen size={13} />}{saved ? '已入库' : saving ? '入库中…' : '加入文献库'}</button><button disabled={disabled} onClick={onRead}>阅读 PDF</button><button disabled={disabled} onClick={onCite}>引用</button>{url && <a href={url} target="_blank" rel="noreferrer">查看来源<ExternalLink size={12} /></a>}<small>{candidate.doi ? `DOI: ${candidate.doi}` : candidate.arxivId ? `arXiv: ${candidate.arxivId}` : ''}</small></footer></article>;
}
