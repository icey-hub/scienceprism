import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { getValidationCampaigns, startValidationCampaign, startAutomaticValidationCampaign, getValidationCampaignFigures, generateValidationCampaignFigure, type ValidationCampaign, type ValidationVariant, type IdeaPlan, type ValidationCampaignEvaluation, type ValidationCampaignFigure, type ValidationCampaignFigureStyle } from '../../../api/client';
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
const verdictLabels={supported:'固定条件下支持',refuted:'固定条件下反证',insufficient:'证据不足'};
const evaluationNumber=(value:number|null)=>value===null?'未报告':metricText(value);
const knownRun=(id:string|null,status:string)=>!!id&&['awaiting_approval','approved','running','completed','failed','cancelled','rejected'].includes(status);
const figureUrl=(url:string)=>url.startsWith('/api/')?url:undefined;
function CampaignFigures({projectId,campaign}:{projectId:string;campaign:ValidationCampaign}) {
  const comparisons=campaign.evaluation?.summaries.filter(item=>item.comparisonKind==='baseline')||[];
  const comparisonKey=(item:typeof comparisons[number])=>JSON.stringify([item.candidateVariantId,item.comparisonVariantId,item.metricName]);
  const [selection,setSelection]=useState(''),[style,setStyle]=useState<ValidationCampaignFigureStyle>({title:'',xLabel:'',yLabel:'',palette:'blue-orange'});
  const [figures,setFigures]=useState<ValidationCampaignFigure[]>([]),[figureId,setFigureId]=useState(''),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[imageFailed,setImageFailed]=useState(false);
  const mounted=useRef(true),inFlight=useRef(false);
  useEffect(()=>{mounted.current=true;let disposed=false;
    void getValidationCampaignFigures(projectId,campaign.id).then(result=>{if(!disposed){setFigures(result.figures);setError('');}}).catch(reason=>{if(!disposed)setError(`读取图版本失败：${String(reason)}`);}).finally(()=>{if(!disposed)setLoading(false);});
    return()=>{disposed=true;mounted.current=false;};
  },[projectId,campaign.id]);
  const selected=comparisons.find(item=>comparisonKey(item)===selection);
  const figure=figures.find(item=>item.id===figureId)||figures[0];
  useEffect(()=>setImageFailed(false),[figure?.id]);
  const complete=!!selected&&selected.completeSeeds===selected.expectedSeeds.length&&selected.expectedSeeds.length>0&&selected.candidateMean!==null&&selected.comparisonMean!==null&&!selected.issues.length;
  const choose=(key:string)=>{setSelection(key);const item=comparisons.find(value=>comparisonKey(value)===key);if(item)setStyle(current=>({...current,title:`${item.metricName}: ${item.candidateLabel} vs ${item.comparisonLabel}`.slice(0,120),xLabel:'Method',yLabel:item.metricName.slice(0,120)}));};
  const generate=async(event:FormEvent)=>{event.preventDefault();if(inFlight.current||loading||!selected||!complete)return;inFlight.current=true;setBusy(true);setError('');setNotice('');
    try{const result=await generateValidationCampaignFigure(projectId,campaign.id,{candidateVariantId:selected.candidateVariantId,comparisonVariantId:selected.comparisonVariantId,metricName:selected.metricName,style});if(mounted.current){setFigures(current=>[result.figure,...current.filter(item=>item.id!==result.figure.id)]);setFigureId(result.figure.id);setNotice('论文图已就绪，下方预览与下载对应保存的真实产物。');}}
    catch(reason){if(mounted.current)setError(`生成论文图失败：${String(reason)}`);}
    finally{inFlight.current=false;if(mounted.current)setBusy(false);}
  };
  return <section className="validation-figures" aria-label="真实结果论文图">
    <div className="validation-evaluation-heading"><h4>真实结果 → 论文图</h4><Link to={`/project/${encodeURIComponent(projectId)}/lab/figures${figure?`?figure=${encodeURIComponent(figure.id)}`:''}`}>在科研图工作区打开 ↗</Link></div>
    <p className="research-panel-copy">选择实测指标生成配对图，可调整标题、坐标名和配色，并导出矢量文件。</p>
    <form onSubmit={event=>void generate(event)}><fieldset className="validation-figure-controls" disabled={busy}>
      <label className="research-field validation-figure-selection"><span>实测对比 / 指标</span><select value={selection} onChange={event=>choose(event.target.value)}><option value="">请选择实际基线比较</option>{comparisons.map(item=><option key={comparisonKey(item)} value={comparisonKey(item)}>{item.metricName} · {item.candidateLabel} / {item.comparisonLabel} · {item.completeSeeds}/{item.expectedSeeds.length} 配对</option>)}</select></label>
      <label className="research-field"><span>图标题</span><input value={style.title} maxLength={120} onChange={event=>setStyle(current=>({...current,title:event.target.value}))}/></label>
      <label className="research-field"><span>横轴标签</span><input value={style.xLabel} maxLength={120} onChange={event=>setStyle(current=>({...current,xLabel:event.target.value}))}/></label>
      <label className="research-field"><span>纵轴标签</span><input value={style.yLabel} maxLength={120} onChange={event=>setStyle(current=>({...current,yLabel:event.target.value}))}/></label>
      <label className="research-field"><span>固定配色</span><select value={style.palette} onChange={event=>setStyle(current=>({...current,palette:event.target.value as ValidationCampaignFigureStyle['palette']}))}><option value="blue-orange">蓝 / 橙</option><option value="purple-green">紫 / 绿</option><option value="grayscale">灰阶</option></select></label>
    </fieldset><div className="validation-figure-action"><span>{selected&&!complete?'该比较仍有失败、缺失或未完成数据，不能删减种子后生成。':'调整样式会保存新版本，原图仍可下载。'}</span><button className="research-button research-button-secondary" type="submit" disabled={busy||loading||!complete}>{busy?'正在生成真实图…':'生成论文图'}</button></div></form>
    {error&&<p role="alert" className="validation-campaign-error">{error} {figures.length>0&&'已有图版本保留。'}</p>}{notice&&<p role="status" className="research-panel-copy">{notice}</p>}{loading&&<p role="status" className="research-panel-copy">正在读取已生成图版本…</p>}
    {figure&&<div className="validation-figure-output"><div className="validation-figure-preview">{figureUrl(figure.files.png.url)&&!imageFailed?<img src={figureUrl(figure.files.png.url)} alt={figure.style.title||`${figure.metricName} 候选与基线逐种子实测配对图`} onError={()=>setImageFailed(true)}/>:<p role="alert">真实 PNG 预览无法读取，请尝试下载或刷新页面。</p>}</div><div className="validation-figure-metadata">
      <label className="research-field"><span>已生成版本（{figures.length}）</span><select value={figure.id} onChange={event=>setFigureId(event.target.value)}>{figures.map(item=><option key={item.id} value={item.id}>{item.style.title||item.metricName} · {new Date(item.createdAt).toLocaleString('zh-CN')}</option>)}</select></label>
      <p><strong>n = {figure.statistics.n} 个配对种子</strong><br/>单位：{figure.statistics.unit||'未声明单位'} · 不绘制误差条</p>
      <div className="validation-figure-downloads">{(['svg','pdf','png','source'] as const).map(format=>figureUrl(figure.files[format].url)&&<a key={format} href={figureUrl(figure.files[format].url)} download>{format==='source'?'数据 JSON':format.toUpperCase()}</a>)}</div>
      <p className="research-panel-copy">图对应生成时冻结的 Run 指标与方案条件；配对连线不表示统计显著性。</p>
      <details className="validation-evaluation-details"><summary>查看种子与可复核来源</summary><p className="validation-figure-caption">{figure.statistics.caption}</p><p>种子：{figure.statistics.seeds.join('、')}</p><p>渲染：{figure.renderer.name} · Python {figure.renderer.pythonVersion} · Matplotlib {figure.renderer.matplotlibVersion}</p>
        <div className="validation-campaign-links">{campaign.evaluation?.rows.filter(row=>row.candidateVariantId===figure.candidateVariantId&&row.comparisonVariantId===figure.comparisonVariantId&&row.metricName===figure.metricName).map(row=><span key={row.seed}>种子 {row.seed}：{knownRun(row.candidateRunId,row.candidateStatus)&&<Link to={taskLink(projectId,`experiment-run:${row.candidateRunId}`)}>候选 Run</Link>} / {knownRun(row.comparisonRunId,row.comparisonStatus)&&<Link to={taskLink(projectId,`experiment-run:${row.comparisonRunId}`)}>基线 Run</Link>}</span>)}</div>
        {figureUrl(figure.files.rendererSource.url)&&<a href={figureUrl(figure.files.rendererSource.url)} download>下载固定绘图源码</a>}
      </details>
    </div></div>}
    {!loading&&!figure&&!error&&<p className="research-empty-inline">尚未生成论文图；选择完整的实际比较即可导出。</p>}
  </section>;
}
function CampaignEvaluation({projectId,value}:{projectId:string;value:ValidationCampaignEvaluation}) {
  return <section className="validation-evaluation" aria-label="创新固定条件评价">
    <div className="validation-evaluation-heading"><h4>固定条件下的验证结果</h4><strong className={`validation-verdict is-${value.verdict}`}>{verdictLabels[value.verdict]}</strong></div>
    <p>按冻结方案 v{value.planRevision} 的全部预定种子配对均值判断。基线对照：支持 {value.counts.supported} 项、反证 {value.counts.refuted} 项、证据不足 {value.counts.insufficient} 项；消融单独展示，不替代基线。</p>
    <div className="validation-campaign-scroll"><table><caption>各组与指标的配对均值；阈值在运行前固定</caption><thead><tr><th scope="col">候选 / 对照</th><th scope="col">指标 / 配对种子</th><th scope="col">候选均值</th><th scope="col">对照均值</th><th scope="col">平均改善</th><th scope="col">固定判据</th><th scope="col">结果</th></tr></thead><tbody>{value.summaries.map(summary=><tr key={`${summary.candidateVariantId}:${summary.comparisonVariantId}:${summary.metricName}`}>
      <th scope="row">{summary.candidateLabel}<small>对照 {summary.comparisonLabel} · {summary.comparisonKind==='baseline'?'基线':'消融'}</small></th><td>{summary.metricName}<small>{summary.completeSeeds} / {summary.expectedSeeds.length} 个完整配对</small></td>
      <td title={summary.candidateMean===null?undefined:String(summary.candidateMean)}>{evaluationNumber(summary.candidateMean)}</td><td title={summary.comparisonMean===null?undefined:String(summary.comparisonMean)}>{evaluationNumber(summary.comparisonMean)}</td><td title={summary.meanImprovement===null?undefined:String(summary.meanImprovement)}>{evaluationNumber(summary.meanImprovement)}</td>
      <td>{summary.threshold===null?'阈值未填写':summary.direction==='target'?`候选均值 = ${metricText(summary.threshold)}`:`${summary.direction==='increase'?'增加':'减少'}改善 ≥ ${metricText(summary.threshold)}`}</td>
      <td><strong className={`validation-verdict is-${summary.verdict}`}>{verdictLabels[summary.verdict]}</strong>{summary.issues.length>0&&<details><summary>查看缺口</summary><ul>{summary.issues.map((issue,index)=><li key={index}>{issue}</li>)}</ul></details>}</td>
    </tr>)}</tbody></table></div>
    {!value.summaries.length&&<p>尚无完整的冻结对照条件或实际指标，不能作出支持判断。</p>}
    <p className="validation-evaluation-limit">这里只判断本批固定条件，不声明统计显著性，也不证明方法具有普适创新性。负结果、失败和缺失数据均保留。</p>
    <details className="validation-evaluation-details"><summary>查看逐个种子的实际配对与 Run 来源（{value.rows.length} 条）</summary><div className="validation-campaign-scroll"><table><caption>逐种子只展示数据与缺口，最终判断使用全部种子的配对均值</caption><thead><tr><th scope="col">对照 / 指标 / 种子</th><th scope="col">候选实测</th><th scope="col">对照实测</th><th scope="col">实际差值</th><th scope="col">数据状态</th><th scope="col">实际 Run</th></tr></thead><tbody>{value.rows.map(row=><tr key={`${row.candidateVariantId}:${row.comparisonVariantId}:${row.metricName}:${row.seed}`}>
      <th scope="row">{value.summaries.find(summary=>summary.comparisonVariantId===row.comparisonVariantId)?.comparisonLabel||row.comparisonVariantId}<small>{row.metricName} · 种子 {row.seed}</small></th>
      <td title={row.candidateValue===null?undefined:String(row.candidateValue)}>{evaluationNumber(row.candidateValue)}{row.unit&&<small>{row.unit}</small>}<small>候选：{row.candidateStatus==='completed'?'运行完成':statusLabels[row.candidateStatus]||row.candidateStatus}</small></td>
      <td title={row.comparisonValue===null?undefined:String(row.comparisonValue)}>{evaluationNumber(row.comparisonValue)}<small>对照：{row.comparisonStatus==='completed'?'运行完成':statusLabels[row.comparisonStatus]||row.comparisonStatus}</small></td>
      <td title={row.delta===null?undefined:String(row.delta)}>{evaluationNumber(row.delta)}</td><td>{row.dataStatus==='complete'?'配对数据完整':'配对数据不足'}{row.issues.length>0&&<ul>{row.issues.map((issue,index)=><li key={index}>{issue}</li>)}</ul>}</td>
      <td>{knownRun(row.candidateRunId,row.candidateStatus)&&<Link to={taskLink(projectId,`experiment-run:${row.candidateRunId}`)}>候选 Run</Link>}{knownRun(row.comparisonRunId,row.comparisonStatus)&&<Link to={taskLink(projectId,`experiment-run:${row.comparisonRunId}`)}>对照 Run</Link>}
        {!knownRun(row.candidateRunId,row.candidateStatus)&&!knownRun(row.comparisonRunId,row.comparisonStatus)&&<span>尚无可读取的实际 Run</span>}
        {row.sourceArtifacts.length>0&&<details><summary>归档来源</summary><ul>{row.sourceArtifacts.map(artifact=><li key={`${artifact.runId}:${artifact.id}`}><Link to={`${taskLink(projectId,`experiment-run:${artifact.runId}`)}?tab=artifacts`}>原 Run 产物</Link><small>{artifact.path}</small></li>)}</ul></details>}
      </td>
    </tr>)}</tbody></table></div></details>
    <details className="validation-evaluation-details"><summary>查看固定判定规则与局限</summary><p>增加 / 减少：全部预定种子的平均改善至少达到阈值。目标值：候选均值严格等于预设阈值。缺少配对、失败、未完成或条件不齐时保留为证据不足。</p><ul>{value.limitations.map((limitation,index)=><li key={index}>{limitation}</li>)}</ul></details>
  </section>;
}
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
  const awaitingCampaign=useRef<string|null>(null);
  const refresh=async(preferredSessionId?:string)=>{
    const [listed,state]=await Promise.all([getValidationCampaigns(projectId),automationApi.load(projectId)]);
    if(alive.current){setCampaigns(listed.campaigns);setCandidates((listed.candidates||[]).filter(item=>item.plan));setAutomation(state);setReady(true);
      const preferred=preferredSessionId||awaitingCampaign.current;if(preferred){const match=listed.campaigns.find(item=>item.sessionId===preferred);if(match){setSelectedId(match.id);awaitingCampaign.current=null;}}}
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
  const canStartAutomatic=ready&&!!plan?.readiness.ready&&plan.evaluation.researchType!=='theoretical'&&!activeSession;
  const campaign=campaigns.find(item=>item.id===selectedId)||campaigns[0];
  const owned=!!campaign&&automation?.session?.id===campaign.sessionId;
  const experimentStep=automation?.session?.steps.find(step=>step.stage==='experiment');
  const design=experimentStep?.validationDesign;
  const featureSession=automation?.session&&(automation.session.validationCampaignDesign||automation.session.validationCampaign||design)?automation.session:null;
  const preparingSession=featureSession&&!campaigns.some(item=>item.sessionId===featureSession.id)?featureSession:null;
  const start=async(event:FormEvent<HTMLFormElement>)=>{
    event.preventDefault();if(lock.current||!plan||!canStart)return;
    let inputVariants:ValidationVariant[];
    try{inputVariants=parametersFor(variants);}catch(reason){setError(String(reason));return;}
    lock.current=true;setBusy(true);setError('');setMessage('');
    let accepted=false;
    try{const result=await startValidationCampaign(projectId,{ideaId,expectedPlanRevision:plan.revision,seeds:parsedSeeds,variants:inputVariants});accepted=true;awaitingCampaign.current=result.session?.id||null;if(alive.current)setAutomation(result);await refresh(result.session?.id);if(alive.current)setMessage('已启动原自动研究链路中的手动配置批次；结果以实际 Run 记录为准。');}
    catch(reason){if(alive.current){setReady(false);setError(`${accepted?'启动请求已保存，状态刷新失败；请等候原链路状态刷新':'启动失败，种子和参数草稿已保留'}：${String(reason)}`);}}
    finally{lock.current=false;if(alive.current)setBusy(false);}
  };
  const startAutomatic=async()=>{
    if(lock.current||!plan||!canStartAutomatic)return;lock.current=true;setBusy(true);setError('');setMessage('');let accepted=false;
    try{const result=await startAutomaticValidationCampaign(projectId,{ideaId,expectedPlanRevision:plan.revision});accepted=true;awaitingCampaign.current=result.session?.id||null;if(alive.current)setAutomation(result);await refresh(result.session?.id);if(alive.current)setMessage('原研究链路已接收 AI 设计请求；条件设计、代码与环境准备完成后才会运行实际批次。手动参数草稿已保留。');}
    catch(reason){if(alive.current){setReady(false);setError(`${accepted?'AI 请求已保存，状态刷新失败；等待原会话状态刷新':'AI 设计请求失败，手动配置草稿已保留'}：${String(reason)}`);}}
    finally{lock.current=false;if(alive.current)setBusy(false);}
  };
  const control=async(action:'stop'|'resume',sessionId=campaign?.sessionId)=>{
    if(lock.current||!sessionId||action==='resume'&&campaign?.sessionId===sessionId&&terminalCampaign(campaign.status))return;lock.current=true;setBusy(true);setError('');setMessage('');
    try{const current=await automationApi.load(projectId);if(current.session?.id!==sessionId)throw new Error('当前自动链路已变化，请刷新；不会控制另一条链路。');
      const currentStep=current.session.steps.find(step=>step.stage==='experiment');
      if(!current.session.validationCampaignDesign&&!current.session.validationCampaign&&!currentStep?.validationDesign)throw new Error('当前会话不属于创新试验批次，不能控制。');
      await automationApi.action(projectId,action,{expectedSessionId:sessionId,...(action==='resume'?{recoverExisting:true}:{})},action==='resume'?workspaceModel():undefined);
      await refresh(sessionId);if(alive.current)setMessage(action==='stop'?'已向原链路请求停止；进程状态以实际记录为准。':'已请求核对并继续原链路。');}
    catch(reason){if(alive.current)setError(`${action==='stop'?'停止':'继续'}失败：${String(reason)}`);}
    finally{lock.current=false;if(alive.current)setBusy(false);}
  };
  const editVariant=(key:string,patch:Partial<VariantDraft>)=>setVariants(current=>current.map(item=>item.key===key?{...item,...patch}:item));
  const manualConfiguration=<details className="validation-campaign-manual"><summary>手动配置种子与参数（可选）</summary>
    <form onSubmit={event=>void start(event)}><fieldset className="validation-campaign-fields" disabled={busy||!ready}>
      <label className="research-field"><span>固定种子（每行或逗号分隔）</span><textarea aria-label="批次固定种子" rows={2} value={seeds} onChange={event=>setSeeds(event.target.value)} placeholder="第一项保留方案种子"/></label>
      {plan&&<div className="validation-campaign-preview"><span>手动预览：{parsedSeeds.length} 个种子 × {variants.length} 组参数 = {trialCount} 次试验（最多 20 次）</span></div>}
      {plan&&(invalidSeedCount||invalidFirstSeed||exceedsBudget)&&<p className="validation-campaign-error">种子数需等于方案重复次数 {plan.evaluation.repetitions??'未填写'}，第一项须为 {plan.evaluation.seed||'未填写'}；组合次数不能超过方案预算或 20 次。</p>}
      {variantIssues.length>0&&<div className="validation-campaign-error" role="status"><strong>手动参数组尚未配置完成</strong><ul>{variantIssues.map((issue,index)=><li key={index}>{issue}</li>)}</ul></div>}
      <div className="validation-campaign-variants"><div className="validation-campaign-variant-heading"><strong>候选 / 基线 / 消融参数</strong><button className="research-button research-button-quiet" type="button" disabled={variants.length>=20} onClick={()=>setVariants(current=>[...current,{key:crypto.randomUUID(),id:`ablation-${current.length+1}`,label:'消融条件',kind:'ablation',parameters:'{}'}])}>添加参数组</button></div>
        {variants.map(item=><div className="validation-campaign-variant" key={item.key}>
          <label className="research-field"><span>参数组 ID</span><input value={item.id} maxLength={100} onChange={event=>editVariant(item.key,{id:event.target.value})}/></label>
          <label className="research-field"><span>标签</span><input value={item.label} maxLength={200} onChange={event=>editVariant(item.key,{label:event.target.value})}/></label>
          <label className="research-field"><span>类型</span><select value={item.kind} onChange={event=>editVariant(item.key,{kind:event.target.value as ValidationVariant['kind']})}><option value="candidate">候选方法</option><option value="baseline">基线</option><option value="ablation">消融</option></select></label>
          <label className="research-field"><span>入口读取的参数 · JSON</span><textarea aria-label={`${item.label||item.id}参数JSON`} rows={3} value={item.parameters} onChange={event=>editVariant(item.key,{parameters:event.target.value})}/></label>
          <button className="research-button research-button-quiet" type="button" onClick={()=>setVariants(current=>current.filter(row=>row.key!==item.key))}>删除</button>
        </div>)}
      </div>
    </fieldset><div className="research-panel-footer"><span>手动启动仅运行填写的种子和参数；授权仍取自原自动研究区。</span><button className="research-button research-button-secondary" type="submit" disabled={busy||!canStart}>按手动配置运行</button></div></form>
  </details>;
  return <section className="research-panel validation-campaign" aria-label="创新试验批次">
    <div className="research-panel-heading"><div><span className="research-overline">VALIDATION CAMPAIGN</span><h3>创新试验批次</h3></div><span className="research-status-note">沿用自动研究执行策略</span></div>
    <p className="research-panel-copy">冻结已保存的假设与评价方案，用固定种子运行候选方法、基线和消融。参数需由已有入口读取；分类标签不代表代码已实现这些对照，也不代表创新得到验证。</p>
    {error&&<p role="alert" className="validation-campaign-error">{error}</p>}{message&&<p role="status">{message}</p>}{featureSession?.message&&['blocked','waiting_confirmation','interrupted'].includes(featureSession.status)&&<p role="alert" className="validation-campaign-error">原自动研究：{featureSession.message}</p>}{loading&&<p role="status">正在读取已保存方案与原执行链路…</p>}
    {!loading&&!candidates.length&&<p className="research-empty-inline">尚无已保存的创新验证方案；请先在创新页编辑并保存。</p>}
    <fieldset className="validation-campaign-fields" disabled={busy||!ready}>
      <label className="research-field"><span>已保存的验证方案</span><select aria-label="试验批次方案" value={ideaId} onChange={event=>{const selected=candidates.find(item=>item.ideaId===event.target.value)?.plan;setIdeaId(event.target.value);setSeeds(selected?.evaluation.seed||'');setVariants(selected?variantsFor(selected):defaultVariants());}}><option value="">请选择方案</option>{candidates.map(item=><option key={item.ideaId} value={item.ideaId}>{item.title} · v{item.plan?.revision}{item.plan?.readiness.ready?'':' · 尚有缺口'}</option>)}</select></label>
      <div className="validation-campaign-ai"><p>AI 从已保存方案设计种子与对照参数，沿原代码、环境和执行授权准备材料；下方手动参数不会被覆盖。理论研究暂不启动受控实验。</p><button className="research-button research-button-primary" type="button" disabled={busy||!canStartAutomatic} onClick={()=>void startAutomatic()}>AI 设计并运行</button></div>
      {plan&&<div className="validation-campaign-preview"><span>方案 v{plan.revision} · {plan.readiness.ready?'字段已齐备，尚未科学验证':'方案仍有缺口'}</span><span>固定预算：最多 {plan.evaluation.budget.maxRuns??'未填写'} 次 / {plan.evaluation.budget.maxSeconds??'未填写'} 秒</span></div>}
      {plan&&!plan.readiness.ready&&<ul className="validation-campaign-error">{plan.readiness.issues.map((issue,index)=><li key={index}>{issue}</li>)}</ul>}
    </fieldset><div className="research-panel-footer"><Link to={`/editor/${encodeURIComponent(projectId)}/research/innovation`}>编辑假设与评价方案</Link><span>{activeSession?'原自动链路仍在运行，请查看下方准备状态或实际结果。':'AI 入口沿用原自动研究区的授权。'}</span></div>
    {(preparingSession||design)&&<div className="validation-campaign-design"><div className="validation-campaign-variant-heading"><strong>{preparingSession?'原会话正在准备创新试验':'已记录的 AI 条件设计'}</strong><span>{preparingSession?statusLabels[preparingSession.status]||preparingSession.status:'设计材料记录，非实验结果'}</span></div>
      <div className="validation-campaign-links">{featureSession?.coordinatorRunId&&<Link to={taskLink(projectId,`harness:${featureSession.coordinatorRunId}`)}>原研究父任务</Link>}{design?.sourceRunId&&<Link to={taskLink(projectId,`harness:${design.sourceRunId}`)}>真实条件设计 Run</Link>}<Link to={`/project/${encodeURIComponent(projectId)}/explore#research-automation`}>查看原策略与横向链路</Link></div>
      {!design&&<p className="research-panel-copy">条件设计或材料准备尚未完成。当前还没有实际试验批次，不能视为实验已完成。</p>}
      {design&&<><p className="research-panel-copy">方案 v{design.expectedPlanRevision} · 种子 {design.seeds.join('、')||'尚未给出'} · 材料摘要 {design.planSha256.slice(0,16)}</p>
        <ul className="validation-campaign-design-conditions">{design.variants.map(variant=><li key={variant.id}><strong>{variant.label}</strong> · {variant.kind}<code>{JSON.stringify(variant.parameters)}</code></li>)}</ul>
        <details className="validation-campaign-implementation"><summary>查看实现说明</summary>{Array.isArray(design.implementationNotes)?<ol>{design.implementationNotes.map((note,index)=><li key={index}>{note}</li>)}</ol>:<p className="research-panel-copy">{design.implementationNotes||'尚未记录实现说明'}</p>}</details>
        {design.blockers.length>0&&<div className="validation-campaign-error"><strong>材料缺口</strong><ul>{design.blockers.map((blocker,index)=><li key={index}>{typeof blocker==='string'?blocker:blocker.detail||blocker.message||'缺口尚未说明'}</li>)}</ul></div>}
      </>}
      {!!experimentStep?.codePreparations?.length&&<p className="research-panel-copy">已保留代码准备任务；固定代码准备与工程检查均不代表实际批次已完成。</p>}
      {preparingSession&&<div className="research-panel-footer"><button className="research-button research-button-quiet" type="button" disabled={busy||['completed','stopped','stopping'].includes(preparingSession.status)} onClick={()=>void control('stop',preparingSession.id)}>停止原准备会话</button><button className="research-button research-button-secondary" type="button" disabled={busy||!!activeSession||preparingSession.status==='completed'} onClick={()=>void control('resume',preparingSession.id)}>核对并继续原准备会话</button><Link to={`/project/${encodeURIComponent(projectId)}/tasks`}>查看原任务与会话</Link></div>}
    </div>}
    {campaign&&<div className="validation-campaign-results"><div className="validation-campaign-variant-heading"><label className="research-field"><span>批次记录</span><select value={campaign.id} onChange={event=>setSelectedId(event.target.value)}>{campaigns.map(item=><option key={item.id} value={item.id}>{item.plan.hypothesis.problem||item.ideaId} · v{item.planRevision} · {statusLabels[item.status]||item.status}</option>)}</select></label><span>{statusLabels[campaign.status]||campaign.status}</span></div>
      <p className="research-panel-copy">已记录 {campaign.trials.filter(actualTrial).length} 个实际 Run · 已用 {metricText(campaign.elapsedSeconds)} 秒 / {campaign.budget.maxSeconds} 秒 · 总预算 {campaign.budget.maxRuns} 次。预留 Run ID 不代表已创建；批次完成仅表示执行结束。</p>
      <div className="validation-campaign-links"><Link to={taskLink(projectId,`experiment-run:${campaign.baseRunId}`)}>固定原实验模板</Link>{owned&&automation?.session?.coordinatorRunId&&<Link to={taskLink(projectId,`harness:${automation.session.coordinatorRunId}`)}>原研究父任务</Link>}<small title={campaign.planSha256}>方案摘要 {campaign.planSha256.slice(0,16)}</small></div>
      {campaign.error?.message&&<p role="alert" className="validation-campaign-error">{campaign.error.message}</p>}
      {campaign.evaluation?<CampaignEvaluation projectId={projectId} value={campaign.evaluation}/>:<p className="research-panel-copy">固定条件评价尚未生成；保留实际执行记录，不提前判断假设得到支持。</p>}
      <CampaignFigures key={campaign.id} projectId={projectId} campaign={campaign}/>
      <details className="validation-evaluation-details"><summary>查看全部实际试验记录（{campaign.trials.filter(actualTrial).length} 个 Run）</summary><div className="validation-campaign-scroll"><table><caption>实际试验记录；指标取自各 Run</caption><thead><tr><th scope="col">参数组 / 种子</th><th scope="col">状态</th><th scope="col">数据 / 代码摘要</th><th scope="col">实际指标</th><th scope="col">Run</th></tr></thead><tbody>{campaign.trials.map(trial=><tr key={trial.id}><th scope="row">{campaign.variants.find(item=>item.id===trial.variantId)?.label||trial.variantId}<small>种子 {trial.seed}</small></th><td>{trial.status==='completed'?'运行完成':statusLabels[trial.status]||trial.status}{trial.result?.errorMessage&&<small className="validation-campaign-error">{trial.result.errorMessage}</small>}</td><td>{trial.result?.dataset?<><span title={trial.result.dataset.id}>{trial.result.dataset.id.length>24?`${trial.result.dataset.id.slice(0,24)}…`:trial.result.dataset.id}</span><small title={trial.result.dataset.version}>数据 {trial.result.dataset.version.slice(0,16)}</small></>:'数据摘要未记录'}<small title={trial.result?.codeSnapshotHash||trial.result?.codeVersion}>代码 {(trial.result?.codeSnapshotHash||trial.result?.codeVersion||'未记录').slice(0,16)}</small></td><td>{trial.result?.metrics?.length?trial.result.metrics.map((metric,index)=><span key={`${metric.name}:${index}`} title={metric.value==null?undefined:String(metric.value)}>{metric.name}：{metric.value==null?'未报告':metricText(metric.value)}{metric.unit?` ${metric.unit}`:''}</span>):'指标未报告'}</td><td>{actualTrial(trial)&&trial.runId?<Link to={taskLink(projectId,`experiment-run:${trial.runId}`)}>查看实际 Run</Link>:'待执行，尚未创建'}</td></tr>)}</tbody></table></div></details>
      {!owned&&<p className="research-panel-copy">当前自动链路已变化；该批次只读，不会控制另一条链路。</p>}
      {terminalCampaign(campaign.status)&&campaign.status!=='completed'&&<p className="research-panel-copy">该批次已终止，失败或预算记录会保留；请检查材料并另开批次，不能继续派发。</p>}
      <div className="research-panel-footer"><button type="button" className="research-button research-button-quiet" disabled={busy||!owned||automation?.session?.status==='completed'||automation?.session?.status==='stopped'} onClick={()=>void control('stop')}>停止原链路</button><button type="button" className="research-button research-button-secondary" disabled={busy||!owned||!!activeSession||terminalCampaign(campaign.status)||automation?.session?.status==='completed'} onClick={()=>void control('resume')}>核对并继续原链路</button><Link to={`/project/${encodeURIComponent(projectId)}/explore`}>查看原横向执行链路</Link></div>
    </div>}
    {manualConfiguration}
  </section>;
}
