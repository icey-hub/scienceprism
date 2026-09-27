import { useEffect, useState } from 'react';
import { decideConstraintProposal, listConstraintProposals, reviseConstraintProposal, type ConstraintProposal } from '../../api/constraintAdapter';

export function ConstraintProposalPanel({ projectId, refreshToken }: { projectId: string; refreshToken: number }) {
  const [proposals, setProposals] = useState<ConstraintProposal[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Pick<ConstraintProposal, 'kind' | 'value' | 'statement'>>({ kind: 'reply.forbid_text', value: '', statement: '' });

  useEffect(() => {
    let live = true;
    setProposals([]);
    setError('');
    void listConstraintProposals(projectId).then(({ proposals: rows }) => { if (live) setProposals(rows); }).catch((cause) => { if (live) setError(String(cause)); });
    return () => { live = false; };
  }, [projectId, refreshToken]);

  const decide = async (proposal: ConstraintProposal, decision: 'accept' | 'reject' | 'enable' | 'disable') => {
    setBusyId(proposal.id);
    setError('');
    try {
      const result = await decideConstraintProposal(projectId, proposal.id, decision);
      setProposals((current) => current.map((item) => item.id === proposal.id ? result.proposal : item));
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusyId(null);
    }
  };

  const saveRevision = async (proposalId: string) => {
    setBusyId(proposalId);
    setError('');
    try {
      const result = await reviseConstraintProposal(projectId, proposalId, draft);
      setProposals((current) => current.map((item) => item.id === proposalId ? result.proposal : item));
      setEditingId(null);
    } catch (cause) { setError(String(cause)); }
    finally { setBusyId(null); }
  };

  return <section className="constraint-proposals" aria-label="对话约束提案">
    <strong>对话约束提案</strong>
    <p>对话中的长期规则会形成待审阅提案。当前支持禁止回复词句、禁止补丁词句和禁止修改项目路径；只有你确认后，代码门禁才会生效。</p>
    {error && <p role="alert" className="constraint-proposal-error">{error}</p>}
    {!proposals.length && <small>暂无提案。可在对话中明确提出“以后不要…”等项目规则。</small>}
    {proposals.map((proposal) => <details key={proposal.id} className="constraint-proposal">
      <summary><span>{proposal.statement}</span><small>{proposal.status === 'pending' ? '待确认' : proposal.status === 'rejected' ? '已拒绝' : proposal.enabled ? '已启用' : '已关闭'}</small></summary>
      <p>{proposal.kind === 'patch.forbid_path' ? '禁止修改路径' : proposal.kind === 'patch.forbid_text' ? '禁止补丁词句' : '禁止回复文字'}：<code>{proposal.value}</code></p>
      <p>来源：AI 对话提案 · {proposal.provenance.model || '未记录模型'} · {new Date(proposal.provenance.createdAt).toLocaleString()}</p>
      {proposal.provenance.conversationExcerpt && <p>对话来源：{proposal.provenance.conversationExcerpt}</p>}
      <details><summary>查看代码与测试草案</summary><pre>{proposal.code}</pre><pre>{proposal.test}</pre></details>
      {proposal.status === 'pending' && editingId === proposal.id && <div className="constraint-proposal-edit">
        <label>规则类型<select value={draft.kind} onChange={(event) => setDraft((current) => ({ ...current, kind: event.target.value as ConstraintProposal['kind'] }))}>
          <option value="reply.forbid_text">禁止回复词句</option><option value="patch.forbid_text">禁止补丁词句</option><option value="patch.forbid_path">禁止修改路径</option>
        </select></label>
        <label>匹配值<input value={draft.value} maxLength={120} onChange={(event) => setDraft((current) => ({ ...current, value: event.target.value }))} /></label>
        <label>规则说明<input value={draft.statement} maxLength={240} onChange={(event) => setDraft((current) => ({ ...current, statement: event.target.value }))} /></label>
        <div><button type="button" disabled={Boolean(busyId)} onClick={() => void saveRevision(proposal.id)}>保存修改</button><button type="button" disabled={Boolean(busyId)} onClick={() => setEditingId(null)}>取消</button></div>
      </div>}
      <div className="constraint-proposal-actions">
        {proposal.status === 'pending' && <><button type="button" disabled={Boolean(busyId)} onClick={() => { setEditingId(proposal.id); setDraft({ kind: proposal.kind, value: proposal.value, statement: proposal.statement }); }}>修改提案</button><button type="button" disabled={Boolean(busyId) || editingId === proposal.id} onClick={() => void decide(proposal, 'accept')}>确认并启用</button><button type="button" disabled={Boolean(busyId)} onClick={() => void decide(proposal, 'reject')}>拒绝</button></>}
        {proposal.status === 'accepted' && <button type="button" disabled={Boolean(busyId)} onClick={() => void decide(proposal, proposal.enabled ? 'disable' : 'enable')}>{proposal.enabled ? '关闭约束' : '启用约束'}</button>}
      </div>
    </details>)}
  </section>;
}
