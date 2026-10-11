import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Background, BackgroundVariant, Controls, MarkerType, MiniMap, Panel, ReactFlow, type ReactFlowInstance, type Viewport, useNodesState } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { getProjectExploration, type ExplorationGraph, type ExplorationNode } from '../../api/explorationAdapter';
import { listProjects } from '../../api/client';
import { ProjectWorkspaceFrame } from '../components/ProjectWorkspaceFrame';
import { ResearchAutomationPanel } from './ResearchAutomationPanel';
import { EvidenceSourceLocation } from './ClaimMaterials';
import { horizontalExplorationLayout, researchExecutionLayout, type GraphPoint } from './explorationLayout';
import { normalizeExplorationView, type SavedExplorationView } from './explorationView';
import { ExplorationRecord, NODE_META, RELATION_META, nodeMeta, statusLabel, type ExplorationFlowNode } from './ExplorationRecord';
import './ExplorationPage.css';

const KINDS = Object.fromEntries(Object.entries(NODE_META).map(([key, meta]) => [key, meta.label]));
const RELATIONS = Object.fromEntries(Object.entries(RELATION_META).map(([key, meta]) => [key, meta.label]));
type GraphNode = ExplorationFlowNode;
const NODE_TYPES = { record: ExplorationRecord };
function readView(key:string,previousKey?:string): SavedExplorationView {
  try {
    const current=localStorage.getItem(key);
    if(current) return normalizeExplorationView(JSON.parse(current));
    const previous=previousKey ? localStorage.getItem(previousKey) : null;
    return normalizeExplorationView(previous ? {...JSON.parse(previous),version:1} : null);
  } catch { return normalizeExplorationView(null); }
}
export default function ExplorationPage() {
  const { projectId='' }=useParams(); return <ExplorationSession key={projectId} projectId={projectId} />;
}
function ExplorationSession({projectId}:{projectId:string}) {
  const [params,setParams]=useSearchParams();
  const lens=params.get('lens')==='evidence' ? 'evidence' : 'execution';
  const list=params.get('view')==='list';
  const selected=params.get('node');
  const edgeId=params.get('edge');
  const rootId=params.get('root') || undefined;
  const [graph,setGraph]=useState<ExplorationGraph|null>(null);
  const [name,setName]=useState(projectId);
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  const [kind,setKind]=useState(''); const [status,setStatus]=useState(''); const [showPending,setShowPending]=useState(false);
  const [collapsed,setCollapsed]=useState<string[]>([]);
  const instance=useRef<ReactFlowInstance<GraphNode>|null>(null);
  const legacyStorageKey=`sp_explore:${projectId}:${lens}${rootId ? `:${rootId}` : ''}`;
  const storageKey=legacyStorageKey+(lens==='execution' && !rootId ? ':research-v1' : '');
  const saved=useMemo(()=>readView(storageKey,storageKey!==legacyStorageKey ? legacyStorageKey : undefined),[storageKey,legacyStorageKey]);
  const positions=useRef<Record<string,GraphPoint>>(saved.positions);
  const [layoutRevision,setLayoutRevision]=useState(0);
  const detailRef=useRef<HTMLElement|null>(null);
  const previousPositions=saved.previousPositions;
  const previousViewport=saved.previousViewport;
  useEffect(()=>{positions.current=saved.positions;setCollapsed(Array.isArray(saved.collapsed)?saved.collapsed.filter((id:unknown)=>typeof id==='string'):[]);},[saved]);
  const save=useCallback((viewport?:Viewport)=>{ try { localStorage.setItem(storageKey,JSON.stringify({version:2,positions:positions.current,collapsed,viewport:viewport || instance.current?.getViewport() || saved.viewport,previousPositions,previousViewport})); } catch { /* Viewing remains available if storage is full. */ } },[storageKey,collapsed,saved,previousPositions,previousViewport]);
  useEffect(()=>{save();},[collapsed,save]);
  const update=(values:Record<string,string|null>)=>setParams(old=>{const next=new URLSearchParams(old);for(const [key,value] of Object.entries(values)) value===null ? next.delete(key) : next.set(key,value);return next;});
  useEffect(()=>{let active=true;listProjects().then(result=>{if(active)setName(result.projects.find(project=>project.id===projectId)?.name || projectId);}).catch(()=>{});return()=>{active=false;};},[projectId]);
  const revision=useRef(0);
  const load=useCallback(async()=>{const current=++revision.current;setBusy(true);try {const result=await getProjectExploration(projectId,{lens,...(rootId ? {rootId} : {})});if(current===revision.current){setGraph(result.graph);setError('');}}catch(error){if(current===revision.current)setError(String(error));}finally{if(current===revision.current)setBusy(false);}},[projectId,lens,rootId]);
  useEffect(()=>{setGraph(null);void load();},[load]);
  const connected=new Set(graph?.edges.flatMap(edge=>[edge.from,edge.to]));
  const hidden=new Set(graph?.edges.filter(edge=>edge.type==='calls' && collapsed.includes(edge.from)).map(edge=>edge.to));
  const records=(graph?.nodes || []).filter(node=>(!kind || kind===node.kind) && (!status || status===node.status) && (lens==='execution' || showPending || node.kind!=='stage' || node.status!=='pending' || connected.has(node.id)));
  const displayed=records.filter(node=>!hidden.has(node.id));
  const stageOrder=graph?.workflow?.stageOrder || [];
  const stageSpine=lens==='execution' && !rootId && stageOrder.length>0;
  const automatic=useMemo(()=>stageSpine ? researchExecutionLayout(graph?.nodes || [],graph?.edges || [],stageOrder) : horizontalExplorationLayout(graph?.nodes || [],graph?.edges || []),[graph,layoutRevision,stageSpine]);
  const occupied=new Set(Object.values(positions.current).map(point=>`${point.x}:${point.y}`));
  const layout:GraphNode[]=displayed.map(record=>{
    if(!positions.current[record.id]) {
      const point={...automatic[record.id]};
      while(occupied.has(`${point.x}:${point.y}`)) point.y+=152;
      positions.current[record.id]=point;occupied.add(`${point.x}:${point.y}`);
    }
    return {id:record.id,type:'record',position:positions.current[record.id],data:{record,select:id=>update({node:id,edge:null}),stageIndex:stageSpine && record.kind==='stage' ? stageOrder.indexOf(record.sourceRef.id)+1 : undefined,isCurrent:stageSpine && record.id===`stage:${graph?.workflow?.currentStage}`,optional:graph?.workflow?.optionalStageIds.includes(record.sourceRef.id),stageChild:stageSpine && graph?.edges.some(edge=>edge.to===record.id && edge.from.startsWith('stage:'))},selected:record.id===selected,ariaLabel:`${KINDS[record.kind]}：${record.title}，${statusLabel(record.status)}`};
  });
  const [nodes,setNodes,onNodesChange]=useNodesState<GraphNode>([]);
  const layoutKey=JSON.stringify(layout);
  useEffect(()=>{setNodes(layout);save();},[layoutKey,setNodes,save]);
  const ids=new Set(displayed.map(node=>node.id));
  const stageFlowEdges=stageSpine ? stageOrder.slice(1).map((stage,index)=>({id:`workflow-order:${stageOrder[index]}>${stage}`,from:`stage:${stageOrder[index]}`,to:`stage:${stage}`,type:'stage-order',sourceRef:{kind:'workflow-order',id:projectId,field:'stageOrder'}})).filter(edge=>graph?.nodes.some(node=>node.id===edge.from) && graph.nodes.some(node=>node.id===edge.to)) : [];
  const displayEdges=[...(graph?.edges || []),...stageFlowEdges];
  const edges=displayEdges.filter(edge=>ids.has(edge.from)&&ids.has(edge.to)).map(edge=>{
    const color=RELATION_META[edge.type]?.color || '#64748b';
    return {id:edge.id,source:edge.from,target:edge.to,sourceHandle:stageSpine && edge.from.startsWith('stage:') && edge.type!=='stage-order' ? 'execution' : undefined,targetHandle:stageSpine && edge.from.startsWith('stage:') && edge.type!=='stage-order' ? 'stage' : undefined,label:RELATIONS[edge.type] || edge.type,markerEnd:{type:MarkerType.ArrowClosed,color},style:{stroke:color,strokeWidth:edge.id===edgeId?2.5:1.5,strokeDasharray:edge.type==='stage-order'?'5 5':undefined},labelStyle:{fill:color,fontSize:11},labelBgStyle:{fill:'#f4f6f8'},labelBgPadding:[6,3] as [number,number],selected:edge.id===edgeId};
  });
  const detail=graph?.nodes.find(node=>node.id===selected);
  const relation=displayEdges.find(edge=>edge.id===edgeId);
  const statuses=[...new Set(graph?.nodes.map(node=>node.status))];
  const anchor=stageSpine ? graph?.nodes.find(node=>node.kind==='stage' && graph.edges.some(edge=>edge.from===node.id)) || graph?.nodes.find(node=>node.id===`stage:${graph.workflow?.currentStage}`) || graph?.nodes.find(node=>node.kind==='stage') : graph?.nodes.find(node=>connected.has(node.id) && !graph.edges.some(edge=>edge.to===node.id));
  const initialViewport={x:40-(stageSpine && anchor ? automatic[anchor.id]?.x || 0 : 0)*0.85,y:stageSpine ? 140 : anchor ? 240-(automatic[anchor.id]?.y || 0)*0.85 : 140,zoom:0.85};
  const viewport=saved.viewport && Number.isFinite(saved.viewport.x) && Number.isFinite(saved.viewport.y) && saved.viewport.zoom>0 ? saved.viewport : initialViewport;
  useEffect(()=>{
    if(!selected && !edgeId) return;
    const previous=document.activeElement as HTMLElement|null;
    detailRef.current?.focus({preventScroll:true});
    const close=(event:KeyboardEvent)=>{if(event.key==='Escape') { setParams(old=>{const next=new URLSearchParams(old);next.delete('node');next.delete('edge');return next;}); }};
    document.addEventListener('keydown',close);
    return()=>{document.removeEventListener('keydown',close);if(previous?.isConnected)previous.focus({preventScroll:true});};
  },[detail?.id,relation?.id,setParams]);
  const resetLayout=()=>{positions.current={};setLayoutRevision(value=>value+1);void instance.current?.setViewport(initialViewport);};
  const restoreLayout=()=>{positions.current={...previousPositions};setLayoutRevision(value=>value+1);if(previousViewport)void instance.current?.setViewport(previousViewport);};
  const locateStage=(stage:string)=>{const point=positions.current[`stage:${stage}`];if(point)void instance.current?.setViewport({x:40-point.x*0.85,y:140-point.y*0.85,zoom:0.85},{duration:200});};
  return <ProjectWorkspaceFrame projectId={projectId} projectName={name} active="evidence" title="探索">
    {lens==='execution'&&<ResearchAutomationPanel projectId={projectId}/>}
    <div className="exploration-toolbar"><div className="task-detail-tabs" aria-label="探索视角">{(['execution','evidence'] as const).map(value=><button key={value} className={lens===value?'is-active':''} onClick={()=>update({lens:value,node:null,edge:null,root:null})}>{value==='execution'?'执行链路':'证据链路'}</button>)}</div><Link className="hub-small-button is-quiet" to={`/project/${encodeURIComponent(projectId)}/evidence`}>证据材料</Link><button className="hub-small-button is-quiet" disabled={busy} onClick={()=>void load()}>{busy?'正在读取…':'刷新'}</button>{rootId && <button className="hub-small-button is-quiet" onClick={()=>update({root:null})}>显示全部记录</button>}</div>
    <p className="exploration-note">{lens==='execution' ? '八阶段是横向主干，阶段下展开实际任务、调用与产物。虚线表示阶段顺序，实线表示已保存的执行关联；复现可选，按项目确认策略由人工确认或自动继续。' : '从左到右查看主张、材料与产物；连线来自已保存的引用，科研支持状态与人工决定分别记录。'}</p>
    {error && <p role="alert">读取失败，已加载的图仍可查看：{error}</p>}
    {graph && <><div className="exploration-toolbar"><label>类型 <select value={kind} onChange={event=>setKind(event.target.value)}><option value="">全部类型</option>{Object.entries(KINDS).map(([key,value])=><option key={key} value={key}>{value}</option>)}</select></label><label>状态 <select value={status} onChange={event=>setStatus(event.target.value)}><option value="">全部状态</option>{statuses.map(value=><option key={value}>{value}</option>)}</select></label>{lens==='evidence' && <label><input type="checkbox" checked={showPending} onChange={event=>setShowPending(event.target.checked)} /> 显示待开始节点</label>}<button className="hub-small-button is-quiet" onClick={()=>update({view:list?'graph':'list'})}>{list?'图形视图':'列表视图'}</button>{stageSpine && <button className="hub-small-button is-quiet" onClick={()=>locateStage(graph.workflow?.currentStage || '')}>定位当前阶段</button>}<button className="hub-small-button is-quiet" onClick={resetLayout}>横向重新布局</button><button className="hub-small-button is-quiet" onClick={()=>void instance.current?.fitView({padding:0.15,duration:200})}>适配画布</button>{previousPositions && <button className="hub-small-button is-quiet" onClick={restoreLayout}>恢复旧布局</button>}</div>
    <div className="exploration-layout"><div className="exploration-canvas">{!displayed.length && !list && <div className="exploration-empty" role="status">当前筛选没有节点。可调整筛选或显示待开始节点。</div>}{list ? <div className="exploration-list" aria-label="探索节点列表">{records.length ? records.map(node=><button key={node.id} aria-pressed={selected===node.id} onClick={()=>update({node:node.id,edge:null})}><span style={{color:nodeMeta(node.kind).color}}>{KINDS[node.kind]}</span><strong>{node.title}</strong><small>{statusLabel(node.status)} · {node.id}</small></button>) : <p>当前筛选没有节点。</p>}</div> : <ReactFlow<GraphNode> key={storageKey} nodes={nodes} edges={edges} nodeTypes={NODE_TYPES} onNodesChange={onNodesChange} onInit={value=>{instance.current=value;save(value.getViewport());}} defaultViewport={viewport} minZoom={0.1} onPaneClick={()=>update({node:null,edge:null})} maxZoom={2} nodesConnectable={false} deleteKeyCode={null} onNodeClick={(_event,node)=>update({node:node.id,edge:null})} onEdgeClick={(_event,edge)=>update({edge:edge.id,node:null})} onNodeDragStop={(_event,node)=>{positions.current[node.id]=node.position;save();}} onMoveEnd={(_event,view)=>save(view)} ariaLabelConfig={{'controls.zoomIn.ariaLabel':'放大','controls.zoomOut.ariaLabel':'缩小','controls.fitView.ariaLabel':'适配画布'}}><Background variant={BackgroundVariant.Dots} gap={20} color="#cdd3dc" /><Controls showInteractive={false} /><Panel position="top-left" className="exploration-legend"><div>{Object.entries(NODE_META).map(([key,meta])=>{const Icon=meta.icon;return <span key={key}><span className="exploration-type-icon" style={{color:meta.color,backgroundColor:`${meta.color}12`}}><Icon size={13} aria-hidden="true" /></span>{meta.label}</span>;})}</div><div>{Object.entries(RELATION_META).filter(([key])=>displayEdges.some(edge=>edge.type===key)).map(([key,meta])=><span key={key} style={{color:meta.color}}><i className={`exploration-line-sample ${key==='stage-order' ? 'is-dashed' : ''}`} aria-hidden="true" />{meta.label}</span>)}</div></Panel>{stageSpine && <Panel position="bottom-center" className="exploration-stage-jump" aria-label="八阶段定位">{stageOrder.map((stage,index)=>{const record=graph.nodes.find(node=>node.id===`stage:${stage}`);return record && <button key={stage} className="nodrag" aria-label={`定位第 ${index+1} 阶段：${record.title}`} title={`${record.title} · ${statusLabel(record.status)}`} aria-current={graph.workflow?.currentStage===stage ? 'step' : undefined} onClick={()=>locateStage(stage)}><strong>{index+1}</strong><span>{record.title.replace('（可选）','')}</span></button>;})}</Panel>}<MiniMap nodeColor={node=>nodeMeta((node.data.record as ExplorationNode).kind).color} pannable zoomable /></ReactFlow>}</div>
    {(detail || relation) && <aside ref={detailRef} tabIndex={-1} className="exploration-detail" aria-label="来源详情">{detail ? <><div className="exploration-toolbar"><strong>{KINDS[detail.kind]}</strong><button aria-label="关闭节点详情" onClick={()=>update({node:null})}>×</button></div><h2>{detail.title}</h2><p>状态：{statusLabel(detail.status)} <small>({detail.status})</small></p>{detail.decision && <p>决定记录：{detail.decision}</p>}<p>版本 / attempt：{detail.version ?? '未报告'}</p><p>保留范围：{detail.retention==='summary'?'归档摘要':detail.retained?'源记录可查询':'旧引用或源记录缺失'}</p>{detail.summary && <p>{detail.summary}</p>}<pre>{JSON.stringify(detail.sourceRef,null,2)}</pre>{detail.href && <Link className="hub-small-button" to={detail.href}>打开源记录</Link>}{detail.source && <EvidenceSourceLocation projectId={projectId} source={detail.source} historical={!detail.retained} />}{graph.edges.some(edge=>edge.from===detail.id && edge.type==='calls') && <button className="hub-small-button is-quiet" onClick={()=>setCollapsed(old=>old.includes(detail.id)?old.filter(id=>id!==detail.id):[...old,detail.id])}>{collapsed.includes(detail.id)?'展开工具调用':'折叠工具调用'}</button>}<button className="hub-small-button is-quiet" onClick={()=>update({root:detail.id})}>只看相关记录</button><h3>已记录关系</h3>{displayEdges.filter(edge=>edge.from===detail.id || edge.to===detail.id).map(edge=><button className="exploration-relation" key={edge.id} onClick={()=>update({edge:edge.id,node:null})}>{RELATIONS[edge.type] || edge.type} · {edge.from===detail.id?edge.to:edge.from}</button>)}</> : relation ? <><button className="exploration-close" aria-label="关闭连线详情" onClick={()=>update({edge:null})}>×</button><h2>{RELATIONS[relation.type] || relation.type}</h2>{[relation.from,relation.to].map(id=><button className="exploration-relation" key={id} onClick={()=>update({node:id,edge:null})}>{graph.nodes.find(node=>node.id===id)?.title || id}</button>)}{relation.type==='stage-order' && <p>这是研究流程的阶段顺序，不代表这两个阶段已经执行或获批。论文复现可选，跳过后仍保留阶段记录；图页不会自动推进。</p>}<h3>连线来源</h3><pre>{JSON.stringify(relation.sourceRef,null,2)}</pre></> : null}</aside>}</div>
    <p className="exploration-note">当前 {displayed.length} 节点 / {edges.filter(edge=>!edge.id.startsWith('workflow-order:')).length} 保存关联{stageFlowEdges.length ? ` / ${edges.filter(edge=>edge.id.startsWith('workflow-order:')).length} 阶段顺序` : ''} · 查询 {graph.scope.displayedNodes}/{graph.scope.totalNodes} 节点（上限 {graph.scope.nodeLimit}）· 每 Run 最多 {graph.scope.callsPerRun} 次调用 · Harness / 实验各最多 {graph.scope.harnessLimit} 条</p>{graph.warnings.map(warning=><p className="exploration-note" key={warning}>{warning}</p>)}</>}
  </ProjectWorkspaceFrame>;
}
