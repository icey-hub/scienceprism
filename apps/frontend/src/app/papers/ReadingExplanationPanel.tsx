import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import { cancelHarnessRun, getHarnessRun } from '../../api/assistantAdapter';
import { createReadingExplanation, listReadingExplanations, readingSelectionKey, type ReadingExplanationRun } from '../../api/readingAssistantAdapter';
import { readerError, type ReadingSelection } from '../../api/paperReaderAdapter';
import { taskHref } from '../project/taskLocation';
import './ReadingAssistant.css';

const terminal=(run:ReadingExplanationRun)=>['completed','failed','cancelled'].includes(run.status);
const statusLabels:Record<string,string>={created:'已创建',queued:'排队中',running:'解释中',paused:'已暂停',completed:'已完成',failed:'失败',cancelled:'已取消'};
function usageLabel(run:ReadingExplanationRun){const usage=run.tokenUsage;if(!usage)return '用量尚未报告';const reported=usage.reportedTotalTokens;if(typeof reported==='number')return `${reported.toLocaleString()} 已报告 tokens${usage.estimated?' · 部分用量不确定':''}`;if(typeof usage.totalTokens==='number')return `${usage.totalTokens.toLocaleString()} ${usage.estimated?'预算计入 tokens（含预留）':'已报告 tokens'}`;return '用量尚未报告';}
type ExplanationProps={projectId:string;paperId:string;attachmentId:string;fileSha256:string;selection:ReadingSelection|null;onLocate:(page:number)=>void;active?:boolean};
export function ReadingExplanationPanel({projectId,paperId,selection,onLocate,active=true,attachmentId,fileSha256}:ExplanationProps) {
  return <><ExplanationWorkspace key={JSON.stringify([projectId,paperId,readingSelectionKey(selection)])} projectId={projectId} paperId={paperId} attachmentId={attachmentId} fileSha256={fileSha256} selection={selection} onLocate={onLocate} active={active}/><ExplanationHistory key={`${projectId}:${paperId}`} projectId={projectId} paperId={paperId} attachmentId={attachmentId} fileSha256={fileSha256} onLocate={onLocate}/></>;
}
function ExplanationHistory({projectId,paperId,attachmentId,fileSha256,onLocate}:Pick<ExplanationProps,'projectId'|'paperId'|'attachmentId'|'fileSha256'|'onLocate'>) {
  const [open,setOpen]=useState(false),[runs,setRuns]=useState<ReadingExplanationRun[]>([]),[selectedId,setSelectedId]=useState(''),[loading,setLoading]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const lifetime=useRef(new AbortController()),version=useRef(0);
  const refresh=async()=>{const signal=lifetime.current.signal,current=++version.current;setLoading(true);try{const result=await listReadingExplanations(projectId,paperId,signal);if(!signal.aborted&&current===version.current){setRuns(result.runs.filter(run=>run.projectId===projectId&&run.request?.readingSource?.paperId===paperId));setError('');}}catch(cause){if(!signal.aborted&&current===version.current)setError(readerError(cause));}finally{if(!signal.aborted&&current===version.current)setLoading(false);}};
  useEffect(()=>{const controller=new AbortController();lifetime.current=controller;return()=>{controller.abort();version.current++;};},[projectId,paperId]);
  useEffect(()=>{if(open)void refresh();},[open]);
  const ordered=[...runs].sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt)),run=ordered.find(item=>item.id===selectedId)||ordered[0],source=run?.request?.readingSource;
  const copy=async()=>{if(!run?.reply)return;try{await navigator.clipboard.writeText(run.reply);if(!lifetime.current.signal.aborted)setNotice('历史解释已复制。');}catch{if(!lifetime.current.signal.aborted)setNotice('复制未成功，可以手动选择文字。');}};
  return <details className="reading-explanation-paper-history" onToggle={event=>setOpen(event.currentTarget.open)}><summary>本论文的历史解释</summary><div className="reading-assistant-actions"><span>最近100条真实 Run</span><button disabled={loading} onClick={()=>void refresh()}>{loading?'读取中…':'刷新历史'}</button></div>
    {error&&<p role="alert" className="reader-error">{error} 已读历史保留。</p>}
    {!!ordered.length&&<label>选择历史记录<select value={run?.id||''} onChange={event=>{setSelectedId(event.target.value);setNotice('');}}>{ordered.map(item=><option key={item.id} value={item.id}>{new Date(item.createdAt).toLocaleString('zh-CN')} · 第 {item.request?.readingSource?.selection.page} 页 · {statusLabels[item.status]||item.status}</option>)}</select></label>}
    {run&&source&&<article className="reading-explanation-history-record"><div className="reading-explanation-run"><strong>历史原文 · 第 {source.selection.page} 页</strong>{source.selection.attachmentId===attachmentId&&source.selection.fileSha256===fileSha256?<button onClick={()=>onLocate(source.selection.page)}>回页</button>:<Link to={`/project/${encodeURIComponent(projectId)}/papers/${encodeURIComponent(paperId)}/read?attachment=${encodeURIComponent(source.selection.attachmentId)}`}>打开原附件</Link>}</div><blockquote className="reader-quote">{source.selection.text}</blockquote>
      <div className="reading-explanation-run"><strong>{statusLabels[run.status]||run.status}</strong><Link to={taskHref(projectId,`harness:${run.id}`)}>查看原任务 ↗</Link></div><small>Run {run.id.slice(0,12)} · {usageLabel(run)}</small>{source.question&&<p className="reader-muted">原问题：{source.question}</p>}
      {run.status==='completed'&&run.reply?<><div className="reading-explanation-answer"><ReactMarkdown skipHtml disallowedElements={['img']}>{run.reply}</ReactMarkdown></div><button onClick={()=>void copy()}>复制历史解释</button></>:run.status==='completed'?<p className="reader-error">该次 Run 未返回解释文本。</p>:<p className="reader-muted">原 Run 的当前状态已保留，可刷新或在任务页查看。</p>}
      {run.error?.message&&<p role="alert" className="reader-error">{run.error.message}</p>}
    </article>}
    {open&&!loading&&!runs.length&&!error&&<p className="reader-muted">当前论文最近记录中没有解释 Run。</p>}{notice&&<p role="status" className="reader-muted">{notice}</p>}
  </details>;
}
function ExplanationWorkspace({projectId,paperId,selection,onLocate,active}:ExplanationProps) {
  const [runs,setRuns]=useState<ReadingExplanationRun[]>([]),[selectedId,setSelectedId]=useState(''),[question,setQuestion]=useState('');
  const [loading,setLoading]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[uncertain,setUncertain]=useState(false),[checkedUnknown,setCheckedUnknown]=useState(false);
  const lifetime=useRef(new AbortController()),version=useRef(0),lock=useRef(false),pendingId=useRef<string|null>(null);
  const key=readingSelectionKey(selection);
  const belongs=(run:ReadingExplanationRun)=>run.projectId===projectId&&run.request?.readingSource?.paperId===paperId&&readingSelectionKey(run.request.readingSource.selection)===key;
  const retain=(run:ReadingExplanationRun)=>{if(belongs(run))setRuns(current=>[run,...current.filter(item=>item.id!==run.id)]);};
  const refresh=async()=>{const signal=lifetime.current.signal,current=++version.current;setLoading(true);
    try{const result=await listReadingExplanations(projectId,paperId,signal);if(signal.aborted||current!==version.current)return;const matched=result.runs.filter(belongs);setRuns(matched);setError('');
      if(pendingId.current){const original=matched.find(run=>run.request?.requestId===pendingId.current);if(original){setSelectedId(original.id);setUncertain(false);setCheckedUnknown(false);pendingId.current=null;}else setCheckedUnknown(true);}}
    catch(cause){if(!signal.aborted&&current===version.current)setError(`读取解释记录失败：${readerError(cause)}`);}finally{if(!signal.aborted&&current===version.current)setLoading(false);}
  };
  useEffect(()=>{const controller=new AbortController();lifetime.current=controller;return()=>{controller.abort();version.current++;};},[projectId,paperId,key]);
  useEffect(()=>{if(active&&selection)void refresh();},[active]);
  const ordered=[...runs].sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt)),run=ordered.find(item=>item.id===selectedId)||ordered[0];
  const hasActive=ordered.some(item=>!terminal(item));
  useEffect(()=>{if(!active||!run||terminal(run))return;let disposed=false,inFlight=false;
    const timer=window.setInterval(()=>{if(inFlight||lock.current)return;inFlight=true;const current=++version.current;void getHarnessRun(projectId,run.id).then(result=>{if(!disposed&&!lifetime.current.signal.aborted&&current===version.current)retain(result.run);}).catch(cause=>{if(!disposed&&!lifetime.current.signal.aborted&&current===version.current)setError(`刷新原 Run 失败：${readerError(cause)}`);}).finally(()=>{inFlight=false;});},2500);
    return()=>{disposed=true;window.clearInterval(timer);};
  },[active,run?.id,run?.status]);
  const explain=async(newRequest=false)=>{if(lock.current||!selection||hasActive||uncertain&&!newRequest)return;lock.current=true;version.current++;setBusy(true);setLoading(false);setError('');setNotice('');setCheckedUnknown(false);const signal=lifetime.current.signal,requestId=crypto.randomUUID();pendingId.current=requestId;
    try{const result=await createReadingExplanation(projectId,paperId,{requestId,selection,targetLanguage:'zh-CN',...(question.trim()?{question:question.trim()}:{})},signal);if(!signal.aborted){if(!belongs(result.run))throw new Error('解释 Run 的来源与当前选区不匹配，请在任务页核对。');retain(result.run);setSelectedId(result.run.id);setUncertain(false);pendingId.current=null;}}
    catch(cause){if(!signal.aborted){const code=(cause as {code?:string})?.code;const knownRejection=['READING_EXPLANATION_INVALID','READING_SOURCE_CHANGED'].includes(code||'');setUncertain(!knownRejection);if(knownRejection)pendingId.current=null;setError(readerError(cause));}}
    finally{lock.current=false;if(!signal.aborted)setBusy(false);}
  };
  const cancel=async()=>{if(!run||terminal(run)||lock.current)return;lock.current=true;version.current++;setBusy(true);setError('');const signal=lifetime.current.signal;
    try{const result=await cancelHarnessRun(projectId,run.id);if(!signal.aborted){retain(result.run);setNotice('已请求取消原 Run，以实际任务状态为准。');}}
    catch(cause){if(!signal.aborted)setError(`取消原 Run 失败：${readerError(cause)}`);}finally{lock.current=false;if(!signal.aborted)setBusy(false);}
  };
  const copy=async()=>{if(!run?.reply)return;try{await navigator.clipboard.writeText(run.reply);if(!lifetime.current.signal.aborted)setNotice('解释已复制。');}catch{if(!lifetime.current.signal.aborted)setNotice('复制未成功，可以手动选择解释文本。');}};
  return <section className="reading-assistant-panel" aria-label="选区 AI 解释"><header><h2>AI 解释</h2><button disabled={busy||loading||!selection} onClick={()=>void refresh()}>{loading?'读取中…':'刷新记录'}</button></header>
    {selection?<><div className="reading-assistant-actions"><strong>选中原文</strong><button onClick={()=>onLocate(selection.page)}>第 {selection.page} 页</button></div><blockquote className="reader-quote">{selection.text}</blockquote>
      <label>想了解什么（可选）<textarea maxLength={2000} rows={3} value={question} disabled={busy} onChange={event=>setQuestion(event.target.value)} placeholder="例如：这段公式的假设条件是什么？"/></label>
      <div className="reading-assistant-actions"><button className="reader-primary" disabled={busy||loading||hasActive||uncertain||selection.text.length>10000} onClick={()=>void explain()}>{busy?'正在处理…':hasActive?'原解释任务仍在运行':'解释选中文本'}</button>{run&&!terminal(run)&&<button disabled={busy} onClick={()=>void cancel()}>取消原 Run</button>}</div>
      {selection.text.length>10000&&<p className="reader-error">选文最多10000字符，请选择较短片段。</p>}
      {uncertain&&<div className="reading-assistant-uncertain"><p>上次提交结果尚未确认。先刷新记录或查看原任务，不会自动重发。</p><Link to={`/project/${encodeURIComponent(projectId)}/tasks`}>打开任务列表</Link>{checkedUnknown&&!hasActive&&<button disabled={busy||loading} onClick={()=>void explain(true)}>核对后新建解释请求</button>}</div>}
      {ordered.length>0&&<label className="reading-explanation-history">该选区记录<select value={run?.id||''} onChange={event=>setSelectedId(event.target.value)}>{ordered.map(item=><option key={item.id} value={item.id}>{new Date(item.createdAt).toLocaleString('zh-CN')} · {statusLabels[item.status]||item.status}</option>)}</select></label>}
      {run&&<article className="reading-explanation-result"><div className="reading-explanation-run"><strong>{statusLabels[run.status]||run.status}</strong><Link to={taskHref(projectId,`harness:${run.id}`)}>查看真实任务 ↗</Link></div><small>Run {run.id.slice(0,12)} · {usageLabel(run)}</small>{run.request?.readingSource?.question&&<p className="reader-muted">该次问题：{run.request.readingSource.question}</p>}
        {run.status==='completed'&&run.reply?<><div className="reading-explanation-answer"><ReactMarkdown skipHtml disallowedElements={['img']}>{run.reply}</ReactMarkdown></div><button onClick={()=>void copy()}>复制解释</button></>:run.status==='completed'?<p className="reader-error">Run 已完成，但未返回可展示的解释文本。</p>:!terminal(run)?<p role="status" className="reader-muted">正在等待原 Run 的解释结果，刷新不会重新调用模型。</p>:null}
        {run.error?.message&&<p role="alert" className="reader-error">{run.error.message}</p>}{run.status==='cancelled'&&<p className="reader-muted">该次解释已取消，原记录保留。</p>}
      </article>}
      {!ordered.length&&!loading&&!busy&&!error&&<p className="reader-muted">该选区尚无解释记录。点击后使用项目已配置模型。</p>}
    </>:<div className="reading-assistant-empty"><h3>先选中一段原文</h3><p>针对片段提问，解释会关联当前附件与页码。</p></div>}
    {error&&<p role="alert" className="reader-error">{error}</p>}{notice&&<p role="status" className="reader-muted">{notice}</p>}
    <p className="reader-muted reading-assistant-boundary">解释仅供阅读参考，不自动改论文或术语表。记录范围：当前论文最近100条解释 Run。</p>
  </section>;
}
