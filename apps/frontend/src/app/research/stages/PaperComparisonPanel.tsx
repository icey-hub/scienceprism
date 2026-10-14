import { Fragment, useEffect, useRef, useState, type FormEvent } from 'react';
import { getExperimentRun, getPaperComparison, savePaperComparison, type ExperimentRun, type PaperComparison, type PaperComparisonGap, type PaperComparisonRowInput } from '../../../api/client';
import type { PaperCandidate } from '../researchStages';
import './PaperComparisonPanel.css';

interface DraftRow extends Omit<PaperComparisonRowInput, 'reportedValue' | 'tolerance'> {
  key: string; reportedValue: string; tolerance: string;
}
export interface PaperComparisonPanelProps { projectId: string; runId: string; papers: readonly PaperCandidate[]; }
const labels = { match:'容差内相符', different:'超出容差', unassessed:'未判断相符', 'missing-report':'论文未报告', 'missing-result':'实测未报告', 'run-failed':'运行失败', 'run-incomplete':'运行未完成' };
const gaps: [PaperComparisonGap, string][] = [['none','未标记不足'],['data-coverage','数据覆盖不足'],['missing-control','缺少对照'],['generalization','泛化待验证'],['missing-report','论文报告缺口'],['replication-failed','复现运行失败']];
const blank = (metricName = '', unit = ''): DraftRow => ({ key:crypto.randomUUID(),metricName,unit,reportedValue:'',tolerance:'',referenceLocation:'',reportedText:'',causeHypothesis:'',nextStep:'',gapType:'none' });
const inputRow = (row: DraftRow): PaperComparisonRowInput => ({
  metricName:row.metricName,unit:row.unit,referenceLocation:row.referenceLocation,reportedText:row.reportedText,
  causeHypothesis:row.causeHypothesis,nextStep:row.nextStep,gapType:row.gapType,
  reportedValue:row.reportedValue.trim() ? Number(row.reportedValue) : null,
  tolerance:row.tolerance.trim() ? Number(row.tolerance) : null });
const numberText = (value: number | null | undefined) => value == null ? '—' : Number(value.toPrecision(7)).toString();

export function PaperComparisonPanel(props: PaperComparisonPanelProps) {
  return <ComparisonEditor key={`${props.projectId}:${props.runId}`} {...props}/>;
}
export function PaperComparisonTable({comparison}:{comparison:PaperComparison}) {
  return <div className="paper-comparison paper-comparison-scroll"><table><caption className="paper-comparison-caption">论文报告值与服务端实测指标</caption>
    <thead><tr><th scope="col">指标</th><th scope="col">论文报告值</th><th scope="col">实测值</th><th scope="col">差值</th><th scope="col">判定</th><th scope="col">原因假设 · 未验证</th></tr></thead>
    <tbody>{comparison.rows.map(row=><tr key={row.id}><th scope="row">{row.metricName}{row.unit&&<small>{row.unit}</small>}<small>{row.referenceLocation || '来源定位待补充'}</small></th><td>{numberText(row.reportedValue)}</td><td title={String(row.actualValue ?? '')}>{numberText(row.actualValue)}</td><td title={String(row.difference ?? '')}>{numberText(row.difference)}</td><td>{labels[row.status]}</td><td className="paper-comparison-reason">{row.causeHypothesis || '尚未填写'}{row.nextStep&&<small>下一步：{row.nextStep}</small>}</td></tr>)}</tbody>
  </table>{!comparison.rows.length&&<p className="research-empty-inline">未保存对比指标。</p>}</div>;
}
function ComparisonEditor({projectId,runId,papers}:PaperComparisonPanelProps) {
  const [comparison,setComparison] = useState<PaperComparison|null>(null), [run,setRun] = useState<ExperimentRun|null>(null);
  const [rows,setRows] = useState<DraftRow[]>([]), [paperId,setPaperId] = useState(''), [expanded,setExpanded] = useState<string|null>(null);
  const [loading,setLoading] = useState(true), [saving,setSaving] = useState(false), [ready,setReady] = useState(false), [error,setError] = useState(''), [dirty,setDirty] = useState(false);
  const alive = useRef(true), locked = useRef(false);
  const apply = (saved:PaperComparison|null, actualRun:ExperimentRun) => {
    setComparison(saved);setRun(actualRun);setPaperId(actualRun.manifest?.replication?.paper?.id || saved?.paper.id || '');
    setRows(saved ? saved.rows.map(row=>({...row,key:row.id,reportedValue:row.reportedValue==null?'':String(row.reportedValue),tolerance:row.tolerance==null?'':String(row.tolerance)}))
      : (actualRun.metrics || []).map(metric=>blank(metric.name,metric.unit || '')));
    setExpanded(null);setDirty(false);setReady(true);
  };
  const load = async () => {
    if(locked.current)return;locked.current=true;setLoading(true);setError('');
    try {
      const [saved,actual] = await Promise.all([getPaperComparison(projectId,runId),getExperimentRun(projectId,runId)]);
      if(alive.current)apply(saved.comparison,actual.run);
    } catch(reason) { if(alive.current)setError(`无法读取论文对比：${String(reason)}`); }
    finally { locked.current=false;if(alive.current)setLoading(false); }
  };
  useEffect(()=>{alive.current=true;void load();return()=>{alive.current=false;};},[projectId,runId]);
  const change = (key:string, patch:Partial<DraftRow>) => {setRows(current=>current.map(row=>row.key===key?{...row,...patch}:row));setDirty(true);};
  const save = async (event:FormEvent<HTMLFormElement>) => {
    event.preventDefault();if(locked.current || !ready)return;
    const submitted = rows.map(inputRow);
    if(submitted.some(row=>!row.metricName.trim() || row.reportedValue!==null&&(!Number.isFinite(row.reportedValue)||Math.abs(row.reportedValue)>1e100||!row.referenceLocation.trim()||!row.reportedText.trim())
      || row.tolerance!==null&&(!Number.isFinite(row.tolerance)||row.tolerance<0||row.tolerance>1e100))) {setError('请填写指标名称和有原文来源的有限报告值，容差须非负且数值不超过 1e100；空值保持未报告。');return;}
    if(new Set(submitted.map(row=>row.metricName.trim())).size!==submitted.length) {setError('指标名称不能重复，请核对或删除重复行。');return;}
    locked.current=true;setSaving(true);setError('');
    try {
      const result = await savePaperComparison(projectId,runId,{expectedRevision:comparison?.revision || 0,paperId,rows:submitted});
      if(alive.current && run)apply(result.comparison,run);
    } catch(reason) {if(alive.current)setError(`保存失败，草稿已保留：${String(reason)}。可核对后重试，或放弃草稿并重新载入最新版本。`);}
    finally {locked.current=false;if(alive.current)setSaving(false);}
  };
  const boundPaper = run?.manifest?.replication?.paper;
  const options = [...papers];
  if(comparison?.paper && !options.some(paper=>paper.id===comparison.paper.id)) options.push({id:comparison.paper.id,title:comparison.paper.title,...(comparison.paper.year!=null?{year:comparison.paper.year}:{})});
  const runStatus = comparison?.runStatus || run?.status;
  const missingSource = rows.some(row=>row.reportedValue.trim()&&(!row.referenceLocation.trim()||!row.reportedText.trim()));
  const busy = loading || saving;
  return <section className="research-panel paper-comparison" aria-label="论文与实测对比">
    <div className="research-panel-heading"><div><span className="research-overline">PAPER / ACTUAL RESULTS</span><h3>论文与实测对比</h3></div><span className="research-status-note">{comparison?`版本 ${comparison.revision} · ${comparison.source==='ai'?'AI 分析':'人工记录'}`:'尚未保存'}</span></div>
    <p className="research-panel-copy">实测值取自当前 Run；差值与判定由服务端计算。容差留空或单位不一致时不判断相符，原因分析与下一步均是假设，科学核验另行记录。</p>
    {error&&<p className="paper-comparison-error" role="alert">{error}</p>}
    {loading&&<p role="status">正在读取论文对比与实际运行记录…</p>}
    {!ready&&!loading&&<button type="button" className="research-button research-button-quiet" onClick={()=>void load()}>重新读取</button>}
    {ready&&<form onSubmit={event=>void save(event)}>
      <div className="paper-comparison-source">
        {boundPaper ? <p><strong>{boundPaper.title}</strong><small>使用当前 Run 固定的论文来源。</small></p>
          : <label className="research-field"><span>对比论文</span><select aria-label="对比论文" value={paperId} required disabled={busy} onChange={event=>{setPaperId(event.target.value);setDirty(true);}}><option value="">请选择论文</option>{options.map(paper=><option key={paper.id} value={paper.id}>{paper.title}{paper.year?` · ${paper.year}`:''}</option>)}</select><small>此 Run 未绑定论文；选择仅建立分析关联，不改变原运行来源。</small></label>}
        <span className="research-status-note">Run · {comparison?.runStatus || run?.status || '未记录'}</span>
      </div>
      {runStatus&&['failed','cancelled','rejected'].includes(runStatus)&&<p className="paper-comparison-error">当前 Run {runStatus==='cancelled'?'已取消':runStatus==='rejected'?'已拒绝':'运行失败'}；此对比不能作为复现成功结论。</p>}
      <div className="paper-comparison-scroll"><table>
        <caption className="paper-comparison-caption">论文报告值与服务端实测指标</caption>
        <thead><tr><th scope="col">指标</th><th scope="col">论文报告值</th><th scope="col">实测值</th><th scope="col">差值</th><th scope="col">判定</th><th scope="col">原因假设</th><th scope="col">编辑</th></tr></thead>
        <tbody>{rows.map(row=>{
          const persisted = comparison?.rows.find(item=>item.id===row.key);
          const unchanged = comparison?.paper.id===paperId && persisted && Object.entries(inputRow(row)).every(([key,value])=>persisted[key as keyof PaperComparisonRowInput]===value);
          const actualMetric = run?.metrics?.filter(metric=>metric.name===row.metricName);
          const draftActual = run?.status==='completed'&&actualMetric?.length===1&&typeof actualMetric[0].value==='number'&&Number.isFinite(actualMetric[0].value) ? actualMetric[0].value : null;
          const actual = persisted?.metricName===row.metricName ? persisted.actualValue : draftActual;
          const detailId = `comparison-detail-${row.key}`;
          return <Fragment key={row.key}><tr>
            <th scope="row">{row.metricName||'待填写指标'}{row.unit&&<small>{row.unit}</small>}</th>
            <td><input type="number" step="any" min="-1e100" max="1e100" aria-label={`${row.metricName||'新增指标'}论文报告值`} value={row.reportedValue} disabled={busy} onChange={event=>change(row.key,{reportedValue:event.target.value})} placeholder="未报告"/></td>
            <td title={String(actual ?? '')}>{numberText(actual)}</td><td title={unchanged?String(persisted.difference ?? ''):''}>{unchanged?numberText(persisted.difference):'—'}</td>
            <td>{unchanged?labels[persisted.status]:'待保存判定'}</td><td className="paper-comparison-reason">{row.causeHypothesis || '待补充'}<small>{row.referenceLocation || '来源定位待补充'}</small></td>
            <td><button className="research-button research-button-quiet" type="button" aria-expanded={expanded===row.key} aria-controls={detailId} disabled={busy} onClick={()=>setExpanded(expanded===row.key?null:row.key)}>{expanded===row.key?'收起':'详情'}</button><button className="research-button research-button-quiet" type="button" aria-label={`删除${row.metricName||'新增指标'}`} disabled={busy} onClick={()=>{setRows(current=>current.filter(item=>item.key!==row.key));setDirty(true);}}>删除</button></td>
          </tr>{expanded===row.key&&<tr id={detailId}><td colSpan={7}><fieldset className="paper-comparison-detail" disabled={busy}>
            <label className="research-field"><span>指标名称</span><input aria-label="对比指标名称" value={row.metricName} maxLength={200} required onChange={event=>change(row.key,{metricName:event.target.value})}/></label>
            <label className="research-field"><span>单位</span><input value={row.unit} maxLength={100} onChange={event=>change(row.key,{unit:event.target.value})}/></label>
            <label className="research-field"><span>允许绝对差值 · 容差</span><input type="number" min="0" max="1e100" step="any" value={row.tolerance} onChange={event=>change(row.key,{tolerance:event.target.value})} placeholder="空值不判断相符"/></label>
            <label className="research-field"><span>不足类型</span><select value={row.gapType} onChange={event=>change(row.key,{gapType:event.target.value as PaperComparisonGap})}>{gaps.map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label>
            <label className="research-field paper-comparison-wide"><span>论文页码 / 图表定位{row.reportedValue.trim()&&' · 必填'}</span><input value={row.referenceLocation} maxLength={1000} required={!!row.reportedValue.trim()} onChange={event=>change(row.key,{referenceLocation:event.target.value})} placeholder="例如第 4 页 Table 2"/></label>
            <label className="research-field paper-comparison-wide"><span>报告值原文摘录{row.reportedValue.trim()&&' · 必填'}</span><textarea rows={2} value={row.reportedText} maxLength={4000} required={!!row.reportedValue.trim()} onChange={event=>change(row.key,{reportedText:event.target.value})}/></label>
            <label className="research-field"><span>原因假设 · 未验证</span><textarea rows={2} value={row.causeHypothesis} maxLength={4000} onChange={event=>change(row.key,{causeHypothesis:event.target.value})}/></label>
            <label className="research-field"><span>下一步验证</span><textarea rows={2} value={row.nextStep} maxLength={4000} onChange={event=>change(row.key,{nextStep:event.target.value})}/></label>
          </fieldset></td></tr>}</Fragment>;
        })}</tbody>
      </table></div>
      {!rows.length&&<p className="research-empty-inline">暂无对比指标。可添加论文中的指标；没有实测结果时会保留为结果缺口。</p>}
      {missingSource&&<p className="paper-comparison-error" role="status">论文报告值需要页码定位与原文摘录，请在对应行的“详情”补齐后保存。</p>}
      <div className="research-panel-footer"><button type="button" className="research-button research-button-quiet" disabled={busy||rows.length>=50} onClick={()=>{const row=blank();setRows(current=>[...current,row]);setExpanded(row.key);setDirty(true);}}>添加指标</button><span>{dirty?'有未保存更改':comparison?`已保存 · ${comparison.updatedAt}`:'填写论文报告值与来源后保存'}</span><button type="button" className="research-button research-button-quiet" disabled={busy} onClick={()=>void load()}>{dirty?'放弃草稿并重新载入':'读取最新版本'}</button><button type="submit" className="research-button research-button-primary" disabled={busy||!paperId||missingSource}>{saving?'保存中…':'保存人工更正'}</button></div>
    </form>}
  </section>;
}
