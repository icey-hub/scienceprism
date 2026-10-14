import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { getValidationCampaigns, type ValidationCampaign } from '../../../api/client';
import { getCampaignAgentEvaluations, type CampaignAgentEvaluationRecord } from '../../../api/campaignEvaluationAdapter';

export interface WritingCampaignInput { validationCampaignId?: string; campaignEvaluationRunId?: string; }
const terminal = (status: string) => ['completed', 'failed', 'cancelled', 'budget_exhausted'].includes(status);
const verdicts = { supported: '固定条件下支持', refuted: '固定条件下反证', insufficient: '证据不足' };
const statuses: Record<string, string> = { completed: '已完成', failed: '失败', cancelled: '已取消', budget_exhausted: '预算耗尽', pending: '未运行' };
export function useWritingCampaignSource(projectId: string) {
  const [params, setParams] = useSearchParams();
  const campaignId = params.get('campaign') || '', evaluationId = params.get('evaluation') || '';
  const [campaignState, setCampaignState] = useState<{ projectId: string; campaigns: ValidationCampaign[]; error: string } | null>(null);
  const [evaluationState, setEvaluationState] = useState<{ projectId: string; campaignId: string; records: CampaignAgentEvaluationRecord[]; error: string } | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let live = true; setCampaignState(null);
    void getValidationCampaigns(projectId).then(result => { if (live) setCampaignState({ projectId, campaigns: result.campaigns, error: '' }); })
      .catch(error => { if (live) setCampaignState({ projectId, campaigns: [], error: String(error) }); });
    return () => { live = false; };
  }, [projectId, revision]);
  useEffect(() => {
    const controller = new AbortController(); setEvaluationState(null);
    if (campaignId) void getCampaignAgentEvaluations(projectId, campaignId, controller.signal)
      .then(result => { if (!controller.signal.aborted) setEvaluationState({ projectId, campaignId, records: result.evaluations, error: '' }); })
      .catch(error => { if (!controller.signal.aborted) setEvaluationState({ projectId, campaignId, records: [], error: String(error) }); });
    return () => controller.abort();
  }, [projectId, campaignId, revision]);
  const campaigns = campaignState?.projectId === projectId ? campaignState.campaigns : [];
  const campaign = campaigns.find(item => item.id === campaignId);
  const evaluations = evaluationState?.projectId === projectId && evaluationState.campaignId === campaignId ? evaluationState.records : [];
  const evaluation = evaluations.find(item => item.runId === evaluationId);
  const loading = campaignState?.projectId !== projectId || !!campaignId && (evaluationState?.projectId !== projectId || evaluationState.campaignId !== campaignId);
  const error = campaignState?.projectId === projectId && campaignState.error || (evaluationState?.projectId === projectId && evaluationState.campaignId === campaignId && evaluationState.error) || (!loading && campaignId && !campaign ? '所选批次不存在，请明确选择其它来源。' : '')
    || (!loading && evaluationId && (!evaluation || evaluation.status !== 'completed' || !evaluation.sourceCurrent) ? '所选评价不存在、未完成或来源已变化，请查看原任务或重新选择。' : '');
  const input: WritingCampaignInput = campaignId ? { validationCampaignId: campaignId, ...(evaluationId ? { campaignEvaluationRunId: evaluationId } : {}) } : {};
  const change = (key: 'campaign' | 'evaluation', value: string) => setParams(current => {
    const next = new URLSearchParams(current); if (value) next.set(key, value); else next.delete(key);
    if (key === 'campaign') next.delete('evaluation'); return next;
  }, { replace: true });
  return { campaignId, evaluationId, campaigns, campaign, evaluations, loading, error, input,
    ready: !campaignId ? !evaluationId : !loading && !error && !!campaign && terminal(campaign.status),
    change, refresh: () => setRevision(value => value + 1) };
}
export function WritingCampaignSource({ projectId, source, busy }: { projectId: string; source: ReturnType<typeof useWritingCampaignSource>; busy: boolean }) {
  const { campaign, campaignId, evaluationId, campaigns, evaluations, loading, error } = source;
  return <section className="research-panel" aria-label="写作试验来源">
    <div className="research-panel-heading"><div><span className="research-overline">RESULTS & LIMITATIONS</span><h3>选择写作的试验来源</h3></div><button type="button" className="research-button research-button-quiet" disabled={busy || loading} onClick={source.refresh}>刷新来源</button></div>
    <p className="research-panel-copy">批次交接包含所有种子、候选与对照、失败和缺失记录，以及固定条件下的比较；独立评价作为 AI 解读保留。</p>
    <label className="research-field"><span>试验批次</span><select aria-label="写作试验批次" value={campaignId} disabled={busy || loading} onChange={event => source.change('campaign', event.target.value)}><option value="">使用原阶段材料</option>{campaignId && !campaign && <option value={campaignId}>正在核对所选批次</option>}{campaigns.map(item => <option key={item.id} value={item.id} disabled={!terminal(item.status)}>{item.plan.hypothesis.prediction.slice(0, 65)} · v{item.planRevision} · {statuses[item.status] || item.status} · {item.id.slice(-8)}</option>)}</select></label>
    {campaignId && <label className="research-field"><span>独立评价记录</span><select aria-label="写作独立评价" value={evaluationId} disabled={busy || loading} onChange={event => source.change('evaluation', event.target.value)}><option value="">仅交接固定比较与原试验记录</option>{evaluationId && !evaluations.some(item => item.runId === evaluationId) && <option value={evaluationId}>正在核对所选评价</option>}{evaluations.map(item => <option key={item.runId} value={item.runId} disabled={item.status !== 'completed' || !item.sourceCurrent}>{new Date(item.createdAt).toLocaleString('zh-CN')} · {statuses[item.status] || item.status}{item.sourceCurrent ? '' : ' · 来源已变化'}</option>)}</select></label>}
    {loading && <p role="status">正在读取原批次与评价…</p>}{error && <p role="alert" className="validation-campaign-error">{error}</p>}
    {campaign && <><div className="research-summary-grid research-summary-grid-compact"><div><strong>{campaign.trials.length}</strong><span>全部试验项</span></div><div><strong>{campaign.seeds.length}</strong><span>固定种子</span></div><div><strong>{campaign.evaluation ? verdicts[campaign.evaluation.verdict] : '未计算'}</strong><span>原固定比较</span></div></div><p><Link to={`/editor/${encodeURIComponent(projectId)}/research/experiment?campaign=${encodeURIComponent(campaign.id)}#validation-campaign-results`}>核对完整比较表与来源 ↗</Link></p><p className="research-panel-copy">整理时沿原研究链路生成带全部来源的写作材料，可在链路中查看进度或停止。原试验与评价直接复用，AI 解读及待核验证据保持原状态。</p></>}
  </section>;
}
