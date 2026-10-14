import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ChartNoAxesCombined, Plus, RefreshCw } from 'lucide-react';
import { ProjectWorkspaceFrame } from '../components/ProjectWorkspaceFrame';
import { FigureWritingTools } from './FigureWritingTools';
import { getProjectDashboard } from '../../api/projectAdapter';
import { createTableFigure, figureFileUrl, getFigureSource, listProjectFigures, reviseFigureStyle, type FigureSource, type FigureStyle, type ProjectFigure, type TableFigureInput, type TableFigureSource } from '../../api/figureAdapter';
import './FigurePage.css';

const blankStyle=():FigureStyle=>({title:'',xLabel:'',yLabel:'',palette:'blue-orange'});
const sourceKey=(figure:ProjectFigure)=>`${figure.kind}:${figure.sourceSha256}`;
const date=(value:string)=>new Date(value).toLocaleString('zh-CN');
const errorText=(error:unknown)=>error instanceof Error?error.message:String(error);
const isTableSource=(source:FigureSource):source is TableFigureSource=>source.kind==='table'&&typeof source.tableLatex==='string'&&!!source.parsedTable;
function StyleFields({value,onChange}:{value:FigureStyle;onChange:(value:FigureStyle)=>void}) {
  return <div className="figure-style-fields">
    <label>标题<input maxLength={120} value={value.title} onChange={event=>onChange({...value,title:event.target.value})}/></label>
    <label>横轴标签<input maxLength={120} value={value.xLabel} onChange={event=>onChange({...value,xLabel:event.target.value})}/></label>
    <label>纵轴标签<input maxLength={120} value={value.yLabel} onChange={event=>onChange({...value,yLabel:event.target.value})}/></label>
    <label>配色<select value={value.palette} onChange={event=>onChange({...value,palette:event.target.value as FigureStyle['palette']})}><option value="blue-orange">蓝 / 橙</option><option value="purple-green">紫 / 绿</option><option value="grayscale">灰阶</option></select></label>
  </div>;
}
function FigureSourceDetails({projectId,figure}:{projectId:string;figure:ProjectFigure}) {
  const [open,setOpen]=useState(false),[source,setSource]=useState<FigureSource|null>(null),[error,setError]=useState('');
  useEffect(()=>{if(!open||source)return;const controller=new AbortController();
    void getFigureSource(projectId,figure.id,controller.signal).then(result=>{if(!controller.signal.aborted){setSource(result.source);setError('');}}).catch(reason=>{if(!controller.signal.aborted)setError(errorText(reason));});
    return()=>controller.abort();
  },[open,projectId,figure.id,source]);
  return <details className="figure-source" onToggle={event=>setOpen(event.currentTarget.open)}><summary>查看固定来源与绘图源码</summary>
    {error&&<p role="alert" className="hub-error">读取图来源失败：{error}</p>}{open&&!source&&!error&&<p role="status">正在读取原始来源…</p>}
    {source&&isTableSource(source)?<><p>{source.sourceOrigin==='project-file'?`项目文件：${source.sourcePath}`:'来源：手动粘贴的真实表格'} · {source.chartType==='bar'?'柱状图':source.chartType==='line'?'折线图':'热图'} · {source.layout==='panels'?'按指标多面板':'单图'}</p>
      {source.sourceOrigin==='project-file'&&source.sourcePath&&<Link to={`/editor/${encodeURIComponent(projectId)}?file=${encodeURIComponent(source.sourcePath)}`}>打开源表文件</Link>}
      <div className="figure-source-table"><table><caption>固定解析数据 · 只读</caption><thead><tr><th scope="col">{source.parsedTable.headers[0]||'组别'}</th>{source.parsedTable.series.map((series,index)=><th scope="col" key={index}>{series.name}</th>)}</tr></thead><tbody>{source.parsedTable.rowLabels.map((label,index)=><tr key={index}><th scope="row">{label}</th>{source.parsedTable.series.map((series,column)=><td key={column}>{series.values[index]}</td>)}</tr>)}</tbody></table></div>
      <details><summary>原始 LaTeX 表格</summary><pre>{source.tableLatex}</pre></details>
    </>:source&&<><Link to={`/editor/${encodeURIComponent(projectId)}/research/experiment`}>回到实验批次与实际 Run</Link><details><summary>原始实验来源 JSON</summary><pre>{JSON.stringify(source,null,2)}</pre></details></>}
    <p className="figure-source-renderer">{figure.renderer.name} · Python {figure.renderer.pythonVersion} · Matplotlib {figure.renderer.matplotlibVersion}</p>
    {figureFileUrl(figure.files.rendererSource.url)&&<a href={figureFileUrl(figure.files.rendererSource.url)} download>下载固定绘图源码</a>}
  </details>;
}

export default function FigurePage(){const {projectId=''}=useParams();return <FigureWorkspace key={projectId} projectId={projectId}/>;}
function FigureWorkspace({projectId}:{projectId:string}) {
  const [params,setParams]=useSearchParams();
  const [figures,setFigures]=useState<ProjectFigure[]>([]),[name,setName]=useState(''),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState(''),[createOpen,setCreateOpen]=useState(false);
  const [tableLatex,setTableLatex]=useState(''),[sourcePath,setSourcePath]=useState(''),[chartType,setChartType]=useState<TableFigureInput['chartType']>('bar'),[layout,setLayout]=useState<TableFigureInput['layout']>('single'),[unit,setUnit]=useState(''),[sampleSize,setSampleSize]=useState('');
  const [createStyle,setCreateStyle]=useState<FigureStyle>(blankStyle),[revisionStyle,setRevisionStyle]=useState<FigureStyle>(blankStyle),[imageFailed,setImageFailed]=useState(false);
  const lifetime=useRef(new AbortController()),lock=useRef(false),readVersion=useRef(0);
  const refresh=async()=>{const version=++readVersion.current;const result=await listProjectFigures(projectId,lifetime.current.signal);if(!lifetime.current.signal.aborted&&version===readVersion.current){setFigures(result.figures);setError('');if(!result.figures.length)setCreateOpen(true);}};
  useEffect(()=>{const controller=new AbortController();lifetime.current=controller;
    void refresh().catch(reason=>{if(!controller.signal.aborted)setError(`读取科研图失败：${errorText(reason)}`);}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    void getProjectDashboard(projectId).then(result=>{if(!controller.signal.aborted)setName(result.dashboard.project.name);}).catch(()=>{});
    return()=>controller.abort();
  },[projectId]);
  const sorted=[...figures].sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt));
  const selectedId=params.get('figure'),figure=selectedId?figures.find(item=>item.id===selectedId):sorted[0];
  const groups=[...new Set(sorted.map(sourceKey))].map(key=>sorted.filter(item=>sourceKey(item)===key));
  const versions=figure?sorted.filter(item=>sourceKey(item)===sourceKey(figure)):[];
  useEffect(()=>{setRevisionStyle(figure?.style||blankStyle());setImageFailed(false);},[figure?.id]);
  const select=(id:string)=>setParams(current=>{const next=new URLSearchParams(current);next.set('figure',id);return next;});
  const act=async(work:()=>Promise<ProjectFigure|void>,success='')=>{if(lock.current)return;lock.current=true;setBusy(true);setError('');setMessage('');
    try{const result=await work();if(!lifetime.current.signal.aborted){if(result){setFigures(current=>[result,...current.filter(item=>item.id!==result.id)]);select(result.id);}if(success)setMessage(success);}}
    catch(reason){if(!lifetime.current.signal.aborted)setError(errorText(reason));}
    finally{lock.current=false;if(!lifetime.current.signal.aborted)setBusy(false);}
  };
  const create=async(event:FormEvent)=>{event.preventDefault();await act(async()=>{const result=await createTableFigure(projectId,{tableLatex,chartType,layout,style:createStyle,...(sourcePath.trim()?{sourcePath:sourcePath.trim()}:{}),...(unit.trim()?{unit:unit.trim()}:{}),...(sampleSize.trim()?{sampleSize:Number(sampleSize)}:{})},lifetime.current.signal);if(!lifetime.current.signal.aborted)setCreateOpen(false);return result.figure;},'论文图已保存，可以预览、下载或继续调整样式。');};
  return <ProjectWorkspaceFrame projectId={projectId} projectName={name} active="figures" title="科研图">
    <div className="hub-page-heading"><div><p className="figure-eyebrow">RESEARCH FIGURES</p><h2>科研图</h2><p>从真实表格和实验结果生成论文图，在一处管理来源、版本与导出。</p></div><div className="figure-heading-actions"><button className="hub-small-button is-quiet" disabled={busy||loading} onClick={()=>void act(refresh)}><RefreshCw size={15}/>刷新</button><button className="hub-small-button" disabled={busy} onClick={()=>setCreateOpen(current=>!current)}><Plus size={15}/>从表格生成</button></div></div>
    {error&&<p className="hub-error" role="alert">{error}{figures.length>0&&' 已有图与未保存内容保留。'}</p>}{message&&<p className="figure-notice" role="status">{message}</p>}
    <details className="figure-create" open={createOpen} onToggle={event=>setCreateOpen(event.currentTarget.open)}><summary>粘贴真实 LaTeX 表格，生成单图或多面板图</summary>
      <form onSubmit={event=>void create(event)}><fieldset disabled={busy||loading}><div className="figure-create-grid"><label className="figure-table-input">原始 LaTeX 表格<textarea required maxLength={200000} rows={10} value={tableLatex} onChange={event=>setTableLatex(event.target.value)} placeholder="粘贴论文中的 tabular 表格，每行包含组名和数值列"/><small>每行 1 个组名与 1–12 个数值列，最多 200 行。</small></label><div className="figure-table-options">
        <div className="figure-form-row"><label>图类型<select value={chartType} onChange={event=>{const value=event.target.value as TableFigureInput['chartType'];setChartType(value);if(value==='heatmap')setLayout('single');}}><option value="bar">柱状图</option><option value="line">折线图</option><option value="heatmap">热图</option></select></label><label>布局<select value={layout} onChange={event=>setLayout(event.target.value as TableFigureInput['layout'])}><option value="single">单图</option><option value="panels" disabled={chartType==='heatmap'}>按指标多面板</option></select></label></div>
        <label>项目内表格文件路径（可选）<input maxLength={500} value={sourcePath} onChange={event=>setSourcePath(event.target.value)} placeholder="例如 main.tex"/></label><div className="figure-form-row"><label>单位（可选）<input maxLength={100} value={unit} onChange={event=>setUnit(event.target.value)}/></label><label>实际样本量（可选）<input type="number" min={1} max={1000000000} step={1} value={sampleSize} onChange={event=>setSampleSize(event.target.value)} placeholder="未知留空"/></label></div>
        <StyleFields value={createStyle} onChange={setCreateStyle}/>
      </div></div></fieldset><div className="figure-create-footer"><p>保留原表与解析数据。表格行数不代表样本量。</p><button className="hub-small-button" disabled={busy||loading||!tableLatex.trim()}>{busy?'正在生成…':'生成论文图'}</button></div></form>
    </details>
    {loading&&<p role="status" className="hub-muted">正在读取项目科研图…</p>}
    <section className="figure-library" aria-label="项目科研图清单"><aside className="figure-list"><h3><ChartNoAxesCombined size={18}/>项目图 <small>{groups.length}</small></h3>
      {groups.map(group=>{const latest=group[0];return <button key={sourceKey(latest)} className={figure&&sourceKey(figure)===sourceKey(latest)?'is-selected':''} onClick={()=>select(latest.id)}><strong>{latest.style.title||'未命名科研图'}</strong><span>{latest.kind==='campaign'?'实验结果':'真实表格'} · {group.length} 个版本</span><small>{date(latest.createdAt)}</small></button>;})}
      {!loading&&!figures.length&&!error&&<p>还没有科研图。粘贴真实表格，或从实验批次生成第一张图。</p>}
    </aside><article className="figure-main">{figure?<><div className="figure-main-heading"><div><h3>{figure.style.title||'未命名科研图'}</h3><span>{figure.kind==='campaign'?'实验结果 · 固定配对种子':'真实表格 · 固定解析数据'}</span></div><label className="figure-version-select">已存版本<select value={figure.id} onChange={event=>select(event.target.value)}>{versions.map(item=><option key={item.id} value={item.id}>{date(item.createdAt)} · {item.style.title||'未命名'}</option>)}</select></label></div>
      <div className="figure-large-preview">{figureFileUrl(figure.files.png.url)&&!imageFailed?<img src={figureFileUrl(figure.files.png.url)} alt={figure.style.title||'真实科研图预览'} onError={()=>setImageFailed(true)}/>:<p role="alert">PNG 预览无法读取，仍可下载已有文件。</p>}</div>
      <div className="figure-export"><div>{(['svg','pdf','png','source'] as const).map(format=>figureFileUrl(figure.files[format].url)&&<a key={format} href={figureFileUrl(figure.files[format].url)} download>{format==='source'?'数据 JSON':format.toUpperCase()}</a>)}</div><span>{figure.kind==='campaign'?`n = ${figure.statistics.n} 个完整配对种子 · 单位 ${figure.statistics.unit||'未声明'}`:`${figure.statistics.dataRows} 行 · ${figure.statistics.series} 个数值列 · 样本量 ${figure.statistics.sampleSize??'未知'} · 单位 ${figure.statistics.units||'未声明'}`}</span></div>
      <p className="figure-caption">{figure.statistics.caption}</p>
      <form className="figure-revision" onSubmit={event=>{event.preventDefault();void act(async()=>{const result=await reviseFigureStyle(projectId,figure.id,revisionStyle,lifetime.current.signal);return result.figure;},'样式版本已保存，原图仍可下载。');}}><fieldset disabled={busy}><StyleFields value={revisionStyle} onChange={setRevisionStyle}/></fieldset><div className="figure-revision-footer"><span>调整样式会保存新版本，原图仍可下载。</span><button className="hub-small-button is-quiet" disabled={busy}>{busy?'正在保存…':'保存样式版本'}</button></div></form>
      <FigureSourceDetails key={figure.id} projectId={projectId} figure={figure}/>
    </>:<div className="figure-empty"><ChartNoAxesCombined size={36}/><h3>{selectedId&&!loading?'指定图版本未找到':'从真实数据开始'}</h3><p>{selectedId&&!loading?'请从项目图清单选择已有版本。':'粘贴表格生成论文图，或查看实验页已生成的结果图。'}</p><Link to={`/editor/${encodeURIComponent(projectId)}/research/experiment`}>查看实验结果</Link></div>}</article></section>
    <FigureWritingTools projectId={projectId} assetPath={figure?.files.pdf.path}/>
  </ProjectWorkspaceFrame>;
}
