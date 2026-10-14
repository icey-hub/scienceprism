import { useState } from 'react';
import { Link } from 'react-router-dom';
import './WritingCitationAudit.css';

export interface WritingCitationRow {
  key:string;status:'resolved'|'missing-bib'|'conflict'|'unlinked-bib'|'inline';
  occurrences:{path:string;line:number}[];bibEntries:{path:string;line:number;title:string;doi:string|null;url:string|null}[];
  papers:{id:string;title:string;doi:string|null;url:string|null;match:'identifier'|'key'}[];issues:string[];
}
export interface WritingCitations {
  citedKeys:string[];knownKeys:string[];missingKeys:string[];ok:boolean;rows?:WritingCitationRow[];
  issues?:{code:string;message:string;path?:string;line?:number}[];
  summary?:{total:number;resolved:number;missing:number;conflicts:number;unlinked:number};
}
const labels:Record<WritingCitationRow['status'],string>={resolved:'已在文稿 Bib', 'missing-bib':'缺 Bib',conflict:'冲突','unlinked-bib':'未关联 Bib',inline:'文内条目'};
const pending=(row:WritingCitationRow)=>['missing-bib','conflict','unlinked-bib'].includes(row.status)||row.issues.length>0;
const safeUrl=(value:string|null)=>{if(!value)return undefined;try{const url=new URL(value);return ['https:','http:'].includes(url.protocol)&&!url.username&&!url.password?url.href:undefined;}catch{return undefined;}};
function doiUrl(doi:string|null){if(!doi)return undefined;const value=doi.trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i,'').replace(/^doi:\s*/i,'');return /^10\.\d{4,9}\/\S+$/i.test(value)?`https://doi.org/${value.split('/').map(encodeURIComponent).join('/')}`:undefined;}
function Location({projectId,path,line}:{projectId:string;path:string;line?:number}){const number=Number.isSafeInteger(line)&&Number(line)>0?line:undefined;return <Link to={`/editor/${encodeURIComponent(projectId)}?file=${encodeURIComponent(path)}${number?`&line=${number}`:''}`}>{path}{number?`:${number}`:''}</Link>;}
function IdentifierLinks({doi,url}:{doi:string|null;url:string|null}){const doiLink=doiUrl(doi),sourceLink=safeUrl(url);return <span className="citation-identifier-links">{doiLink&&<a href={doiLink} target="_blank" rel="noreferrer">DOI ↗</a>}{sourceLink&&<a href={sourceLink} target="_blank" rel="noreferrer">来源 ↗</a>}</span>;}
export function WritingCitationAudit({projectId,citations,refreshing,onRefresh}:{projectId:string;citations:WritingCitations;refreshing:boolean;onRefresh:()=>void}) {
  const [filter,setFilter]=useState<'pending'|'all'>('pending');
  const rows=citations.rows||[],unresolved=rows.filter(pending),shown=filter==='pending'?unresolved:rows;
  return <section className="hub-panel writing-citation-audit" aria-label="写作引用来源核查">
    <div className="hub-section-heading"><div><span className="hub-kicker">CITATION SOURCES</span><h3>引用来源核查</h3></div><button className="hub-small-button is-quiet" disabled={refreshing} onClick={onRefresh}>{refreshing?'正在核查…':'刷新核查'}</button></div>
    <div className="citation-audit-toolbar"><div className="citation-audit-filters" role="group" aria-label="引用显示范围"><button className={filter==='pending'?'is-active':''} aria-pressed={filter==='pending'} onClick={()=>setFilter('pending')}>仅待处理{citations.rows?` (${unresolved.length})`:''}</button><button className={filter==='all'?'is-active':''} aria-pressed={filter==='all'} onClick={()=>setFilter('all')}>全部{citations.rows?` (${rows.length})`:''}</button></div>
      {citations.summary&&<p>共 {citations.summary.total} 个引用键 · 已解析 {citations.summary.resolved} · 缺失 {citations.summary.missing} · 冲突 {citations.summary.conflicts} · 未关联 {citations.summary.unlinked}</p>}
    </div>
    {!!citations.issues?.length&&<details className="citation-audit-issues" open><summary>需核对的文件与解析问题（{citations.issues.length}）</summary><ul>{citations.issues.map((issue,index)=><li key={index}>{issue.message}{issue.path&&<> · <Location projectId={projectId} path={issue.path} line={issue.line}/></>}</li>)}</ul></details>}
    {citations.rows?<div className="citation-audit-scroll"><table><caption>点击文件行号定位原文；资料库匹配不会自动写入文稿 Bib</caption><colgroup><col className="citation-key-col"/><col className="citation-status-col"/><col className="citation-location-col"/><col className="citation-bib-col"/><col className="citation-paper-col"/></colgroup><thead><tr><th scope="col">引用键</th><th scope="col">状态 / 问题</th><th scope="col">文稿位置</th><th scope="col">Bib / 文内条目</th><th scope="col">资料库论文</th></tr></thead><tbody>{shown.map(row=><tr key={row.key}>
      <th scope="row"><code>{row.key}</code></th><td><span className={`citation-row-status is-${row.status}`}>{labels[row.status]}</span>{row.issues.length>0&&<ul className="citation-row-issues">{row.issues.map((issue,index)=><li key={index}>{issue}</li>)}</ul>}</td>
      <td>{row.occurrences.length?row.occurrences.map((item,index)=><div className="citation-location" key={`${item.path}:${item.line}:${index}`}><Location projectId={projectId} {...item}/></div>):<span className="citation-no-source">未报告位置</span>}</td>
      <td>{row.bibEntries.length?row.bibEntries.map((entry,index)=><div className="citation-bib-entry" key={`${entry.path}:${entry.line}:${index}`}><Location projectId={projectId} path={entry.path} line={entry.line}/>{entry.title&&<small>{entry.title}</small>}<IdentifierLinks doi={entry.doi} url={entry.url}/></div>):<span className="citation-no-source">未找到项目条目</span>}</td>
      <td>{(['identifier','key'] as const).map(match=>{const papers=row.papers.filter(paper=>paper.match===match);return papers.length>0&&<div className={`citation-paper-matches is-${match}`} key={match}><strong>{match==='identifier'?'标识符精确对照':'引用键候选 · 待核对'}</strong>{papers.map(paper=><div key={`${paper.id}:${match}`}><Link to={`/project/${encodeURIComponent(projectId)}/library?paper=${encodeURIComponent(paper.id)}`}>{paper.title||paper.id}</Link><IdentifierLinks doi={paper.doi} url={paper.url}/></div>)}</div>;})}{!row.papers.length&&<span className="citation-no-source">无资料库对应记录</span>}</td>
    </tr>)}</tbody></table>{!shown.length&&<p className="citation-audit-empty">{citations.issues?.length?'需先核对上述解析问题，再刷新引用检查。':filter==='pending'&&rows.length?'当前没有待处理引用，可切换“全部”查看已识别条目。':'尚未识别引用键。'}</p>}</div>:<p className="citation-audit-empty">当前检查没有返回可定位明细。{citations.missingKeys.length?`缺少条目：${citations.missingKeys.join('、')}。`:`已识别 ${citations.citedKeys.length} 个引用键。`}</p>}
    <p className="citation-audit-boundary">项目级静态核查不替代实际编译；资料库已有论文不代表它已写入或关联文稿 Bib。</p>
  </section>;
}
