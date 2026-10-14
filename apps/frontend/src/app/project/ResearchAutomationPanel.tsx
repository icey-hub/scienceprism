import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { automationApi, type AutomationState, type AutomationPolicy, type ConfirmationMode, type CodeScope } from '../../api/automationAdapter';
import { workspaceModel } from '../workspace/workspaceModel';
import { taskHref } from './taskLocation';
import './ResearchAutomationPanel.css';

const STAGES: [string, string][] = [['direction','方向'],['search','检索'],['selection','筛选'],['replication','复现'],['ideation','不足与创新'],['method','方法'],['experiment','实验'],['writing','写作交接']];
const taskNames:Record<string,string>={'research:environment_proposal':'环境建议 Run','research:execution_proposal':'实验材料 Run','research:dataset_discovery':'数据来源 Run','research:code-preparation':'代码生产 Agent','research:code-repair':'代码修复 Agent'};
const codeLabels:Record<string,string>={prepared:'等待生成',producing:'代码生成中',verifying:'核对代码版本',completed:'代码已准备',failed:'代码准备失败',cancelled:'代码准备已取消'};
const labels: Record<string,string> = {pending:'待开始',queued:'排队中',running:'运行中',preparing:'Agent分析中',recovering:'核对原任务中',awaiting_confirmation:'待确认',approved:'已决定',awaiting_execution:'待执行授权',executing:'实验运行中',completed:'完成',stopping:'正在停止',stopped:'已停止',blocked:'需要处理',waiting_confirmation:'等待确认',interrupted:'执行中断',failed:'失败'};
const DATASET_HOSTS=['raw.githubusercontent.com','archive.ics.uci.edu','zenodo.org','huggingface.co'];
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
  const [dataBudget,setDataBudget]=useState('16'),[dataCount,setDataCount]=useState('1'),[dataHosts,setDataHosts]=useState<string[]>(DATASET_HOSTS);
  const [environmentPaths,setEnvironmentPaths]=useState('wheels'),[environmentPackages,setEnvironmentPackages]=useState('10'),[environmentMinutes,setEnvironmentMinutes]=useState('2'),[environmentCount,setEnvironmentCount]=useState('1');
  const [codeEnabled,setCodeEnabled]=useState(false),[codePaths,setCodePaths]=useState(''),[codeTokens,setCodeTokens]=useState('32000'),[codeSeconds,setCodeSeconds]=useState('300'),[codeVersions,setCodeVersions]=useState('2'),[codeConflict,setCodeConflict]=useState(false);
  const codeDirty=useRef(false),codeSaved=useRef('null');
  const alive = useRef(true), lock = useRef(false), revision = useRef(0);
  useEffect(() => {
    alive.current = true; let disposed = false, timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      const captured = revision.current;
      try { const result = await automationApi.load(projectId); if (!disposed && !lock.current && captured === revision.current) setState(result); }
      catch (error) { if (!disposed && !lock.current && captured === revision.current) setError(String(error)); }
      finally { if (!disposed) timer = setTimeout(load, 2500); }
    };
    void load(); return () => { disposed = true; alive.current = false; clearTimeout(timer); };
  },[projectId]);
  useEffect(()=>{const scope=state?.policy.datasetScope;if(scope){setDataBudget(String(scope.maxBytes/1048576));setDataCount(String(scope.maxDatasets));setDataHosts(scope.allowedHosts);}},[state?.policy.datasetScope?.maxBytes,state?.policy.datasetScope?.maxDatasets,state?.policy.datasetScope?.allowedHosts.join('|')]);
  useEffect(()=>{const scope=state?.policy.environmentScope;if(scope){setEnvironmentPaths(scope.allowedPaths.join('\n'));setEnvironmentPackages(String(scope.maxPackages));setEnvironmentMinutes(String(scope.maxPrepareMs/60000));setEnvironmentCount(String(scope.maxEnvironments));}},[state?.policy.environmentScope?.allowedPaths.join('|'),state?.policy.environmentScope?.maxPackages,state?.policy.environmentScope?.maxPrepareMs,state?.policy.environmentScope?.maxEnvironments]);
  const codeScopeKey=JSON.stringify(state?.policy.codeScope??null);
  function loadCodeDraft(scope:CodeScope|null|undefined) {
    setCodeEnabled(!!scope);setCodePaths(scope?.allowedPaths.join('\n')||'');setCodeTokens(String(scope?.maxTokens??32000));
    setCodeSeconds(String((scope?.timeoutMs??300000)/1000));setCodeVersions(String(scope?.maxVersions??2));
    codeDirty.current=false;codeSaved.current=JSON.stringify(scope??null);setCodeConflict(false);
  }
  useEffect(()=>{
    if(!state)return;
    if(codeDirty.current){if(codeSaved.current!==codeScopeKey)setCodeConflict(true);return;}
    loadCodeDraft(state.policy.codeScope);
  },[codeScopeKey,state===null]);
  const editCode=()=>{codeDirty.current=true;};
  useEffect(() => {
    const plan = state?.session?.executionPlan;
    if (state?.session) { setEntry(plan?.execution.entrypoint || ''); setDataset(plan?.dataset || ''); setVersion(plan?.datasetVersion || ''); }
  }, [state?.session?.id, state?.session?.executionPlanSha256]);
  const perform = async (operation: () => Promise<unknown>) => {
    if (lock.current) return;
    lock.current = true; revision.current++; setBusy(true); setError('');
    try { await operation(); const result = await automationApi.load(projectId); if (alive.current) setState(result); }
    catch(error) { if (alive.current) setError(String(error)); }
    finally { revision.current++; lock.current = false; if (alive.current) setBusy(false); }
  };
  const save = (policy: AutomationPolicy) => state && void perform(() => automationApi.save(projectId, policy, state.version));
  const override = (part: string, mode: ConfirmationMode) => state && save({...state.policy, overrides:{...state.policy.overrides,[part]:mode}});
  const environmentScope = () => ({allowedPaths:environmentPaths.split('\n').map(path=>path.trim()).filter(Boolean),maxPackages:Number(environmentPackages),maxPrepareMs:Math.round(Number(environmentMinutes)*60000),maxOutputBytes:state?.policy.environmentScope?.maxOutputBytes ?? 1048576,maxEnvironments:Number(environmentCount)});
  const saveCodeScope=()=>state&&void perform(async()=>{
    const codeScope=codeEnabled?{allowedPaths:codePaths.split('\n').map(path=>path.trim()).filter(Boolean),maxTokens:Number(codeTokens),timeoutMs:Math.round(Number(codeSeconds)*1000),maxVersions:Number(codeVersions)}:null;
    const saved=await automationApi.save(projectId,{...state.policy,codeScope},state.version);
    if(alive.current)loadCodeDraft(saved.policy.codeScope);
  });
  const active = state?.session && ['queued','running','stopping'].includes(state.session.status);
  const materials = () => {
    if(!entry||!dataset||!version)return {};
    const original=state?.session?.executionPlan,execution=original?.execution;
    return {executionPlan:{protocol:'执行项目内论文实验，记录结果与不足。',seed:0,successCriteria:['记录实际输出，不预设成功'],artifacts:[{path:'results/metrics.json',kind:'metric'}],...original,dataset,datasetVersion:version,
      execution:{adapter:entry.endsWith('.py')?'python':'node',entrypoint:entry,args:execution?.args||[],
        ...(entry.endsWith('.py')&&execution?.environmentId?{environmentId:execution.environmentId}:{}),
        ...(entry===execution?.entrypoint&&execution.codePreparationId?{codePreparationId:execution.codePreparationId}:{})}}};
  };
  const newStart = !state?.session || ['completed','stopped'].includes(state.session.status);
  const planLocked = !newStart && state?.session?.executionPlanLocked === true;
  const supplement = () => state?.session && void perform(() => automationApi.action(projectId,'resume',{...materials(),expectedSessionId:state.session?.id,expectedExecutionPlanVersion:state.session?.executionPlanVersion ?? 0,recoverExisting:['interrupted','blocked'].includes(state.session?.status||'')},workspaceModel()));
  const start = () => void perform(() => automationApi.action(projectId,'start',{question,targetStage:target,skipReplication:skip,...materials()},workspaceModel()));
  return <details className="research-automation" id="research-automation" open={expanded || undefined}>
    <summary><strong>自动研究</strong><span>{state?.policy.enabled?'默认自动继续':'默认人工确认'}{state?.session ? ` · ${labels[state.session.status]||state.session.status}` : ''}</span></summary>
    <div className="automation-body">
      {error && <p role="alert">{error}</p>}
      {!state ? <p>正在读取执行策略…</p> : <>
        <div className="automation-default"><div><h3>让 AI 连续推进研究</h3><p>总开关设置默认行为，每个环节可单独选择。保存策略后，点击开始研究。</p></div><label><input aria-label="自动研究总开关" role="switch" type="checkbox" checked={state.policy.enabled} disabled={busy} onChange={event=>save({...state.policy,enabled:event.target.checked})}/>{state.policy.enabled?'已开启':'已关闭'}</label></div>
        <div className="automation-controls"><label>Agent 分工<select aria-label="Agent分工" value={state.policy.agentMode} disabled={busy} onChange={event=>save({...state.policy,agentMode:event.target.value as AutomationPolicy['agentMode']})}><option value="specialists">阶段专家接力</option><option value="generalist">通用研究助手</option></select></label><Link to={`/project/${projectId}/agents`}>查看 Agent 设计</Link></div>
        <div className="automation-stages">{STAGES.map(([stage,label])=>{const step=state.session?.steps.find(step=>step.stage===stage), specialist=state.agents.find(agent=>agent.stage===stage);return <div className="automation-stage" key={stage}><div><Link to={href(projectId,stage)}>{label}</Link><small title={specialist?.purpose}>{state.policy.agentMode==='specialists'?(specialist?.label||'研究者提供问题'):'研究助手'}</small></div><ConfirmationControl part={stage} label={`${label}确认模式`} disabled={busy} mode={state.policy.overrides[stage]||'inherit'} onChange={override}/>{step && <span className={`automation-step is-${step.status}`}>{labels[step.status]||step.status}</span>}</div>;})}</div>
        <div className="automation-controls">{[['dataset','数据取得确认'],['environment','环境准备'],['execution','实验运行确认'],['patches','文稿修改确认']].map(([part,label])=><div className="automation-confirmation" key={part}><span>{label}</span><ConfirmationControl part={part} label={label} disabled={busy} mode={state.policy.overrides[part]||'inherit'} onChange={override}/></div>)}</div>
        <div className="automation-controls"><label>代码准备确认<select aria-label="代码准备确认模式" value={state.policy.overrides.code||'inherit'} disabled={busy} onChange={event=>override('code',event.target.value as ConfirmationMode)}><option value="inherit">跟随总开关</option><option value="auto">自动</option><option value="manual">人工</option></select></label><span className="automation-scope-note">需要另行保存源码范围和预算。</span></div>
        <details className="automation-materials automation-code-scope"><summary>源码范围与预算</summary>
          <p>Codex 按固定材料准备代码，供隔离运行。保存范围后才生效；已有父任务不能补授新权限，新增权限用于新链路。</p>
          <form onSubmit={event=>{event.preventDefault();saveCodeScope();}}>
            <label className="automation-code-toggle"><input type="checkbox" aria-label="允许 AI 准备实验代码" checked={codeEnabled} disabled={busy} onChange={event=>{editCode();setCodeEnabled(event.target.checked);}}/>允许按代码环节策略准备源码</label>
            <div className="automation-start"><label>允许的源码路径<textarea aria-label="自动代码源码路径" rows={3} required={codeEnabled} disabled={busy||!codeEnabled} value={codePaths} onChange={event=>{editCode();setCodePaths(event.target.value);}} placeholder={'experiments\nsrc/baseline.py'}/></label></div>
            <p>每行一个项目内相对目录或源文件；需明确填写，不能使用根目录或通配符。</p>
            <div className="automation-code-budgets">
              <label>模型 token 上限<input aria-label="自动代码模型预算" type="number" min="128" max="100000" step="1" required={codeEnabled} value={codeTokens} disabled={busy||!codeEnabled} onChange={event=>{editCode();setCodeTokens(event.target.value);}}/></label>
              <label>总时限 · 秒<input aria-label="自动代码时限预算" type="number" min="0.1" max="600" step="0.001" required={codeEnabled} value={codeSeconds} disabled={busy||!codeEnabled} onChange={event=>{editCode();setCodeSeconds(event.target.value);}}/></label>
              <label>每阶段代码版本上限<input aria-label="自动代码版本预算" type="number" min="1" max="2" step="1" required={codeEnabled} value={codeVersions} disabled={busy||!codeEnabled} onChange={event=>{editCode();setCodeVersions(event.target.value);}}/></label>
            </div>
            {codeConflict&&<p role="alert">后端代码范围已变化，当前草稿已保留。请重新载入范围后核对。</p>}
            <div className="automation-controls"><button className="hub-small-button" disabled={busy||codeConflict||(codeEnabled&&!codePaths.trim())}>保存代码范围</button><button type="button" className="hub-small-button is-quiet" disabled={busy} onClick={()=>loadCodeDraft(state.policy.codeScope)}>重新载入范围</button><span className="automation-scope-note">{state.policy.codeScope?'已保存源码范围':'尚未授权源码范围'}{codeDirty.current?' · 有未保存更改':''}</span></div>
          </form>
        </details>
        <details className="automation-materials"><summary>公开数据来源与预算</summary><p>复现 Agent 提出来源，应用按保存的范围取得数据。旧策略未配置范围时不会自动下载。</p><label><input type="checkbox" aria-label="允许自动取得公开数据" checked={!!state.policy.datasetScope} disabled={busy} onChange={event=>save({...state.policy,datasetScope:event.target.checked?{allowedHosts:dataHosts,maxBytes:Math.round(Number(dataBudget)*1048576),maxDatasets:Number(dataCount)}:null})}/>允许按数据环节策略取得公开数据</label><form onSubmit={event=>{event.preventDefault();save({...state.policy,datasetScope:{allowedHosts:dataHosts,maxBytes:Math.round(Number(dataBudget)*1048576),maxDatasets:Number(dataCount)}});}}><div className="automation-controls">{DATASET_HOSTS.map(host=><label key={host}><input type="checkbox" disabled={busy} checked={dataHosts.includes(host)} onChange={event=>setDataHosts(current=>event.target.checked?[...current,host]:current.filter(value=>value!==host))}/>{host}</label>)}</div><div className="automation-controls"><label>每份数据 · MiB<input aria-label="自动数据体积预算" type="number" min="0.001" max="128" step="any" required value={dataBudget} disabled={busy} onChange={event=>setDataBudget(event.target.value)}/></label><label>链路最多取得<input aria-label="自动数据数量预算" type="number" min="1" max="5" required value={dataCount} disabled={busy} onChange={event=>setDataCount(event.target.value)}/></label><button className="hub-small-button" disabled={busy||!dataHosts.length}>保存数据范围</button></div></form></details>
        <details className="automation-materials"><summary>Python 环境范围与预算</summary><p>仅使用项目内已有依赖文件；当前不联网安装。未配置范围时不会自动准备环境。</p><label><input type="checkbox" aria-label="允许 AI 准备 Python 环境" checked={!!state.policy.environmentScope} disabled={busy} onChange={event=>save({...state.policy,environmentScope:event.target.checked?environmentScope():null})}/>允许 AI 准备 Python 环境</label><form onSubmit={event=>{event.preventDefault();save({...state.policy,environmentScope:environmentScope()});}}><div className="automation-start"><label>允许的依赖目录<textarea aria-label="自动环境依赖目录" rows={3} disabled={busy} value={environmentPaths} onChange={event=>setEnvironmentPaths(event.target.value)} placeholder="wheels"/></label></div><p>每行一个项目内相对目录；留空仅准备标准库环境。</p><div className="automation-controls"><label>依赖包上限<input aria-label="自动环境依赖包预算" type="number" min="0" max="30" required value={environmentPackages} disabled={busy} onChange={event=>setEnvironmentPackages(event.target.value)}/></label><label>准备时间 · 分钟<input aria-label="自动环境准备时间预算" type="number" min={100/60000} max="10" step="any" required value={environmentMinutes} disabled={busy} onChange={event=>setEnvironmentMinutes(event.target.value)}/></label><label>链路最多准备<input aria-label="自动环境数量预算" type="number" min="1" max="3" required value={environmentCount} disabled={busy} onChange={event=>setEnvironmentCount(event.target.value)}/></label><button className="hub-small-button" disabled={busy}>保存环境范围</button></div></form></details>
        {!state.session || ['completed','stopped'].includes(state.session.status) ? <div className="automation-start"><label>研究问题<textarea aria-label="自动研究问题" value={question} onChange={event=>setQuestion(event.target.value)} placeholder="例如：找相关论文，复现其代码，分析哪些不足值得验证。已有研究方向时可留空。"/></label><div className="automation-controls"><label>运行到<select aria-label="研究结束阶段" value={target} onChange={event=>setTarget(event.target.value)}>{STAGES.slice(1).map(([id,label])=><option key={id} value={id}>{label}{id==='ideation'?'（找论文 → 复现 → 分析不足）':''}</option>)}</select></label><label><input type="checkbox" checked={skip} onChange={event=>setSkip(event.target.checked)}/>跳过复现，先分析论文</label></div><button className="hub-small-button" disabled={busy||!!active} onClick={start}>开始研究</button></div> : null}
        <details className="automation-materials"><summary>复现 / 实验材料（已有计划可留空）</summary><p>使用项目内代码与数据；未找到可运行材料时会停在具体缺口。</p>{state.session?.executionPlan&&<p>材料 v{state.session.executionPlanVersion} · {newStart?'上一条链路的材料；新研究可另填。':planLocked?'已绑定原任务；继续时使用此版本。':'尚未消费，可补充或更新。'}</p>}<div className="automation-controls"><label>代码入口<input aria-label="实验代码入口" readOnly={planLocked} disabled={busy} value={entry} onChange={event=>setEntry(event.target.value)} placeholder="run.py 或 run.mjs"/></label><label>数据<input aria-label="实验数据" readOnly={planLocked} disabled={busy} value={dataset} onChange={event=>setDataset(event.target.value)} placeholder="data.json"/></label><label>数据版本<input aria-label="实验数据版本" readOnly={planLocked} disabled={busy} value={version} onChange={event=>setVersion(event.target.value)} placeholder="v1 或快照版本"/></label></div>{state.session&&!newStart&&!planLocked&&!active&&<button className="hub-small-button" disabled={busy||!entry||!dataset||!version} onClick={supplement}>保存材料并继续</button>}</details>
        {state.session && <div className="automation-progress" aria-live="polite"><strong>{labels[state.session.status]||state.session.status}</strong><p>{state.session.message}</p>{state.session.coordinatorRunId&&<Link to={taskHref(projectId,`harness:${state.session.coordinatorRunId}`)}>研究父任务</Link>}{state.session.steps.map(step=><div className="automation-run-links" key={step.stage}>{step.handoff&&<span>输入 v{step.handoff.workflowVersion} · {step.handoff.inputArtifacts.map(source=><Link key={source.stage} to={href(projectId,source.stage)} title={`输入快照 ${source.dataSha256}`}>{STAGES.find(([id])=>id===source.stage)?.[1]}来源</Link>)}</span>}{step.runIds.filter(id=>!step.codePreparations?.some(item=>item.producerRunId===id)).map(id=><Link key={id} to={taskHref(projectId,`harness:${id}`)}>{taskNames[step.calls?.find(call=>call.runId===id)?.task||'']||`${STAGES.find(([id])=>id===step.stage)?.[1]} Agent Run`}</Link>)}{step.datasetAcquisitions?.map(item=>item.jobId&&<Link key={item.jobId} to={taskHref(projectId,`dataset-acquisition:${item.jobId}`)}>数据 · {labels[item.status]||item.status}</Link>)}{step.environmentPreparations?.map(item=>item.jobId&&<Link key={item.jobId} to={taskHref(projectId,`environment-preparation:${item.jobId}`)} title={item.environmentId?`环境 ${item.environmentId}${item.sha256?` · ${item.sha256}`:''}`:undefined}>环境 · {labels[item.status]||item.status}</Link>)}{step.codePreparations?.map((item,index)=><article className="automation-code-record" key={item.preparationId||item.producerRunId||`${item.authorization.inputSha256}:${index}`}>
              <div className="automation-code-record-heading"><strong>{codeLabels[item.status]||item.status}</strong><small>授权 v{item.authorization.policyVersion} · {STAGES.find(([id])=>id===item.authorization.stage)?.[1]||item.authorization.stage}</small></div>
              <p>{item.paths.join('、')}</p>
              <small title={item.authorization.inputSha256}>材料 {item.authorization.inputSha256.slice(0,16)}</small>
              <div className="automation-run-links">
                {item.producerRunId&&<Link to={taskHref(projectId,`harness:${item.producerRunId}`)}>代码生产 Agent</Link>}
                {item.preparationId&&<Link to={href(projectId,item.authorization.stage)} title={`${item.preparationId}${item.sha256?` · SHA256 ${item.sha256}`:''}`}>查看固定代码版本 · {(item.sha256||item.preparationId).slice(0,item.sha256?12:28)}</Link>}
              </div>
              {item.preparationId&&<code title={item.sha256||undefined}>{item.preparationId}</code>}
              {item.error&&<p role="alert">{item.error.message}</p>}
              <small>固定代码用于隔离运行；执行结果见实验 Run。</small>
            </article>)}{step.experimentRunId&&<Link to={taskHref(projectId,`experiment-run:${step.experimentRunId}`)}>实验 Run · {step.result?.status||step.status}</Link>}</div>)}<div className="automation-controls">{state.session.status==='waiting_confirmation'&&<Link className="hub-small-button" to={href(projectId,['execution','environment','dataset','code'].includes(state.session.error?.details?.part||'')?(state.session.currentStage||'replication'):(state.session.error?.details?.part||state.session.currentStage||'direction'))}>查看并确认当前环节</Link>}{!active&&state.session.status!=='completed'&&<button className="hub-small-button" disabled={busy} onClick={()=>void perform(()=>automationApi.action(projectId,'resume',{recoverExisting:['interrupted','blocked'].includes(state.session?.status||'')},workspaceModel()))}>{['interrupted','blocked'].includes(state.session.status)?'核对并继续原任务':'继续链路'}</button>}{state.session.status!=='completed'&&state.session.status!=='stopped'&&<button className="hub-small-button is-quiet" disabled={busy||state.session.status==='stopping'} onClick={()=>void perform(()=>automationApi.action(projectId,'stop'))}>停止链路</button>}<Link to={`/project/${projectId}/explore`}>查看横向执行链路</Link></div></div>}
        <p className="automation-footnote">自动推进记录为授权决定；论文、实验结果和 AI 提出的不足仍保留各自的核验状态。</p>
      </>}
    </div>
  </details>;
}
