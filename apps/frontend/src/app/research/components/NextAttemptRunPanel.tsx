import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { automationApi, type AutomationState } from '../../../api/automationAdapter';
import { getIdeaPlanAttempts } from '../../../api/ideaPlanRevisionAdapter';
import { workspaceModel } from '../../workspace/workspaceModel';

export function NextAttemptRunPanel() {
  const { projectId = '' } = useParams(), [params] = useSearchParams(), navigate = useNavigate();
  const attemptId = params.get('attempt') || '', ideaId = params.get('idea') || '';
  const [state, setState] = useState<{ projectId: string; attemptId: string; revision: number; active: boolean; automation: AutomationState } | null>(null);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [refresh, setRefresh] = useState(0);
  const epoch = useRef(0), lock = useRef(false);
  useEffect(() => {
    const current = ++epoch.current; setState(null); setError(''); setBusy(false); lock.current = false;
    if (attemptId && ideaId) void Promise.all([getIdeaPlanAttempts(projectId, ideaId), automationApi.load(projectId)])
      .then(([history, automation]) => {
        if (current !== epoch.current) return;
        const attempt = history.attempts.find(item => item.id === attemptId);
        if (!attempt) { setError('本项目没有所选尝试，请回到原方案记录核对。'); return; }
        setState({ projectId, attemptId, revision: attempt.planRevision, active: history.activeAttemptId === attemptId, automation });
      }).catch(reason => { if (current === epoch.current) setError(`读取新尝试失败：${String(reason)}`); });
    return () => { ++epoch.current; };
  }, [projectId, attemptId, ideaId, refresh]);
  if (!attemptId || !ideaId) return null;
  const current = state?.projectId === projectId && state.attemptId === attemptId ? state : null;
  const linked = current?.automation.session?.planAttempt?.id === attemptId;
  const run = async () => {
    if (!current?.active || linked || lock.current) return;
    lock.current = true; setBusy(true); setError(''); const captured = epoch.current;
    try {
      await automationApi.action(projectId, 'start', { targetStage: 'experiment', planAttemptId: attemptId,
        validationCampaignDesign: { ideaId, expectedPlanRevision: current.revision } }, workspaceModel());
      if (captured === epoch.current) navigate(`/project/${encodeURIComponent(projectId)}/explore#research-automation`);
    } catch (reason) {
      if (captured === epoch.current) setError(`接续失败：${String(reason)}。请核对原链路再继续，未自动重派。`);
    } finally { if (captured === epoch.current) { lock.current = false; setBusy(false); } }
  };
  return <section className="research-panel" aria-label="新版方案执行接力">
    <div className="research-panel-heading"><div><span className="research-overline">NEXT ATTEMPT</span><h3>继续验证新版方案</h3></div>
      <button className="research-button research-button-quiet" disabled={busy} onClick={() => setRefresh(value => value + 1)} type="button">核对原链路</button></div>
    <p className="research-panel-copy">方案 {current ? `v${current.revision}` : '正在读取'} 将沿原研究链路生成方法、设计对照条件、准备代码并运行有限试验。沿用当前自动策略、代码范围与预算，旧结果继续保留。</p>
    {error && <p role="alert" className="idea-plan-error">{error}</p>}
    {!current && !error && <p role="status">正在读取所选方案与尝试记录…</p>}
    {current && !current.active && <p>这是历史尝试；请回到当前方案选择新的尝试。</p>}
    <div className="research-inline-actions">
      {linked ? <Link className="research-button research-button-secondary" to={`/project/${encodeURIComponent(projectId)}/explore#research-automation`}>查看本次尝试链路</Link>
        : <button className="research-button research-button-primary" disabled={busy || !current?.active} onClick={() => void run()} type="button">{busy ? '正在接续…' : '让 AI 继续到实验验证'}</button>}
      <Link to={`/editor/${encodeURIComponent(projectId)}/research/innovation?idea=${encodeURIComponent(ideaId)}`}>查看方案与尝试历史</Link>
    </div>
  </section>;
}
