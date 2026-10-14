import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { getIdeaPlan, saveIdeaPlan, type IdeaPlan, type IdeaHypothesis, type IdeaEvaluation } from '../../../api/client';
import type { InnovationIdea } from '../researchStages';
import './IdeaPlanEditor.css';

export interface IdeaPlanEditorProps { projectId:string;idea:InnovationIdea;replicationRunId?:string;onSaved?:()=>void|Promise<void>;readOnly?:boolean; }
type MetricDraft = {key:string;name:string;direction:IdeaEvaluation['metrics'][number]['direction'];threshold:string};
interface Draft { hypothesis:IdeaHypothesis;researchType:IdeaEvaluation['researchType'];dataset:string;datasetVersion:string;split:string;seed:string;baselines:string;metrics:MetricDraft[];repetitions:string;ablations:string;maxRuns:string;maxSeconds:string; }
const hypothesisFields:[keyof IdeaHypothesis,string,string][] = [['problem','待解决的问题','明确现有工作哪里不足'],['prediction','可检验预测','哪些可观察结果支持该假设'],['priorWork','已有工作与文献来源','已有论文、方法及其限制'],['conditions','适用条件与风险','数据范围、成立条件或需要控制的风险'],['falsificationCondition','可证伪条件','什么结果会否定这项假设']];
const numberInput = (value:string) => value.trim() ? Number(value) : null;
const lines = (value:string) => value.split('\n').map(item=>item.trim()).filter(Boolean);
function draftOf(idea:InnovationIdea,plan:IdeaPlan|null):Draft {
  const evaluation=plan?.evaluation;
  return {hypothesis:plan?.hypothesis || {problem:idea.problem||'',prediction:idea.hypothesis||'',priorWork:idea.relatedPaperIds?.join('\n')||'',conditions:idea.risks?.length?`已识别风险：\n${idea.risks.join('\n')}`:'',falsificationCondition:idea.humanReview?.falsificationCondition||''},
    researchType:evaluation?.researchType||'empirical',dataset:evaluation?.dataset||'',datasetVersion:evaluation?.datasetVersion||'',split:evaluation?.split||'',seed:evaluation?.seed??'',baselines:evaluation?.baselines.join('\n')||'',
    metrics:evaluation?.metrics.map(metric=>({...metric,key:crypto.randomUUID(),threshold:metric.threshold==null?'':String(metric.threshold)}))||[],
    repetitions:evaluation?.repetitions==null?'':String(evaluation.repetitions),ablations:evaluation?.ablations.join('\n')||'',maxRuns:evaluation?.budget.maxRuns==null?'':String(evaluation.budget.maxRuns),maxSeconds:evaluation?.budget.maxSeconds==null?'':String(evaluation.budget.maxSeconds)};
}
function evaluationOf(draft:Draft):IdeaEvaluation {
  return {researchType:draft.researchType,dataset:draft.dataset,datasetVersion:draft.datasetVersion,split:draft.split,seed:draft.seed,baselines:lines(draft.baselines),metrics:draft.metrics.map(metric=>({name:metric.name,direction:metric.direction,threshold:numberInput(metric.threshold)})),repetitions:numberInput(draft.repetitions),ablations:lines(draft.ablations),budget:{maxRuns:numberInput(draft.maxRuns),maxSeconds:numberInput(draft.maxSeconds)}};
}
function PlanHistory({projectId,plan}:{projectId:string;plan:IdeaPlan}) {
  const evaluation=plan.evaluation;
  return <div className="idea-plan-history-record"><p>版本 {plan.revision} · {plan.createdAt} · {plan.readiness.ready?'方案字段已齐备':'方案仍有缺口'} · 科学假设尚未验证</p>
    <dl>{hypothesisFields.map(([key,label])=><div key={key}><dt>{label}</dt><dd>{plan.hypothesis[key]||'未填写'}</dd></div>)}
      <div><dt>数据与划分</dt><dd>{evaluation.dataset||'数据未填写'} · {evaluation.datasetVersion||'版本未填写'} · {evaluation.split||'划分未填写'}</dd></div>
      <div><dt>固定随机种子</dt><dd>{evaluation.seed||'未填写'}</dd></div>
      <div><dt>基线与消融</dt><dd>{evaluation.baselines.join('；')||'基线未填写'} / {evaluation.ablations.join('；')||'消融未填写'}</dd></div>
      <div><dt>重复 / 最大次数 / 最大秒数</dt><dd>{evaluation.repetitions??'未填写'} / {evaluation.budget.maxRuns??'未填写'} / {evaluation.budget.maxSeconds??'未填写'}</dd></div>
    </dl>{evaluation.metrics.length>0&&<table><thead><tr><th>指标</th><th>方向</th><th>阈值</th></tr></thead><tbody>{evaluation.metrics.map((metric,index)=><tr key={index}><td>{metric.name||'未命名'}</td><td>{{increase:'增加',decrease:'减少',target:'目标值'}[metric.direction]}</td><td>{metric.threshold??'未填写'}</td></tr>)}</tbody></table>}
    {plan.readiness.issues.length>0&&<ul>{plan.readiness.issues.map((issue,index)=><li key={index}>{issue}</li>)}</ul>}
    {plan.evidence&&<div className="idea-plan-source"><strong>该版本的复现证据</strong><span>对比 v{plan.evidence.comparisonRevision} · {plan.evidence.paper.title}</span>
      <Link to={`/project/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(`experiment-run:${plan.evidence.runId}`)}`}>原复现 Run</Link>
      <Link to={`/project/${encodeURIComponent(projectId)}/papers/${encodeURIComponent(plan.evidence.paper.id)}/read`}>论文阅读与来源</Link>
      <details className="idea-plan-wide"><summary>查看该版本对比快照（只读）</summary><table><thead><tr><th scope="col">指标</th><th scope="col">论文报告值</th><th scope="col">实测值</th><th scope="col">原因假设 · 未验证</th></tr></thead><tbody>{plan.evidence.rows.map(row=><tr key={row.id}><th scope="row">{row.metricName}</th><td>{row.reportedValue??'未报告'}</td><td>{row.actualValue??'未报告'}</td><td>{row.causeHypothesis||'未记录'}</td></tr>)}</tbody></table></details>
    </div>}
  </div>;
}
export function IdeaPlanEditor(props:IdeaPlanEditorProps) {
  const [opened,setOpened]=useState(false);
  return <details className="idea-plan-editor" onToggle={event=>{if(event.currentTarget.open)setOpened(true);}}><summary>{props.readOnly?'查看假设与验证方案':'编辑假设与验证方案'}</summary>{opened&&<Editor key={`${props.projectId}:${props.idea.id}`} {...props}/>}</details>;
}
function Editor({projectId,idea,replicationRunId,onSaved,readOnly=false}:IdeaPlanEditorProps) {
  const [draft,setDraft]=useState<Draft>(()=>draftOf(idea,null)),[plan,setPlan]=useState<IdeaPlan|null>(null),[history,setHistory]=useState<IdeaPlan[]>([]),[historyVersion,setHistoryVersion]=useState('');
  const [loading,setLoading]=useState(true),[ready,setReady]=useState(false),[saving,setSaving]=useState(false),[dirty,setDirty]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const alive=useRef(true),lock=useRef(false);
  const load=async(preserveDraft=false)=>{
    if(lock.current)return;lock.current=true;setLoading(true);setError('');
    try {const result=await getIdeaPlan(projectId,idea.id);if(alive.current){setPlan(result.plan);setHistory(result.history);setReady(true);if(!preserveDraft){setDraft(draftOf(idea,result.plan));setDirty(false);}setNotice(preserveDraft?'已读取最新版本，当前草稿保留；核对历史后再手动保存。':'');}}
    catch(reason){if(alive.current)setError(`读取方案失败：${String(reason)}`);}
    finally{lock.current=false;if(alive.current)setLoading(false);}
  };
  useEffect(()=>{alive.current=true;void load();return()=>{alive.current=false;};},[projectId,idea.id]);
  const change=(patch:Partial<Draft>)=>{setDraft(current=>({...current,...patch}));setDirty(true);setNotice('');};
  const save=async(event:FormEvent<HTMLFormElement>)=>{
    event.preventDefault();if(lock.current||!ready||readOnly)return;
    const evaluation=evaluationOf(draft),numbers=[evaluation.repetitions,evaluation.budget.maxRuns,evaluation.budget.maxSeconds,...evaluation.metrics.map(metric=>metric.threshold)];
    if(numbers.some(value=>value!==null&&!Number.isFinite(value))){setError('数值必须有限；没有确定的阈值、重复次数或预算可留空。');return;}
    lock.current=true;setSaving(true);setError('');setNotice('');
    const sourceRunId=plan?.evidence?.runId||replicationRunId;
    try {const result=await saveIdeaPlan(projectId,idea.id,{expectedRevision:plan?.revision||0,hypothesis:draft.hypothesis,evaluation,...(sourceRunId?{replicationRunId:sourceRunId}:{})});
      if(alive.current){setPlan(result.plan);setHistory(result.history);setDraft(draftOf(idea,result.plan));setDirty(false);setNotice(`已保存新版本 v${result.plan.revision}；保存不代表假设已验证。`);
        try{await onSaved?.();}catch{if(alive.current)setNotice('方案已保存，流程状态刷新失败请刷新页面。');}}}
    catch(reason){if(alive.current)setError(`保存失败，草稿已保留：${String(reason)}。请读取最新版本并核对后手动保存，不会自动重放。`);}
    finally{lock.current=false;if(alive.current)setSaving(false);}
  };
  const busy=loading||saving,evidence=plan?.evidence,selectedHistory=history.find(item=>String(item.revision)===historyVersion);
  return <div className="idea-plan-body">
    <div className="idea-plan-status"><strong>{plan?`方案 v${plan.revision}`:'尚未保存方案'}</strong><span>{plan?.readiness.ready?'方案字段已齐备':'可保存为草稿'} · 科学假设尚未验证</span></div>
    {loading&&<p role="status">正在读取方案版本…</p>}{error&&<p className="idea-plan-error" role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
    {!ready&&!loading&&<button className="research-button research-button-quiet" type="button" onClick={()=>void load()}>重新读取</button>}
    {ready&&<>
      {plan?.readiness.issues.length? <div className="idea-plan-issues"><strong>待补充</strong><ul>{plan.readiness.issues.map((issue,index)=><li key={index}>{issue}</li>)}</ul></div>:null}
      {readOnly&&<p>当前阶段仅查看已存方案与历史；返回可编辑的创新阶段后可保存新版本。</p>}
      <form onSubmit={event=>void save(event)}><fieldset disabled={busy||readOnly} className="idea-plan-fields">
        {hypothesisFields.map(([key,label,placeholder])=><label className="research-field" key={key}><span>{label}</span><textarea aria-label={`${idea.title} · ${label}`} rows={3} maxLength={4000} placeholder={placeholder} value={draft.hypothesis[key]} onChange={event=>change({hypothesis:{...draft.hypothesis,[key]:event.target.value}})}/></label>)}
        <label className="research-field"><span>研究类型</span><select value={draft.researchType} onChange={event=>change({researchType:event.target.value as IdeaEvaluation['researchType']})}><option value="empirical">实证研究</option><option value="computational">计算研究</option><option value="theoretical">理论研究</option></select></label>
        <label className="research-field"><span>数据集</span><input value={draft.dataset} maxLength={500} placeholder="未确定可留空" onChange={event=>change({dataset:event.target.value})}/></label>
        <label className="research-field"><span>数据版本</span><input value={draft.datasetVersion} maxLength={500} placeholder="固定版本或校验摘要" onChange={event=>change({datasetVersion:event.target.value})}/></label>
        <label className="research-field"><span>固定随机种子</span><input value={draft.seed} maxLength={100} placeholder="未确定可留空；0 是有效种子" onChange={event=>change({seed:event.target.value})}/></label>
        <label className="research-field idea-plan-wide"><span>数据划分与样本范围</span><textarea rows={2} value={draft.split} maxLength={4000} onChange={event=>change({split:event.target.value})}/></label>
        <label className="research-field"><span>对照基线（每行一个）</span><textarea rows={3} value={draft.baselines} onChange={event=>change({baselines:event.target.value})}/></label>
        <label className="research-field"><span>消融条件（每行一个）</span><textarea rows={3} value={draft.ablations} onChange={event=>change({ablations:event.target.value})}/></label>
        <div className="idea-plan-wide"><div className="idea-plan-metric-heading"><strong>评价指标</strong><button type="button" className="research-button research-button-quiet" onClick={()=>change({metrics:[...draft.metrics,{key:crypto.randomUUID(),name:'',direction:'increase',threshold:''}]})}>添加指标</button></div>
          {!draft.metrics.length&&<p>尚未填写指标；不预设阈值或实验成功。</p>}
          {draft.metrics.map(metric=><div className="idea-plan-metric" key={metric.key}>
            <label className="research-field"><span>指标名称</span><input aria-label="假设评价指标名称" value={metric.name} maxLength={200} onChange={event=>change({metrics:draft.metrics.map(row=>row.key===metric.key?{...row,name:event.target.value}:row)})}/></label>
            <label className="research-field"><span>预期方向</span><select value={metric.direction} onChange={event=>change({metrics:draft.metrics.map(row=>row.key===metric.key?{...row,direction:event.target.value as MetricDraft['direction']}:row)})}><option value="increase">增加</option><option value="decrease">减少</option><option value="target">达到目标值</option></select></label>
            <label className="research-field"><span>预设阈值</span><input type="number" step="any" value={metric.threshold} placeholder="未确定" onChange={event=>change({metrics:draft.metrics.map(row=>row.key===metric.key?{...row,threshold:event.target.value}:row)})}/></label>
            <button className="research-button research-button-quiet" type="button" aria-label={`删除评价指标${metric.name||'未命名'}`} onClick={()=>change({metrics:draft.metrics.filter(row=>row.key!==metric.key)})}>删除</button>
          </div>)}
        </div>
        <label className="research-field"><span>重复次数</span><input type="number" min="1" step="1" value={draft.repetitions} placeholder="未确定" onChange={event=>change({repetitions:event.target.value})}/></label>
        <label className="research-field"><span>最多运行次数</span><input type="number" min="1" step="1" value={draft.maxRuns} placeholder="未授权预算" onChange={event=>change({maxRuns:event.target.value})}/></label>
        <label className="research-field"><span>总运行上限 · 秒</span><input type="number" min="1" step="1" value={draft.maxSeconds} placeholder="未授权预算" onChange={event=>change({maxSeconds:event.target.value})}/></label>
      </fieldset>
      {idea.validationPlan&&idea.validationPlan.length>0&&<details className="idea-plan-reference"><summary>原候选的验证建议</summary><ol>{idea.validationPlan.map((step,index)=><li key={index}>{step}</li>)}</ol><small>原建议仅供填写参考，不自动当作确定的数据、阈值或预算。</small></details>}
      <div className="idea-plan-source"><strong>复现与论文来源</strong>{evidence?<><span>对比 v{evidence.comparisonRevision} · {evidence.paper.title}</span><Link to={`/project/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(`experiment-run:${evidence.runId}`)}`}>原复现 Run</Link><Link to={`/project/${encodeURIComponent(projectId)}/papers/${encodeURIComponent(evidence.paper.id)}/read`}>论文阅读与来源</Link></>:<span>{replicationRunId?'保存时关联当前复现 Run 的对比快照。':'未关联复现证据，可先保存草稿。'}</span>}<Link to={`/editor/${encodeURIComponent(projectId)}/research/replication`}>查看论文复现</Link></div>
      <div className="idea-plan-actions"><span>{dirty?'有未保存更改':'保存会生成新的方案版本'}</span><button className="research-button research-button-quiet" type="button" disabled={busy} onClick={()=>void load(true)}>读取最新版本，保留草稿</button><button className="research-button research-button-primary" disabled={busy||readOnly} type="submit">{saving?'保存中…':'保存方案新版本'}</button></div>
      </form>
      {history.length>0&&<details className="idea-plan-history"><summary>查看历史版本（只读）</summary><label className="research-field"><span>方案版本</span><select value={historyVersion} onChange={event=>setHistoryVersion(event.target.value)}><option value="">请选择历史版本</option>{[...history].sort((a,b)=>b.revision-a.revision).map(item=><option key={item.revision} value={item.revision}>v{item.revision} · {item.createdAt}</option>)}</select></label>{selectedHistory&&<PlanHistory projectId={projectId} plan={selectedHistory}/>}</details>}
    </>}
  </div>;
}
