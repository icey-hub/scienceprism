import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { getValidationCampaigns, startValidationCampaign, type ValidationCampaign, type ValidationVariant, type IdeaPlan } from '../../../api/client';
import { automationApi, type AutomationState } from '../../../api/automationAdapter';
import { workspaceModel } from '../../workspace/workspaceModel';
import './ValidationCampaignPanel.css';

type VariantDraft = Omit<ValidationVariant,'parameters'> & {key:string;parameters:string};
type Candidate = {ideaId:string;title:string;plan:IdeaPlan|null};
const statusLabels:Record<string,string>={prepared:'待执行',pending:'待执行',reserved:'预留，尚未创建',queued:'排队中',running:'执行中',executing:'执行中',completed:'批次完成',failed:'运行失败',cancelled:'已取消',budget_exhausted:'预算已耗尽',stopping:'正在停止',stopped:'已停止',blocked:'需要处理',interrupted:'执行中断',waiting_confirmation:'等待原执行策略确认',awaiting_approval:'待执行授权',approved:'已授权'};
const terminalCampaign=(status:string)=>['completed','failed','cancelled','budget_exhausted'].includes(status);
const actualTrial=(trial:ValidationCampaign['trials'][number])=>!!trial.runId&&!!(trial.manifestSha256||trial.result||['awaiting_approval','approved','running','completed','failed','cancelled','rejected'].includes(trial.status));
const metricText=(value:unknown)=>typeof value==='number'?new Intl.NumberFormat('zh-CN',{maximumSignificantDigits:6}).format(value):String(value);
const taskLink=(projectId:string,id:string)=>`/project/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(id)}`;
const seedList=(text:string)=>text.split(/[\n,]/).map(item=>item.trim()).filter(Boolean);
const defaultVariants=():VariantDraft[]=>[{key:crypto.randomUUID(),id:'candidate',label:'候选方法',kind:'candidate',parameters:'{}'},{key:crypto.randomUUID(),id:'baseline',label:'对照基线',kind:'baseline',parameters:'{}'}];
function variantsFor(plan:IdeaPlan):VariantDraft[] {
  return [{key:crypto.randomUUID(),id:'candidate',label:'候选方法',kind:'candidate' as const,parameters:'{}'},
    ...plan.evaluation.baselines.map((label,index)=>({key:crypto.randomUUID(),id:`baseline-${index+1}`,label,kind:'baseline' as const,parameters:'{}'})),
    ...plan.evaluation.ablations.map((label,index)=>({key:crypto.randomUUID(),id:`ablation-${index+1}`,label,kind:'ablation' as const,parameters:'{}'}))];
}
function parameterIdentity(value:unknown):string {
  if(typeof value==='number'&&!Number.isFinite(value))throw new Error('参数数值必须有限。');
  if(Array.isArray(value))return `[${value.map(parameterIdentity).join(',')}]`;
  if(value&&typeof value==='object')return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${parameterIdentity((value as Record<string,unknown>)[key])}`).join(',')}}`;
  const encoded=JSON.stringify(value);if(encoded===undefined)throw new Error('参数只接受有限 JSON 值。');return encoded;
}
function parametersFor(variants:VariantDraft[]):ValidationVariant[] {
  return variants.map(({key:_key,parameters,...variant})=>{
    const parsed:unknown=JSON.parse(parameters);
    if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error(`${variant.label||variant.id} 参数必须是 JSON 对象。`);
    parameterIdentity(parsed);
    return {...variant,parameters:parsed as Record<string,unknown>};
  });
}
export function ValidationCampaignPanel({projectId}:{projectId:string}) {
  return <CampaignWorkspace key={projectId} projectId={projectId}/>;
}
function CampaignWorkspace({projectId}:{projectId:string}) {
  const [campaigns,setCampaigns]=useState<ValidationCampaign[]>([]),[candidates,setCandidates]=useState<Candidate[]>([]),[automation,setAutomation]=useState<AutomationState|null>(null);
  const [ideaId,setIdeaId]=useState(''),[seeds,setSeeds]=useState(''),[variants,setVariants]=useState<VariantDraft[]>(defaultVariants),[selectedId,setSelectedId]=useState('');
  const [loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[ready,setReady]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
  const alive=useRef(true),lock=useRef(false);
  const refresh=async(preferredSessionId?:string)=>{
    const [listed,state]=await Promise.all([getValidationCampaigns(projectId),automationApi.load(projectId)]);
    if(alive.current){setCampaigns(listed.campaigns);setCandidates((listed.candidates||[]).filter(item=>item.plan));setAutomation(state);setReady(true);
      if(preferredSessionId){const match=listed.campaigns.find(item=>item.sessionId===preferredSessionId);if(match)setSelectedId(match.id);}}
  };
  useEffect(()=>{
    alive.current=true;let disposed=false,timer:ReturnType<typeof setTimeout>;
    const tick=async()=>{if(!lock.current){try{await refresh();if(!disposed)setError(current=>current.startsWith('读取试验批次失败：')?'':current);}catch(reason){if(!disposed)setError(current=>current&&!current.startsWith('读取试验批次失败：')?current:`读取试验批次失败：${String(reason)}`);}finally{if(!disposed)setLoading(false);}}
      if(!disposed)timer=setTimeout(()=>void tick(),3000);};
    void tick();return()=>{disposed=true;alive.current=false;clearTimeout(timer);};
  },[projectId]);
  const chosen=candidates.find(item=>item.ideaId===ideaId),plan=chosen?.plan;
  const parsedSeeds=seedList(seeds),trialCount=parsedSeeds.length*variants.length;
  const exceedsBudget=!!plan&&(trialCount>(plan.evaluation.budget.maxRuns??0)||trialCount>20);
  const invalidSeedCount=!!plan&&parsedSeeds.length!==plan.evaluation.repetitions;
  const invalidFirstSeed=!!plan&&parsedSeeds[0]!==plan.evaluation.seed;
  const variantIds=variants.map(item=>item.id.trim());
  const invalidVariants=variants.length===0||variantIds.some(id=>!id)||new Set(variantIds).size!==variantIds.length;
  const variantIssues:string[]=[];
  if(plan){
    if(variants.filter(item=>item.kind==='candidate').length!==1)variantIssues.push('保留一组候选方法参数。');
    for(const [kind,expected] of [['baseline',plan.evaluation.baselines],['ablation',plan.evaluation.ablations]] as const){
      const actual=variants.filter(item=>item.kind===kind).map(item=>item.label);
      if(actual.length!==expected.length||expected.some(label=>actual.filter(value=>value===label).length!==1))variantIssues.push(`${kind==='baseline'?'基线':'消融'}标签须完整、精确覆盖方案中的：${expected.join('；')||'无'}。`);
    }
    try{const parsed=parametersFor(variants),seen=new Set<string>();for(const variant of parsed){
      if(!Object.keys(variant.parameters).length)variantIssues.push(`${variant.label||variant.id} 参数尚未填写。`);
      const identity=parameterIdentity(variant.parameters);if(seen.has(identity))variantIssues.push(`${variant.label||variant.id} 参数与其他组相同，请配置实际不同的入口参数。`);seen.add(identity);
    }}catch(reason){variantIssues.push(String(reason));}
  }
  const activeSession=automation?.session&&['queued','running','stopping'].includes(automation.session.status);
  const canStart=ready&&!!plan?.readiness.ready&&!activeSession&&!exceedsBudget&&!invalidSeedCount&&!invalidFirstSeed&&!invalidVariants&&!variantIssues.length&&trialCount>0;
  const campaign=campaigns.find(item=>item.id===selectedId)||campaigns[0];
  const owned=!!campaign&&automation?.session?.id===campaign.sessionId;
  const start=async(event:FormEvent<HTMLFormElement>)=>{
    event.preventDefault();if(lock.current||!plan||!canStart)return;
    let inputVariants:ValidationVariant[];
    try{inputVariants=parametersFor(variants);}catch(reason){setError(String(reason));return;}
    lock.current=true;setBusy(true);setError('');setMessage('');
    let accepted=false;
    try{const result=await startValidationCampaign(projectId,{ideaId,expectedPlanRevision:plan.revision,seeds:parsedSeeds,variants:inputVariants});accepted=true;if(alive.current)setAutomation(result);await refresh(result.session?.id);if(alive.current)setMessage('已启动原自动研究链路中的试验批次；结果以实际 Run 记录为准。');}
    catch(reason){if(alive.current){setReady(false);setError(`${accepted?'启动请求已保存，状态刷新失败；请等候原链路状态刷新':'启动失败，种子和参数草稿已保留'}：${String(reason)}`);}}
    finally{lock.current=false;if(alive.current)setBusy(false);}
  };
  const control=async(action:'stop'|'resume')=>{
    if(lock.current||!campaign||action==='resume'&&terminalCampaign(campaign.status))return;lock.current=true;setBusy(true);setError('');setMessage('');
    try{const current=await automationApi.load(projectId);if(current.session?.id!==campaign.sessionId)throw new Error('当前自动链路已变化，请刷新；不会控制另一条链路。');
      await automationApi.action(projectId,action,{expectedSessionId:campaign.sessionId,...(action==='resume'?{recoverExisting:true}:{})},action==='resume'?workspaceModel():undefined);
      await refresh(campaign.sessionId);if(alive.current)setMessage(action==='stop'?'已向原链路请求停止；进程状态以实际记录为准。':'已请求核对并继续原链路。');}
    catch(reason){if(alive.current)setError(`${action==='stop'?'停止':'继续'}失败：${String(reason)}`);}
    finally{lock.current=false;if(alive.current)setBusy(false);}
  };
  const editVariant=(key:string,patch:Partial<VariantDraft>)=>setVariants(current=>current.map(item=>item.key===key?{...item,...patch}:item));
  return <section className="research-panel validation-campaign" aria-label="创新试验批次">
    <div className="research-panel-heading"><div><span className="research-overline">VALIDATION CAMPAIGN</span><h3>创新试验批次</h3></div><span className="research-status-note">沿用自动研究执行策略</span></div>
    <p className="research-panel-copy">冻结已保存的假设与评价方案，用固定种子运行候选方法、基线和消融。参数需由已有入口读取；分类标签不代表代码已实现这些对照，也不代表创新得到验证。</p>
    {error&&<p role="alert" className="validation-campaign-error">{error}</p>}{message&&<p role="status">{message}</p>}{automation?.session?.message&&['blocked','waiting_confirmation','interrupted'].includes(automation.session.status)&&<p role="alert" className="validation-campaign-error">原自动研究：{automation.session.message}</p>}{loading&&<p role="status">正在读取已保存方案与原执行链路…</p>}
    {!loading&&!candidates.length&&<p className="research-empty-inline">尚无已保存的创新验证方案；请先在创新页编辑并保存。</p>}
    <form onSubmit={event=>void start(event)}><fieldset className="validation-campaign-fields" disabled={busy||!ready}>
      <label className="research-field"><span>已保存的验证方案</span><select aria-label="试验批次方案" value={ideaId} onChange={event=>{const selected=candidates.find(item=>item.ideaId===event.target.value)?.plan;setIdeaId(event.target.value);setSeeds(selected?.evaluation.seed||'');setVariants(selected?variantsFor(selected):defaultVariants());}}><option value="">请选择方案</option>{candidates.map(item=><option key={item.ideaId} value={item.ideaId}>{item.title} · v{item.plan?.revision}{item.plan?.readiness.ready?'':' · 尚有缺口'}</option>)}</select></label>
      <label className="research-field"><span>固定种子（每行或逗号分隔）</span><textarea aria-label="批次固定种子" rows={2} value={seeds} onChange={event=>setSeeds(event.target.value)} placeholder="第一项保留方案种子"/></label>
      {plan&&<div className="validation-campaign-preview"><span>方案 v{plan.revision} · {plan.readiness.ready?'字段已齐备，尚未科学验证':'方案仍有缺口'}</span><span>{parsedSeeds.length} 个种子 × {variants.length} 组参数 = {trialCount} 次试验（最多 20 次）</span><span>预算：最多 {plan.evaluation.budget.maxRuns??'未填写'} 次 / {plan.evaluation.budget.maxSeconds??'未填写'} 秒</span></div>}
      {plan&&!plan.readiness.ready&&<ul className="validation-campaign-error">{plan.readiness.issues.map((issue,index)=><li key={index}>{issue}</li>)}</ul>}
      {plan&&(invalidSeedCount||invalidFirstSeed||exceedsBudget)&&<p className="validation-campaign-error">种子数需等于方案重复次数 {plan.evaluation.repetitions??'未填写'}，第一项须为 {plan.evaluation.seed||'未填写'}；组合次数不能超过方案预算或 20 次。</p>}
      {variantIssues.length>0&&<div className="validation-campaign-error" role="status"><strong>参数组尚未配置完成</strong><ul>{variantIssues.map((issue,index)=><li key={index}>{issue}</li>)}</ul></div>}
      <div className="validation-campaign-variants"><div className="validation-campaign-variant-heading"><strong>候选 / 基线 / 消融参数</strong><button className="research-button research-button-quiet" type="button" disabled={variants.length>=20} onClick={()=>setVariants(current=>[...current,{key:crypto.randomUUID(),id:`ablation-${current.length+1}`,label:'消融条件',kind:'ablation',parameters:'{}'}])}>添加参数组</button></div>
        {variants.map(item=><div className="validation-campaign-variant" key={item.key}>
          <label className="research-field"><span>参数组 ID</span><input value={item.id} maxLength={100} onChange={event=>editVariant(item.key,{id:event.target.value})}/></label>
          <label className="research-field"><span>标签</span><input value={item.label} maxLength={200} onChange={event=>editVariant(item.key,{label:event.target.value})}/></label>
          <label className="research-field"><span>类型</span><select value={item.kind} onChange={event=>editVariant(item.key,{kind:event.target.value as ValidationVariant['kind']})}><option value="candidate">候选方法</option><option value="baseline">基线</option><option value="ablation">消融</option></select></label>
          <label className="research-field"><span>入口读取的参数 · JSON</span><textarea aria-label={`${item.label||item.id}参数JSON`} rows={3} value={item.parameters} onChange={event=>editVariant(item.key,{parameters:event.target.value})}/></label>
          <button className="research-button research-button-quiet" type="button" onClick={()=>setVariants(current=>current.filter(row=>row.key!==item.key))}>删除</button>
        </div>)}
      </div>
    </fieldset><div className="research-panel-footer"><Link to={`/editor/${encodeURIComponent(projectId)}/research/innovation`}>编辑假设与评价方案</Link><span>{activeSession?'原自动链路仍在运行，请先查看或停止。':'总开关与执行环节策略在原自动研究区设置。'}</span><button className="research-button research-button-primary" type="submit" disabled={busy||!canStart}>启动试验批次</button></div></form>
    {campaign&&<div className="validation-campaign-results"><div className="validation-campaign-variant-heading"><label className="research-field"><span>批次记录</span><select value={campaign.id} onChange={event=>setSelectedId(event.target.value)}>{campaigns.map(item=><option key={item.id} value={item.id}>{item.plan.hypothesis.problem||item.ideaId} · v{item.planRevision} · {statusLabels[item.status]||item.status}</option>)}</select></label><span>{statusLabels[campaign.status]||campaign.status}</span></div>
      <p className="research-panel-copy">已记录 {campaign.trials.filter(actualTrial).length} 个实际 Run · 已用 {campaign.elapsedSeconds} 秒 / {campaign.budget.maxSeconds} 秒 · 总预算 {campaign.budget.maxRuns} 次。预留 Run ID 不代表已创建；批次完成仅表示执行结束。</p>
      <div className="validation-campaign-links"><Link to={taskLink(projectId,`experiment-run:${campaign.baseRunId}`)}>固定原实验模板</Link>{owned&&automation?.session?.coordinatorRunId&&<Link to={taskLink(projectId,`harness:${automation.session.coordinatorRunId}`)}>原研究父任务</Link>}<small title={campaign.planSha256}>方案摘要 {campaign.planSha256.slice(0,16)}</small></div>
      {campaign.error?.message&&<p role="alert" className="validation-campaign-error">{campaign.error.message}</p>}
      <div className="validation-campaign-scroll"><table><caption>实际试验记录；指标取自各 Run</caption><thead><tr><th scope="col">参数组 / 种子</th><th scope="col">状态</th><th scope="col">数据 / 代码摘要</th><th scope="col">实际指标</th><th scope="col">Run</th></tr></thead><tbody>{campaign.trials.map(trial=><tr key={trial.id}><th scope="row">{campaign.variants.find(item=>item.id===trial.variantId)?.label||trial.variantId}<small>种子 {trial.seed}</small></th><td>{trial.status==='completed'?'运行完成':statusLabels[trial.status]||trial.status}{trial.result?.errorMessage&&<small className="validation-campaign-error">{trial.result.errorMessage}</small>}</td><td>{trial.result?.dataset?<><span title={trial.result.dataset.id}>{trial.result.dataset.id.length>24?`${trial.result.dataset.id.slice(0,24)}…`:trial.result.dataset.id}</span><small title={trial.result.dataset.version}>数据 {trial.result.dataset.version.slice(0,16)}</small></>:'数据摘要未记录'}<small title={trial.result?.codeSnapshotHash||trial.result?.codeVersion}>代码 {(trial.result?.codeSnapshotHash||trial.result?.codeVersion||'未记录').slice(0,16)}</small></td><td>{trial.result?.metrics?.length?trial.result.metrics.map((metric,index)=><span key={`${metric.name}:${index}`} title={metric.value==null?undefined:String(metric.value)}>{metric.name}：{metric.value==null?'未报告':metricText(metric.value)}{metric.unit?` ${metric.unit}`:''}</span>):'指标未报告'}</td><td>{actualTrial(trial)&&trial.runId?<Link to={taskLink(projectId,`experiment-run:${trial.runId}`)}>查看实际 Run</Link>:'待执行，尚未创建'}</td></tr>)}</tbody></table></div>
      {!owned&&<p className="research-panel-copy">当前自动链路已变化；该批次只读，不会控制另一条链路。</p>}
      {terminalCampaign(campaign.status)&&campaign.status!=='completed'&&<p className="research-panel-copy">该批次已终止，失败或预算记录会保留；请检查材料并另开批次，不能继续派发。</p>}
      <div className="research-panel-footer"><button type="button" className="research-button research-button-quiet" disabled={busy||!owned||automation?.session?.status==='completed'||automation?.session?.status==='stopped'} onClick={()=>void control('stop')}>停止原链路</button><button type="button" className="research-button research-button-secondary" disabled={busy||!owned||!!activeSession||terminalCampaign(campaign.status)||automation?.session?.status==='completed'} onClick={()=>void control('resume')}>核对并继续原链路</button><Link to={`/project/${encodeURIComponent(projectId)}/explore`}>查看原横向执行链路</Link></div>
    </div>}
  </section>;
}
