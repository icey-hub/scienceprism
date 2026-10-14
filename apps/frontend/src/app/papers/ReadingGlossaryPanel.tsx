import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { createReadingTerm, deleteReadingTerm, getReadingGlossary, updateReadingTerm, type ReadingGlossaryInput, type ReadingGlossaryState } from '../../api/readingAssistantAdapter';
import { readerError, type ReadingSelection } from '../../api/paperReaderAdapter';
import './ReadingAssistant.css';

const blank=():ReadingGlossaryInput=>({term:'',definition:'',sourceLanguage:'auto',targetLanguage:'zh-CN',source:null});
type GlossaryProps={projectId:string;paperId:string;attachmentId:string;fileSha256:string;selection:ReadingSelection|null;onLocate:(page:number)=>void};
export function ReadingGlossaryPanel(props:GlossaryProps){return <GlossaryWorkspace key={props.projectId} {...props}/>;}
function GlossaryWorkspace({projectId,paperId,attachmentId,fileSha256,selection,onLocate}:GlossaryProps) {
  const [state,setState]=useState<ReadingGlossaryState|null>(null),[draft,setDraft]=useState<ReadingGlossaryInput>(blank),[editing,setEditing]=useState<string|null>(null),[query,setQuery]=useState('');
  const [loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const lifetime=useRef(new AbortController()),version=useRef(0),lock=useRef(false);
  const refresh=async()=>{const signal=lifetime.current.signal,current=++version.current;setLoading(true);try{const result=await getReadingGlossary(projectId,signal);if(!signal.aborted&&current===version.current){setState(result);setError('');}}
    catch(cause){if(!signal.aborted&&current===version.current)setError(readerError(cause));}finally{if(!signal.aborted&&current===version.current)setLoading(false);}};
  useEffect(()=>{const controller=new AbortController();lifetime.current=controller;void refresh();return()=>{controller.abort();version.current++;};},[projectId]);
  const change=async(work:()=>Promise<ReadingGlossaryState>,success:string,clear=false)=>{if(lock.current)return;lock.current=true;version.current++;setLoading(false);setBusy(true);setError('');setNotice('');const signal=lifetime.current.signal;
    try{const result=await work();if(!signal.aborted){setState(result);setNotice(success);if(clear){setDraft(blank());setEditing(null);}}}
    catch(cause){if(!signal.aborted){const code=(cause as {code?:string})?.code;setError(`${readerError(cause)}${code?.includes('CONFLICT')?' 输入已保留，请刷新术语表后核对再保存。':''}`);}}
    finally{lock.current=false;if(!signal.aborted)setBusy(false);}
  };
  const fillSelection=()=>{if(!selection)return;if(selection.text.trim().length>200){setNotice('选区超过200字，请手动填写术语，或划选一个短词组。');return;}setEditing(null);setDraft({term:selection.text.trim(),definition:'',sourceLanguage:draft.sourceLanguage,targetLanguage:draft.targetLanguage,source:{paperId,attachmentId:selection.attachmentId,fileSha256:selection.fileSha256,page:selection.page,quote:selection.text,rects:selection.rects}});setNotice('选区已填入，请填写人工定义。');};
  const save=(event:FormEvent)=>{event.preventDefault();if(!state||!draft.term.trim()||!draft.definition.trim())return;const input={...draft,term:draft.term.trim(),definition:draft.definition.trim()};void change(()=>editing?updateReadingTerm(projectId,editing,state.revision,input,lifetime.current.signal):createReadingTerm(projectId,state.revision,input,lifetime.current.signal),'项目术语已保存。',true);};
  const entries=(state?.entries||[]).filter(entry=>`${entry.term}\n${entry.definition}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return <section className="reading-assistant-panel" aria-label="项目阅读术语">
    <header><h2>项目术语表</h2><button disabled={busy||loading} onClick={()=>void refresh()}>{loading?'读取中…':'刷新'}</button></header>
    {error&&<p role="alert" className="reader-error">{error} <button disabled={busy||loading} onClick={()=>void refresh()}>重读术语表</button></p>}{notice&&<p role="status" className="reader-muted">{notice}</p>}
    <form onSubmit={save}><fieldset disabled={busy||!state}><div className="reading-assistant-actions"><strong>{editing?'编辑术语':'新增术语'}</strong><button type="button" disabled={!selection} onClick={fillSelection}>用当前选区新建</button></div>
      <label>术语<input required maxLength={200} value={draft.term} onChange={event=>setDraft(current=>({...current,term:event.target.value}))} placeholder="词语或短语"/></label><label>人工定义<textarea required maxLength={4000} rows={4} value={draft.definition} onChange={event=>setDraft(current=>({...current,definition:event.target.value}))} placeholder="记录你在本文中采用的含义"/></label>
      <div className="reading-assistant-form-row"><label>原文语言<input required maxLength={32} value={draft.sourceLanguage} onChange={event=>setDraft(current=>({...current,sourceLanguage:event.target.value}))}/></label><label>定义语言<input required maxLength={32} value={draft.targetLanguage} onChange={event=>setDraft(current=>({...current,targetLanguage:event.target.value}))}/></label></div>
      {draft.source&&<details className="reading-assistant-source"><summary>关联原文 · 第 {draft.source.page} 页</summary><blockquote>{draft.source.quote}</blockquote><button type="button" onClick={()=>setDraft(current=>({...current,source:null}))}>解除选区关联</button></details>}
    </fieldset><div className="reading-assistant-actions"><button className="reader-primary" disabled={busy||!state||!draft.term.trim()||!draft.definition.trim()}>{busy?'保存中…':'保存术语'}</button>{editing&&<button type="button" disabled={busy} onClick={()=>{setEditing(null);setDraft(blank());}}>取消编辑</button>}</div></form>
    <p className="reader-muted">人工定义随项目保存，供阅读参考；不替换译文。</p>
    <label className="reading-glossary-search">查找术语<input value={query} onChange={event=>setQuery(event.target.value)} placeholder="术语或定义"/></label>
    <p className="reading-assistant-count">{state?`${state.entries.length} 条项目术语 · 当前显示 ${entries.length} 条`:'正在读取项目术语…'}</p>
    {entries.map(entry=><article key={entry.id} className="reading-glossary-entry"><h3>{entry.term}</h3><p>{entry.definition}</p><small>{entry.sourceLanguage} → {entry.targetLanguage} · {new Date(entry.updatedAt).toLocaleDateString('zh-CN')}</small>
      {entry.source&&<details className="reading-assistant-source"><summary>原文来源 · 第 {entry.source.page} 页</summary><blockquote>{entry.source.quote}</blockquote>{entry.source.paperId===paperId&&entry.source.attachmentId===attachmentId&&entry.source.fileSha256===fileSha256?<button onClick={()=>onLocate(entry.source!.page)}>回到本页</button>:<><p className="reader-muted">来自另一篇论文或附件版本</p><Link to={`/project/${encodeURIComponent(projectId)}/papers/${encodeURIComponent(entry.source.paperId)}/read?attachment=${encodeURIComponent(entry.source.attachmentId)}`}>打开来源附件</Link></>}</details>}
      <footer><button disabled={busy||!state} onClick={()=>{setEditing(entry.id);setDraft({term:entry.term,definition:entry.definition,sourceLanguage:entry.sourceLanguage,targetLanguage:entry.targetLanguage,source:entry.source||null});setNotice('');}}>编辑</button><button disabled={busy||!state} onClick={()=>state&&void change(()=>deleteReadingTerm(projectId,entry.id,state.revision,lifetime.current.signal),'术语已删除。',editing===entry.id)}>删除</button></footer>
    </article>)}
    {state&&!entries.length&&<p className="reader-muted">{query?'没有匹配的术语。':'可从当前选区新建术语，或手动记录定义。'}</p>}
  </section>;
}
