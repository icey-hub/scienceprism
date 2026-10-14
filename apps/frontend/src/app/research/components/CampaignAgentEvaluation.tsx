import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { cancelHarnessRun } from '../../../api/assistantAdapter';
import { getCampaignAgentEvaluations, startCampaignAgentEvaluation, type CampaignAgentEvaluationRecord } from '../../../api/campaignEvaluationAdapter';
import './CampaignAgentEvaluation.css';

const finished=(status:string)=>['completed','failed','cancelled'].includes(status);
const campaignFinished=(status:string)=>['completed','failed','cancelled','budget_exhausted'].includes(status);
const statusLabels:Record<string,string>={created:'已创建',queued:'排队中',running:'评价中',paused:'已暂停',completed:'评价完成',failed:'评价失败',cancelled:'已取消'};
const verdictLabels={supported:'固定条件下支持',refuted:'固定条件下反证',insufficient:'证据不足'};
const task=(projectId:string,id:string)=>`/project/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(id)}`;
const message=(error:unknown)=>error instanceof Error?error.message:String(error);
function usageText(usage:CampaignAgentEvaluationRecord['usage']) {
  if(!usage)return '用量尚未报告';
  if(typeof usage.reportedTotalTokens==='number')return `${usage.reportedTotalTokens.toLocaleString()} 已报告 tokens${usage.estimated?' · 部分用量不确定':''}`;
  if(typeof usage.totalTokens==='number')return `${usage.totalTokens.toLocaleString()} ${usage.estimated?'预算计入 tokens（含预留）':'已报告 tokens'}`;
  return '用量尚未报告';
}
export function CampaignAgentEvaluation({projectId,campaignId,campaignStatus}:{projectId:string;campaignId:string;campaignStatus:string}) {
  return <EvaluationWorkspace key={`${projectId}:${campaignId}`} projectId={projectId} campaignId={campaignId} campaignStatus={campaignStatus}/>;
}
function EvaluationWorkspace({projectId,campaignId,campaignStatus}:{projectId:string;campaignId:string;campaignStatus:string}) {
  const storageKey=`campaign-evaluation-request:${projectId}:${campaignId}`;
  const [records,setRecords]=useState<CampaignAgentEvaluationRecord[]>([]),[selected,setSelected]=useState('');
  const [pending,setPending]=useState<string|null>(()=>{try{const id=sessionStorage.getItem(storageKey);return id&&/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(id)?id:null;}catch{return null;}});
  const [loading,setLoading]=useState(true),[loaded,setLoaded]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[checked,setChecked]=useState(false);
  const lifetime=useRef(new AbortController()),version=useRef(0),lock=useRef(false),pendingRef=useRef(pending);
  const clearPending=()=>{pendingRef.current=null;setPending(null);setChecked(false);try{sessionStorage.removeItem(storageKey);}catch{/* A completed receipt remains in server history. */}};
  const refresh=async()=>{
    const signal=lifetime.current.signal,current=++version.current;setLoading(true);
    try{const result=await getCampaignAgentEvaluations(projectId,campaignId,signal);
      if(signal.aborted||current!==version.current)return;
      const belonging=result.evaluations.filter(item=>item.source.campaignId===campaignId);setRecords(belonging);setLoaded(true);setError('');
      if(pendingRef.current){const original=belonging.find(item=>item.requestId===pendingRef.current);if(original){setSelected(original.runId);clearPending();setNotice('已找回原评价任务。');}else setChecked(true);}
    }catch(cause){if(!signal.aborted&&current===version.current){setChecked(false);setError(`读取评价失败：${message(cause)}。已读记录保留。`);}}
    finally{if(!signal.aborted&&current===version.current)setLoading(false);}
  };
  useEffect(()=>{const controller=new AbortController();lifetime.current=controller;void refresh();return()=>{controller.abort();version.current++;};},[projectId,campaignId]);
  const ordered=[...records].sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt)),record=ordered.find(item=>item.runId===selected)||ordered[0];
  const active=ordered.filter(item=>!finished(item.status));
  useEffect(()=>{if(!active.length&&!pending)return;let inFlight=false;const timer=window.setInterval(()=>{if(inFlight||lock.current)return;inFlight=true;void refresh().finally(()=>{inFlight=false;});},3000);return()=>window.clearInterval(timer);},[active.length,pending]);
  const start=async(recover=false)=>{
    if(lock.current||!loaded||!campaignFinished(campaignStatus)||active.length||pendingRef.current&&!recover||recover&&!checked)return;
    const requestId=recover?pendingRef.current:crypto.randomUUID();if(!requestId)return;
    try{sessionStorage.setItem(storageKey,requestId);}catch{setError('无法保存请求恢复记录，请允许本页使用会话存储后再试。');return;}
    pendingRef.current=requestId;setPending(requestId);setChecked(false);lock.current=true;version.current++;setBusy(true);setLoading(false);setError('');setNotice('正在使用项目已配置的 DeepSeek 审核原试验记录…');
    const signal=lifetime.current.signal;
    try{const result=await startCampaignAgentEvaluation(projectId,campaignId,requestId,signal);if(signal.aborted)return;
      if(result.evaluation.source.campaignId!==campaignId)throw new Error('返回的评价不属于当前批次，请核对原任务。');
      setRecords(current=>[result.evaluation,...current.filter(item=>item.runId!==result.evaluation.runId)]);setSelected(result.evaluation.runId);clearPending();setNotice('评价任务已保存，刷新会继续读取原任务。');
    }catch(cause){if(!signal.aborted){setNotice('');setError(message(cause));}}
    finally{lock.current=false;if(!signal.aborted)setBusy(false);}
  };
  const stop=async(runId:string)=>{
    if(lock.current)return;lock.current=true;version.current++;setBusy(true);setError('');
    try{await cancelHarnessRun(projectId,runId);if(!lifetime.current.signal.aborted){setNotice('已请求停止原评价，状态以原任务为准。');await refresh();}}
    catch(cause){if(!lifetime.current.signal.aborted)setError(`停止失败：${message(cause)}`);}
    finally{lock.current=false;if(!lifetime.current.signal.aborted)setBusy(false);}
  };
  return <section className="campaign-agent-evaluation" aria-label="独立 AI 评价">
    <header><div><h4>独立 AI 评价</h4><p>审核原试验的证据、局限与下一步，不改变已保存方案。</p></div><div className="campaign-agent-actions"><button type="button" className="research-button research-button-quiet" disabled={busy||loading} onClick={()=>void refresh()}>{loading?'读取中…':'刷新评价'}</button><button type="button" className="research-button research-button-secondary" disabled={busy||loading||!loaded||!!pending||!!active.length||!campaignFinished(campaignStatus)} onClick={()=>void start()}>{busy?'正在处理…':active.length?'原评价仍在进行':'DeepSeek 评价全部试验'}</button></div></header>
    {!campaignFinished(campaignStatus)&&<p className="research-panel-copy">批次结束后可评价；未完成与失败记录会一起保留。</p>}
    {error&&<p role="alert" className="validation-campaign-error">{error}</p>}{notice&&<p role="status" className="campaign-agent-note">{notice}</p>}
    {pending&&<div className="campaign-agent-pending"><p>上次请求尚未确认。先刷新核对原任务，继续核对会沿用同一请求。</p><Link to={`/project/${encodeURIComponent(projectId)}/tasks`}>查看任务列表</Link><button type="button" className="research-button research-button-quiet" disabled={busy||loading||!checked||!!active.length} onClick={()=>void start(true)}>继续核对原请求</button></div>}
    {!!ordered.length&&<label className="campaign-agent-history">评价记录<select value={record?.runId||''} onChange={event=>setSelected(event.target.value)}>{ordered.map(item=><option key={item.runId} value={item.runId}>{new Date(item.createdAt).toLocaleString('zh-CN')} · {statusLabels[item.status]||item.status}{item.sourceCurrent?'':' · 原来源已变化'}</option>)}</select></label>}
    {active.filter(item=>item.runId!==record?.runId).map(item=><div className="campaign-agent-run" key={item.runId}><span>{statusLabels[item.status]||item.status} · {new Date(item.createdAt).toLocaleString('zh-CN')}</span><Link to={task(projectId,`harness:${item.runId}`)}>原评价任务</Link><button type="button" className="research-button research-button-quiet" disabled={busy} onClick={()=>void stop(item.runId)}>停止原评价</button></div>)}
    {record&&<article className="campaign-agent-result"><div className="campaign-agent-run"><strong>{statusLabels[record.status]||record.status}</strong><Link to={task(projectId,`harness:${record.runId}`)}>查看原评价任务 ↗</Link>{!finished(record.status)&&<button type="button" className="research-button research-button-quiet" disabled={busy} onClick={()=>void stop(record.runId)}>停止原评价</button>}<small>{usageText(record.usage)}</small></div>
      {!record.sourceCurrent&&<p className="campaign-agent-stale" role="status">原结果来源已变化：这是对当时快照的评价，请勿当作当前批次结论。</p>}
      {record.status==='completed'&&record.output?<><div className="campaign-agent-conclusion"><strong className={`validation-verdict is-${record.output.verdict}`}>{verdictLabels[record.output.verdict]}</strong><p>{record.output.summary}</p></div>
        {!!record.output.findings.length&&<div className="campaign-agent-findings"><h5>AI 解读与来源</h5><p className="campaign-agent-note">模型表述需核对，数值与配对数量以原始比较表为准。</p><ul>{record.output.findings.map((finding,index)=><li key={index}><p>{finding.text}</p><span>{finding.runIds.filter(id=>record.source.trialRunIds.includes(id)).map(id=><Link key={id} to={task(projectId,`experiment-run:${id}`)}>原试验 {record.source.trialRunIds.indexOf(id)+1} ↗</Link>)}</span></li>)}</ul></div>}
        {!!record.output.limitations.length&&<details open className="campaign-agent-details"><summary>结论局限</summary><ul>{record.output.limitations.map((text,index)=><li key={index}>{text}</li>)}</ul></details>}
        {!!record.output.nextPlanSuggestions.length&&<details className="campaign-agent-details"><summary>下一方案建议 · 尚未执行</summary><ul>{record.output.nextPlanSuggestions.map((text,index)=><li key={index}>{text}</li>)}</ul></details>}
        <p className="campaign-agent-note">AI 评价基于冻结条件，不替代统计显著性判断；建议尚未写入方案或启动试验。</p>
      </>:record.status==='completed'?<p className="validation-campaign-error">任务完成，但没有可展示的结构化评价，请查看原任务。</p>:!finished(record.status)?<p className="research-panel-copy">正在读取原评价任务；刷新不会新建模型请求。暂停任务可查看或停止，不会自动重启。</p>:null}
      {record.error&&<p role="alert" className="validation-campaign-error">{record.error.message}</p>}
      <details className="campaign-agent-details"><summary>评价来源 · 方案 v{record.source.planRevision} · {record.source.trialRunIds.length} 个原试验</summary><div className="campaign-agent-sources">{record.source.trialRunIds.map((id,index)=><Link key={id} to={task(projectId,`experiment-run:${id}`)}>试验 {index+1} ↗</Link>)}</div></details>
    </article>}
    {!loading&&!ordered.length&&!error&&!pending&&<p className="research-empty-inline">尚无独立评价。原固定条件结果保留在上方。</p>}
  </section>;
}
