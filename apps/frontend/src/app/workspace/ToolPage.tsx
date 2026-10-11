import { Link, Navigate, useParams } from 'react-router-dom';
import { useState, type ComponentType } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ProjectWorkspaceFrame } from '../components/ProjectWorkspaceFrame';
import { isWorkspaceTool, WORKSPACE_TOOLS, type WorkspaceTool } from '../components/workspaceTools';
import { VisionPanel } from '../editor/VisionPanel';
import { LiteratureSearchPanel } from '../editor/LiteratureSearchPanel';
import { PlotPanel } from '../editor/PlotPanel';
import { WebsearchPanel } from '../editor/WebsearchPanel';
import { ReviewPanel } from '../editor/ReviewPanel';
import { usePaperReview } from '../editor/usePaperReview';
import { useProjectDocuments } from './useProjectDocuments';
import { ProjectDocumentTarget } from './ProjectDocumentTarget';
import { useVisionTool } from './useVisionTool';
import { useLiteratureSearch } from './useLiteratureSearch';
import { usePlotTool } from './usePlotTool';
import { useWebsearchTool } from './useWebsearchTool';
import { CollaborationWorkspace } from './CollaborationWorkspace';
import { workspaceModel } from './workspaceModel';
import './WorkspacePages.css';

type Documents=ReturnType<typeof useProjectDocuments>;
async function createBibliography(docs:Documents) { try { return await docs.createBib(); } catch(cause) { docs.report(cause); return undefined; } }
export default function ToolPage(){const {projectId='',tool=''}=useParams();if(!isWorkspaceTool(tool))return <Navigate replace to={`/project/${projectId}/tools`}/>;if(tool==='agent')return <Navigate replace to={`/project/${projectId}/chat`}/>;return <ToolWorkspace key={`${projectId}:${tool}`} projectId={projectId} tool={tool}/>;}
function ToolWorkspace({projectId,tool}:{projectId:string;tool:Exclude<WorkspaceTool,'agent'>}){
 const docs=useProjectDocuments(projectId),definition=WORKSPACE_TOOLS.find(item=>item.id===tool)!;
 const Content=TOOL_CONTENT[tool];
 return <ProjectWorkspaceFrame projectId={projectId} projectName={docs.name} active="tools" title={definition.label}>
  <div className="standalone-tool"><div className="workspace-page-heading"><div><Link className="workspace-back-link" to={`/project/${projectId}/tools`}>工具执行 /</Link><h1>{definition.label}</h1><p>{definition.detail}</p></div><Link className="hub-small-button is-quiet" to={`/project/${projectId}/models`}>模型设置</Link></div>
   {tool!=='files'&&<div className="workspace-tool-context"><ProjectDocumentTarget paths={docs.texFiles} value={docs.path} onChange={docs.setPath}/>{docs.path&&<Link to={`/editor/${projectId}?file=${encodeURIComponent(docs.path)}`}>打开文稿 ↗</Link>}</div>}
   {docs.error&&<p role="alert">{docs.error}</p>}{docs.notice&&<p role="status">{docs.notice}</p>}{docs.loading&&<p role="status">正在读取项目文件…</p>}
   <div className="workspace-tool-card"><Content docs={docs}/></div>
  </div>
 </ProjectWorkspaceFrame>;
}
function VisionWorkspace({docs}:{docs:Documents}){const controller=useVisionTool(docs);return <VisionPanel {...controller}/>;}
function SearchWorkspace({docs}:{docs:Documents}){const controller=useLiteratureSearch(docs);return <><LiteratureSearchPanel {...controller} bibFiles={docs.bibFiles} texFiles={docs.texFiles} createBibFile={()=>createBibliography(docs)}/>{controller.assistant.error&&<p role="alert">{controller.assistant.error}</p>}<Link className="workspace-result-link" to={`/project/${docs.projectId}/chat`}>到项目对话审阅引用修改 ↗</Link></>;}
function PlotWorkspace({docs}:{docs:Documents}){const controller=usePlotTool(docs);return <><label className="workspace-table-input">LaTeX 表格<textarea className="input" aria-label="绘图表格" rows={8} value={controller.table} onChange={event=>controller.setTable(event.target.value)} placeholder={'\\begin{tabular}{lc}\nMethod & Score \\\\\nA & 1 \\\\\n\\end{tabular}'}/></label><PlotPanel {...controller}/></>;}
function WebsearchWorkspace({docs}:{docs:Documents}){const controller=useWebsearchTool(docs);return <WebsearchPanel {...controller} bibFiles={docs.bibFiles} texFiles={docs.texFiles} createBibFile={()=>createBibliography(docs)}/>;}
function ReviewWorkspace({docs}:{docs:Documents}){const [compileLog,setCompileLog]=useState('');const review=usePaperReview({projectId:docs.projectId,activePath:docs.path,compileLog,llmConfig:workspaceModel(),onReport:()=>{}});return <><details className="workspace-compile-context"><summary>提供编译日志</summary><textarea className="input" aria-label="评审编译日志" rows={5} value={compileLog} onChange={event=>setCompileLog(event.target.value)}/></details><ReviewPanel controller={review}/>{review.reviewReport&&<section className="workspace-review-result"><h2>评审报告</h2><div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{review.reviewReport}</ReactMarkdown></div></section>}</>;}
function FilesWorkspace({docs}:{docs:Documents}){return <><h2>项目文件</h2><div className="workspace-file-list">{docs.items.filter(item=>item.type==='file').map(item=><Link key={item.path} to={`/editor/${docs.projectId}?file=${encodeURIComponent(item.path)}`}><span>{item.path}</span><span>打开 ↗</span></Link>)}</div>{!docs.loading&&!docs.items.length&&<p>项目还没有文件。</p>}</>;}

const TOOL_CONTENT:Record<Exclude<WorkspaceTool,'agent'>,ComponentType<{docs:Documents}>>={
 files:FilesWorkspace,search:SearchWorkspace,websearch:WebsearchWorkspace,
 vision:VisionWorkspace,plot:PlotWorkspace,review:ReviewWorkspace,collab:CollaborationWorkspace
};
