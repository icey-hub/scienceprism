import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Background, BackgroundVariant, Controls, Handle, MarkerType, MiniMap, Position, ReactFlow, type Node, type NodeProps, type ReactFlowInstance, type Viewport, useNodesState } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { getProjectExploration, type ExplorationGraph, type ExplorationNode } from '../../api/explorationAdapter';
import { listProjects } from '../../api/client';
import { ProjectWorkspaceFrame } from '../components/ProjectWorkspaceFrame';
import { EvidenceSourceLocation } from './ClaimMaterials';
import './ExplorationPage.css';

const KINDS: Record<string,string> = { stage:'项目阶段', harness:'任务', call:'工具调用', experiment:'实验', artifact:'产物', evidence:'证据材料', claim:'主张' };
const RELATIONS: Record<string,string> = { delegates:'委派', replays:'重放', runs:'执行', calls:'调用', references:'引用', reports:'报告', produces:'产出', contradicts:'反例', supports:'支持' };
const COLORS: Record<string,string> = { stage:'#737373', harness:'#2563eb', call:'#0891b2', experiment:'#7c3aed', artifact:'#a16207', evidence:'#15803d', claim:'#be123c' };
type GraphNode = Node<{ record: ExplorationNode; select: (id:string)=>void }, 'record'>;
function RecordNode({ data, selected }: NodeProps<GraphNode>) {
  return <div className={`exploration-node ${selected ? 'is-selected' : ''}`} style={{borderTopColor:COLORS[data.record.kind]}}>
    <Handle type="target" position={Position.Left} /><small>{KINDS[data.record.kind] || data.record.kind}</small><button className="nodrag" onClick={()=>data.select(data.record.id)}>{data.record.title}</button><span>{data.record.status}</span><Handle type="source" position={Position.Right} />
  </div>;
}
const NODE_TYPES = { record:RecordNode };
function readView(key:string): { viewport?:Viewport; collapsed?:string[]; positions?:Record<string,{x:number;y:number}> } {
  try { const value=JSON.parse(localStorage.getItem(key) || '{}'); return value && typeof value==='object' ? value : {}; } catch { return {}; }
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
  const storageKey=`sp_explore:${projectId}:${lens}${rootId ? `:${rootId}` : ''}`;
  const saved=useMemo(()=>readView(storageKey),[storageKey]);
  const positions=useRef(saved.positions || {});
  useEffect(()=>{positions.current=saved.positions || {};setCollapsed(Array.isArray(saved.collapsed)?saved.collapsed.filter((id:unknown)=>typeof id==='string'):[]);},[saved]);
  const save=useCallback((viewport?:Viewport)=>{ try { localStorage.setItem(storageKey,JSON.stringify({positions:positions.current,collapsed,viewport:viewport || instance.current?.getViewport() || saved.viewport})); } catch { /* Viewing remains available if storage is full. */ } },[storageKey,collapsed,saved.viewport]);
  useEffect(()=>{save();},[collapsed,save]);
  const update=(values:Record<string,string|null>)=>setParams(old=>{const next=new URLSearchParams(old);for(const [key,value] of Object.entries(values)) value===null ? next.delete(key) : next.set(key,value);return next;});
  useEffect(()=>{let active=true;listProjects().then(result=>{if(active)setName(result.projects.find(project=>project.id===projectId)?.name || projectId);}).catch(()=>{});return()=>{active=false;};},[projectId]);
  const revision=useRef(0);
  const load=useCallback(async()=>{const current=++revision.current;setBusy(true);try {const result=await getProjectExploration(projectId,{lens,...(rootId ? {rootId} : {})});if(current===revision.current){setGraph(result.graph);setError('');}}catch(error){if(current===revision.current)setError(String(error));}finally{if(current===revision.current)setBusy(false);}},[projectId,lens,rootId]);
  useEffect(()=>{setGraph(null);void load();},[load]);
  const connected=new Set(graph?.edges.flatMap(edge=>[edge.from,edge.to]));
  const hidden=new Set(graph?.edges.filter(edge=>edge.type==='calls' && collapsed.includes(edge.from)).map(edge=>edge.to));
  const records=(graph?.nodes || []).filter(node=>(!kind || kind===node.kind) && (!status || status===node.status) && (showPending || node.kind!=='stage' || node.status!=='pending' || connected.has(node.id)));
  const displayed=records.filter(node=>!hidden.has(node.id));
  const laneRows=new Map<number,number>();
  const occupied=new Set(Object.values(positions.current).map(point=>`${point.x}:${point.y}`));
  const layout:GraphNode[]=displayed.map(record=>{
    const lane=({stage:0,harness:1,experiment:1,claim:0,call:2,evidence:2,artifact:2}[record.kind] ?? 1);
    if(!positions.current[record.id]) {
      let row=laneRows.get(lane) || 0;
      while(occupied.has(`${lane*300}:${row*115}`)) row++;
      positions.current[record.id]={x:lane*300,y:row*115};
      occupied.add(`${lane*300}:${row*115}`); laneRows.set(lane,row+1);
    }
    return {id:record.id,type:'record',position:positions.current[record.id],data:{record,select:id=>update({node:id,edge:null})},selected:record.id===selected,ariaLabel:`${KINDS[record.kind]}：${record.title}，${record.status}`};
  });
  const [nodes,setNodes,onNodesChange]=useNodesState<GraphNode>([]);
  const layoutKey=JSON.stringify(layout);
  useEffect(()=>{setNodes(layout);},[layoutKey,setNodes]);
  const ids=new Set(displayed.map(node=>node.id));
  const edges=(graph?.edges || []).filter(edge=>ids.has(edge.from)&&ids.has(edge.to)).map(edge=>({id:edge.id,source:edge.from,target:edge.to,label:RELATIONS[edge.type] || edge.type,markerEnd:{type:MarkerType.ArrowClosed},style:{stroke:edge.type==='contradicts'?'#be123c':'#a3a3a3'},selected:edge.id===edgeId}));
  const detail=graph?.nodes.find(node=>node.id===selected);
  const relation=graph?.edges.find(edge=>edge.id===edgeId);
  const statuses=[...new Set(graph?.nodes.map(node=>node.status))];
  const viewport=saved.viewport && Number.isFinite(saved.viewport.x) && Number.isFinite(saved.viewport.y) && saved.viewport.zoom>0 ? saved.viewport : {x:24,y:24,zoom:0.8};
  return <ProjectWorkspaceFrame projectId={projectId} projectName={name} active="evidence" title="探索">
    <div className="exploration-toolbar"><div className="task-detail-tabs" aria-label="探索视角">{(['execution','evidence'] as const).map(value=><button key={value} className={lens===value?'is-active':''} onClick={()=>update({lens:value,node:null,edge:null,root:null})}>{value==='execution'?'执行链路':'证据链路'}</button>)}</div><Link className="hub-small-button is-quiet" to={`/project/${encodeURIComponent(projectId)}/evidence`}>证据材料</Link><button className="hub-small-button is-quiet" disabled={busy} onClick={()=>void load()}>{busy?'正在读取…':'刷新'}</button>{rootId && <button className="hub-small-button is-quiet" onClick={()=>update({root:null})}>显示全部记录</button>}</div>
    <p className="exploration-note">运行完成、人工决定与科研支持状态分别记录。连线来自已保存的引用；仅查询现有记录。</p>
    {error && <p role="alert">读取失败，已加载的图仍可查看：{error}</p>}
    {graph && <><div className="exploration-toolbar"><label>类型 <select value={kind} onChange={event=>setKind(event.target.value)}><option value="">全部类型</option>{Object.entries(KINDS).map(([key,value])=><option key={key} value={key}>{value}</option>)}</select></label><label>状态 <select value={status} onChange={event=>setStatus(event.target.value)}><option value="">全部状态</option>{statuses.map(value=><option key={value}>{value}</option>)}</select></label><label><input type="checkbox" checked={showPending} onChange={event=>setShowPending(event.target.checked)} /> 显示待开始节点</label><button className="hub-small-button is-quiet" onClick={()=>update({view:list?'graph':'list'})}>{list?'图形视图':'列表视图'}</button><button className="hub-small-button is-quiet" onClick={()=>void instance.current?.fitView({padding:0.2,duration:200})}>适配画布</button></div>
    <div className="exploration-layout"><div className="exploration-canvas">{list ? <div className="exploration-list" aria-label="探索节点列表">{records.length ? records.map(node=><button key={node.id} aria-pressed={selected===node.id} onClick={()=>update({node:node.id,edge:null})}><span style={{color:COLORS[node.kind]}}>{KINDS[node.kind]}</span><strong>{node.title}</strong><small>{node.status} · {node.id}</small></button>) : <p>当前筛选没有节点。</p>}</div> : <ReactFlow<GraphNode> key={storageKey} nodes={nodes} edges={edges} nodeTypes={NODE_TYPES} onNodesChange={onNodesChange} onInit={value=>{instance.current=value;}} defaultViewport={viewport} minZoom={0.1} maxZoom={2} nodesConnectable={false} deleteKeyCode={null} onNodeClick={(_event,node)=>update({node:node.id,edge:null})} onEdgeClick={(_event,edge)=>update({edge:edge.id,node:null})} onNodeDragStop={(_event,node)=>{positions.current[node.id]=node.position;save();}} onMoveEnd={(_event,view)=>save(view)} ariaLabelConfig={{'controls.zoomIn.ariaLabel':'放大','controls.zoomOut.ariaLabel':'缩小','controls.fitView.ariaLabel':'适配画布'}}><Background variant={BackgroundVariant.Dots} gap={20} color="#d4d4d4" /><Controls showInteractive={false} /><MiniMap nodeColor={node=>COLORS[(node.data.record as ExplorationNode).kind] || '#737373'} pannable zoomable /></ReactFlow>}</div>
    <aside className="exploration-detail" aria-label="节点详情">{detail ? <><div className="exploration-toolbar"><strong>{KINDS[detail.kind]}</strong><button aria-label="关闭节点详情" onClick={()=>update({node:null})}>×</button></div><h2>{detail.title}</h2><p>状态：{detail.status}</p>{detail.decision && <p>人工决定：{detail.decision}</p>}<p>版本 / attempt：{detail.version ?? '未报告'}</p><p>保留范围：{detail.retention==='summary'?'归档摘要':detail.retained?'源记录可查询':'旧引用或源记录缺失'}</p>{detail.summary && <p>{detail.summary}</p>}<pre>{JSON.stringify(detail.sourceRef,null,2)}</pre>{detail.href && <Link className="hub-small-button" to={detail.href}>打开源记录</Link>}{detail.source && <EvidenceSourceLocation projectId={projectId} source={detail.source} historical={!detail.retained} />}{graph.edges.some(edge=>edge.from===detail.id && edge.type==='calls') && <button className="hub-small-button is-quiet" onClick={()=>setCollapsed(old=>old.includes(detail.id)?old.filter(id=>id!==detail.id):[...old,detail.id])}>{collapsed.includes(detail.id)?'展开工具调用':'折叠工具调用'}</button>}<button className="hub-small-button is-quiet" onClick={()=>update({root:detail.id})}>只看相关记录</button><h3>已记录关系</h3>{graph.edges.filter(edge=>edge.from===detail.id || edge.to===detail.id).map(edge=><button className="exploration-relation" key={edge.id} onClick={()=>update({edge:edge.id,node:null})}>{RELATIONS[edge.type] || edge.type} · {edge.from===detail.id?edge.to:edge.from}</button>)}</> : relation ? <><h2>{RELATIONS[relation.type] || relation.type}</h2>{[relation.from,relation.to].map(id=><button className="exploration-relation" key={id} onClick={()=>update({node:id,edge:null})}>{graph.nodes.find(node=>node.id===id)?.title || id}</button>)}<h3>连线来源</h3><pre>{JSON.stringify(relation.sourceRef,null,2)}</pre></> : <><h2>来源详情</h2><p>选择节点查看状态、版本和源记录。节点标题与列表视图支持 Tab 和 Enter；选中图节点后可用方向键移动。</p><div className="exploration-legend">{Object.entries(KINDS).map(([key,value])=><span key={key} style={{borderLeftColor:COLORS[key]}}>{value}</span>)}</div><p>unsupported：缺少支持；stale-reference：旧版本引用；contradicts：显式反例；human-confirmed：人工确认来源。</p></>}</aside></div>
    <p className="exploration-note">当前 {displayed.length} 节点 / {edges.length} 连线 · 查询 {graph.scope.displayedNodes}/{graph.scope.totalNodes} 节点（上限 {graph.scope.nodeLimit}）· 每 Run 最多 {graph.scope.callsPerRun} 次调用 · Harness / 实验各最多 {graph.scope.harnessLimit} 条</p>{graph.warnings.map(warning=><p className="exploration-note" key={warning}>{warning}</p>)}</>}
  </ProjectWorkspaceFrame>;
}
