import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowUp, MessageSquare, Square } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ProjectWorkspaceFrame } from '../components/ProjectWorkspaceFrame';
import { useAssistantRun } from '../editor/useAssistantRun';
import { useChangeReview } from '../editor/useChangeReview';
import { ConstraintProposalPanel } from '../editor/ConstraintProposalPanel';
import { SplitDiffView, buildSplitDiff } from '../editor/EditorDiff';
import { AssistantSkillPicker } from '../editor/AssistantSkillPicker';
import { useProjectDocuments } from './useProjectDocuments';
import { workspaceModel } from './workspaceModel';
import { ProjectDocumentTarget } from './ProjectDocumentTarget';
import { taskHref } from '../project/taskLocation';
import './WorkspacePages.css';

export default function ChatPage(){const {projectId=''}=useParams();return <ProjectChat key={projectId} projectId={projectId}/>;}
function ProjectChat({projectId}:{projectId:string}) {
 const docs=useProjectDocuments(projectId), assistant=useAssistantRun(projectId);
 const changes=useChangeReview(projectId,assistant.runs,assistant.remember);
 const [prompt,setPrompt]=useState(''),[edit,setEdit]=useState(false);
 const [reviewOpen,setReviewOpen]=useState(false);
 const submit=async()=>{
  if(!prompt.trim()||docs.busy||changes.busy)return;
  if(await assistant.start({task:'custom',prompt:prompt.trim(),permission:edit?'edit':'read',activePath:docs.path||undefined,history:assistant.history,skillNames:assistant.skillNames,llmConfig:workspaceModel()},docs.versions))setPrompt('');
 };
 const retry=async(run:typeof assistant.runs[number])=>{
  if(!run.request)return;
  await assistant.start({...run.request, task:run.request.task||run.task,prompt:run.request.prompt||run.task,permission:run.request.permission||'read',selection:'',llmConfig:workspaceModel()},async()=>run.request?.activePath?[{path:run.request.activePath,...(await docs.read(run.request.activePath)).version}]:[]);
 };
 const status:Record<string,string>={created:'等待启动',running:'运行中',paused:'已暂停',completed:'已完成',failed:'失败',cancelled:'已停止'};
 return <ProjectWorkspaceFrame projectId={projectId} projectName={docs.name} active="chat" title="对话">
  <div className="project-chat">
   <div className="workspace-page-heading"><div><h1>项目对话</h1><p>围绕资料、研究问题和文稿展开讨论。</p></div><button className="hub-small-button" aria-expanded={reviewOpen} onClick={()=>setReviewOpen(!reviewOpen)}>审阅修改{changes.pending.length?` (${changes.pending.length})`:''}</button></div>
   {docs.error&&<p role="alert">{docs.error}</p>}
   <div className="project-conversation" aria-label="项目对话历史" aria-live="polite">
    {assistant.loading&&<p role="status">正在恢复会话…</p>}
    {!assistant.loading&&!assistant.runs.length&&<div className="conversation-empty"><MessageSquare size={32}/><h2>从一个研究问题开始</h2><p>可以梳理现有资料、比较研究方法，或讨论下一步。</p>{['这个项目目前有哪些研究材料？','帮我梳理研究问题和待验证的假设','总结当前文稿，指出需要补充的证据'].map(text=><button key={text} onClick={()=>setPrompt(text)}>{text}<ArrowUp size={14}/></button>)}</div>}
    {[...assistant.runs].reverse().map(run=><article className="conversation-turn" key={run.id} data-run-id={run.id}>
     <div className="conversation-question">{run.request?.prompt||run.task}</div>
     <div className="conversation-answer"><div className="conversation-status"><span className={`run-dot is-${run.status}`}/>{status[run.status]||run.status}<Link to={taskHref(projectId,`harness:${run.id}`)}>查看执行记录</Link></div>
      {run.reply&&<div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{run.reply}</ReactMarkdown></div>}
      {run.error&&<p role="alert">{run.error.message}</p>}
      {run.constraintProposalError&&<p role="status">{run.constraintProposalError.message}</p>}
      {Boolean(run.patches?.length)&&<button className="hub-small-button" onClick={()=>setReviewOpen(true)}>查看修改建议</button>}
      {['failed','cancelled'].includes(run.status)&&<button className="hub-small-button" disabled={assistant.busy} onClick={()=>void retry(run)}>使用当前文件重试</button>}
      <details><summary>上下文与工具记录</summary><p>{run.model} · {run.request?.permission==='edit'?'提出修改':'只读问答'} · Skill：{run.skills?.join(', ')||'无'}</p><pre>{JSON.stringify(run.contextManifest||{},null,2)}</pre>{run.events?.slice(-12).map((event,index)=><p key={index}>{event.type}{event.name?` · ${event.name}`:''}</p>)}</details>
     </div>
    </article>)}
   </div>
   {reviewOpen&&<section className="conversation-review" aria-label="修改审阅"><h2>修改审阅</h2><p>确认差异后再应用到项目；文件版本变化时会拒绝覆盖。</p>{changes.error&&<p role="alert">{changes.error}</p>}{!changes.pending.length&&<p>没有待审阅的修改。</p>}{changes.pending.map(change=><article key={`${change.runId}:${change.filePath}`}><h3>{change.filePath}{change.deleted?' · 删除文件':''}</h3><SplitDiffView rows={buildSplitDiff(change.original,change.proposed)}/><div className="workspace-actions"><button className="hub-small-button" disabled={changes.busy} onClick={()=>void changes.review([change],'accept',work=>docs.perform(work))}>接受并应用</button><button className="hub-small-button is-quiet" disabled={changes.busy} onClick={()=>void changes.review([change],'reject',async work=>work())}>拒绝</button></div></article>)}</section>}
   {assistant.runs.some(run=>run.constraintProposal)&&<ConstraintProposalPanel projectId={projectId} refreshToken={assistant.runs.filter(run=>run.constraintProposal).length}/>}
   <form className="conversation-composer" onSubmit={event=>{event.preventDefault();void submit();}}>
    {assistant.error&&<p role="alert">{assistant.error}</p>}
    <textarea aria-label="消息" placeholder="向项目提问，或描述希望完成的任务…" value={prompt} onChange={event=>setPrompt(event.target.value)} rows={3} onKeyDown={event=>{if(event.key==='Enter'&&(event.ctrlKey||event.metaKey)){event.preventDefault();void submit();}}}/>
    <div className="conversation-compose-options"><ProjectDocumentTarget paths={docs.texFiles} value={docs.path} onChange={docs.setPath} label="上下文"/><label><input type="checkbox" checked={edit} disabled={assistant.busy} onChange={event=>setEdit(event.target.checked)}/>允许提出修改</label><Link to={`/project/${projectId}/models`}>模型设置</Link>{assistant.activeRun?<button type="button" className="conversation-send" aria-label="停止运行" disabled={assistant.stopping} onClick={()=>void assistant.stop()}><Square size={16}/></button>:<button className="conversation-send" aria-label="发送消息" disabled={assistant.busy||docs.loading||docs.busy||changes.busy||!prompt.trim()}><ArrowUp size={19}/></button>}</div>
    <AssistantSkillPicker assistant={assistant}/>
   </form>
  </div>
 </ProjectWorkspaceFrame>;
}
