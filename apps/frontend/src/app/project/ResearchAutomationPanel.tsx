import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { automationApi, type AutomationState, type AutomationPolicy, type ConfirmationMode } from '../../api/automationAdapter';
import { workspaceModel } from '../workspace/workspaceModel';
import { taskHref } from './taskLocation';
import './ResearchAutomationPanel.css';

const STAGES: [string, string][] = [['direction','方向'],['search','检索'],['selection','筛选'],['replication','复现'],['ideation','不足与创新'],['method','方法'],['experiment','实验'],['writing','写作交接']];
const labels: Record<string,string> = {pending:'待开始',queued:'排队中',running:'运行中',preparing:'Agent分析中',recovering:'核对原任务中',awaiting_confirmation:'待确认',approved:'已决定',awaiting_execution:'待执行授权',executing:'实验运行中',completed:'完成',stopping:'正在停止',stopped:'已停止',blocked:'需要处理',waiting_confirmation:'等待确认',interrupted:'执行中断',failed:'失败'};
const href = (projectId: string, stage: string) => `/editor/${projectId}/research/${stage === 'ideation' ? 'innovation' : stage}`;

function ConfirmationControl({part,label,mode,disabled,onChange}:{part:string;label:string;mode:ConfirmationMode;disabled:boolean;onChange:(part:string,mode:ConfirmationMode)=>void}) {
  return <div className="confirmation-control" role="group" aria-label={label}>{([['inherit','跟随'],['auto','自动'],['manual','人工']] as const).map(([value,text])=><button key={value} type="button" data-mode={value} aria-pressed={mode===value} title={value==='inherit'?'跟随总开关':value==='auto'?'自动继续':'人工确认'} disabled={disabled} onClick={()=>onChange(part,value)}>{text}</button>)}</div>;
}

export function ResearchAutomationPanel({projectId, expanded = false}:{projectId:string; expanded?:boolean}) {
  return <ProjectAutomation key={projectId} projectId={projectId} expanded={expanded}/>;
}

function ProjectAutomation({projectId, expanded}:{projectId:string;expanded:boolean}) {
  const [state,setState] = useState<AutomationState|null>(null), [error,setError] = useState(''), [busy,setBusy] = useState(false);
  const [question,setQuestion] = useState(''), [target,setTarget] = useState('ideation'), [skip,setSkip] = useState(false);
  const [entry,setEntry] = useState(''), [dataset,setDataset] = useState(''), [version,setVersion] = useState('');
  const alive = useRef(true), lock = useRef(false), revision = useRef(0);
  useEffect(() => {
    alive.current = true; let disposed = false, timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      const captured = revision.current;
      try { const result = await automationApi.load(projectId); if (!disposed && captured === revision.current) setState(result); }
      catch (error) { if (!disposed) setError(String(error)); }
      finally { if (!disposed) timer = setTimeout(load, 2500); }
    };
    void load(); return () => { disposed = true; alive.current = false; clearTimeout(timer); };
  },[projectId]);
  useEffect(() => {
    const plan = state?.session?.executionPlan;
    if (state?.session) { setEntry(plan?.execution.entrypoint || ''); setDataset(plan?.dataset || ''); setVersion(plan?.datasetVersion || ''); }
  }, [state?.session?.id, state?.session?.executionPlanSha256]);
  const perform = async (operation: () => Promise<unknown>) => {
    if (lock.current) return;
    lock.current = true; revision.current++; setBusy(true); setError('');
    try { await operation(); const result = await automationApi.load(projectId); if (alive.current) setState(result); }
    catch(error) { if (alive.current) setError(String(error)); }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  };
  const save = (policy: AutomationPolicy) => state && void perform(() => automationApi.save(projectId, policy, state.version));
  const override = (part: string, mode: ConfirmationMode) => state && save({...state.policy, overrides:{...state.policy.overrides,[part]:mode}});
  const active = state?.session && ['queued','running','stopping'].includes(state.session.status);
  const materials = () => entry && dataset && version ? {executionPlan:{protocol:'执行项目内论文实验，记录结果与不足。',seed:0,successCriteria:['记录实际输出，不预设成功'],artifacts:[{path:'results/metrics.json',kind:'metric'}],...state?.session?.executionPlan,dataset,datasetVersion:version,execution:{adapter:entry.endsWith('.py')?'python':'node',entrypoint:entry,args:state?.session?.executionPlan?.execution.args || []}}} : {};
  const newStart = !state?.session || ['completed','stopped'].includes(state.session.status);
  const planLocked = !newStart && state?.session?.executionPlanLocked === true;
  const supplement = () => state?.session && void perform(() => automationApi.action(projectId,'resume',{...materials(),expectedSessionId:state.session?.id,expectedExecutionPlanVersion:state.session?.executionPlanVersion ?? 0,recoverExisting:['interrupted','blocked'].includes(state.session?.status||'')},workspaceModel()));
  const start = () => void perform(() => automationApi.action(projectId,'start',{question,targetStage:target,skipReplication:skip,...materials()},workspaceModel()));
  return <details className="research-automation" open={expanded || undefined}>
    <summary><strong>自动研究</strong><span>{state?.policy.enabled?'默认自动继续':'默认人工确认'}{state?.session ? ` · ${labels[state.session.status]||state.session.status}` : ''}</span></summary>
    <div className="automation-body">
      {error && <p role="alert">{error}</p>}
      {!state ? <p>正在读取执行策略…</p> : <>
        <div className="automation-default"><div><h3>让 AI 连续推进研究</h3><p>总开关设置默认行为，每个环节可单独选择。保存策略后，点击开始研究。</p></div><label><input aria-label="自动研究总开关" role="switch" type="checkbox" checked={state.policy.enabled} disabled={busy} onChange={event=>save({...state.policy,enabled:event.target.checked})}/>{state.policy.enabled?'已开启':'已关闭'}</label></div>
        <div className="automation-controls"><label>Agent 分工<select aria-label="Agent分工" value={state.policy.agentMode} disabled={busy} onChange={event=>save({...state.policy,agentMode:event.target.value as AutomationPolicy['agentMode']})}><option value="specialists">阶段专家接力</option><option value="generalist">通用研究助手</option></select></label><Link to={`/project/${projectId}/agents`}>查看 Agent 设计</Link></div>
        <div className="automation-stages">{STAGES.map(([stage,label])=>{const step=state.session?.steps.find(step=>step.stage===stage), specialist=state.agents.find(agent=>agent.stage===stage);return <div className="automation-stage" key={stage}><div><Link to={href(projectId,stage)}>{label}</Link><small title={specialist?.purpose}>{state.policy.agentMode==='specialists'?(specialist?.label||'研究者提供问题'):'研究助手'}</small></div><ConfirmationControl part={stage} label={`${label}确认模式`} disabled={busy} mode={state.policy.overrides[stage]||'inherit'} onChange={override}/>{step && <span className={`automation-step is-${step.status}`}>{labels[step.status]||step.status}</span>}</div>;})}</div>
        <div className="automation-controls">{[['execution','实验运行确认'],['patches','文稿修改确认']].map(([part,label])=><div className="automation-confirmation" key={part}><span>{label}</span><ConfirmationControl part={part} label={label} disabled={busy} mode={state.policy.overrides[part]||'inherit'} onChange={override}/></div>)}</div>
        {!state.session || ['completed','stopped'].includes(state.session.status) ? <div className="automation-start"><label>研究问题<textarea aria-label="自动研究问题" value={question} onChange={event=>setQuestion(event.target.value)} placeholder="例如：找相关论文，复现其代码，分析哪些不足值得验证。已有研究方向时可留空。"/></label><div className="automation-controls"><label>运行到<select aria-label="研究结束阶段" value={target} onChange={event=>setTarget(event.target.value)}>{STAGES.slice(1).map(([id,label])=><option key={id} value={id}>{label}{id==='ideation'?'（找论文 → 复现 → 分析不足）':''}</option>)}</select></label><label><input type="checkbox" checked={skip} onChange={event=>setSkip(event.target.checked)}/>跳过复现，先分析论文</label></div><button className="hub-small-button" disabled={busy||!!active} onClick={start}>开始研究</button></div> : null}
        <details className="automation-materials"><summary>复现 / 实验材料（已有计划可留空）</summary><p>使用项目内代码与数据；未找到可运行材料时会停在具体缺口。</p>{state.session?.executionPlan&&<p>材料 v{state.session.executionPlanVersion} · {newStart?'上一条链路的材料；新研究可另填。':planLocked?'已绑定原任务；继续时使用此版本。':'尚未消费，可补充或更新。'}</p>}<div className="automation-controls"><label>代码入口<input aria-label="实验代码入口" readOnly={planLocked} disabled={busy} value={entry} onChange={event=>setEntry(event.target.value)} placeholder="run.py 或 run.mjs"/></label><label>数据<input aria-label="实验数据" readOnly={planLocked} disabled={busy} value={dataset} onChange={event=>setDataset(event.target.value)} placeholder="data.json"/></label><label>数据版本<input aria-label="实验数据版本" readOnly={planLocked} disabled={busy} value={version} onChange={event=>setVersion(event.target.value)} placeholder="v1 或快照版本"/></label></div>{state.session&&!newStart&&!planLocked&&!active&&<button className="hub-small-button" disabled={busy||!entry||!dataset||!version} onClick={supplement}>保存材料并继续</button>}</details>
        {state.session && <div className="automation-progress" aria-live="polite"><strong>{labels[state.session.status]||state.session.status}</strong><p>{state.session.message}</p>{state.session.coordinatorRunId&&<Link to={taskHref(projectId,`harness:${state.session.coordinatorRunId}`)}>研究父任务</Link>}{state.session.steps.map(step=><div className="automation-run-links" key={step.stage}>{step.handoff&&<span>输入 v{step.handoff.workflowVersion} · {step.handoff.inputArtifacts.map(source=><Link key={source.stage} to={href(projectId,source.stage)} title={`输入快照 ${source.dataSha256}`}>{STAGES.find(([id])=>id===source.stage)?.[1]}来源</Link>)}</span>}{step.runIds.map(id=><Link key={id} to={taskHref(projectId,`harness:${id}`)}>{STAGES.find(([id])=>id===step.stage)?.[1]} Agent Run</Link>)}{step.experimentRunId&&<Link to={taskHref(projectId,`experiment-run:${step.experimentRunId}`)}>实验 Run · {step.result?.status||step.status}</Link>}</div>)}<div className="automation-controls">{state.session.status==='waiting_confirmation'&&<Link className="hub-small-button" to={href(projectId,state.session.error?.details?.part==='execution'?(state.session.currentStage||'replication'):(state.session.error?.details?.part||state.session.currentStage||'direction'))}>查看并确认当前环节</Link>}{!active&&state.session.status!=='completed'&&<button className="hub-small-button" disabled={busy} onClick={()=>void perform(()=>automationApi.action(projectId,'resume',{recoverExisting:['interrupted','blocked'].includes(state.session?.status||'')},workspaceModel()))}>{['interrupted','blocked'].includes(state.session.status)?'核对并继续原任务':'继续链路'}</button>}{state.session.status!=='completed'&&state.session.status!=='stopped'&&<button className="hub-small-button is-quiet" disabled={busy||state.session.status==='stopping'} onClick={()=>void perform(()=>automationApi.action(projectId,'stop'))}>停止链路</button>}<Link to={`/project/${projectId}/explore`}>查看横向执行链路</Link></div></div>}
        <p className="automation-footnote">自动推进记录为授权决定；论文、实验结果和 AI 提出的不足仍保留各自的核验状态。</p>
      </>}
    </div>
  </details>;
}
