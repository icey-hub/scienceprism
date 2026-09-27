import { useEffect, useState } from 'react';
import { decideConstraintProposal, listConstraintProposals, type ConstraintProposal } from '../../api/constraintAdapter';

export function ConstraintProposalPanel({ projectId, refreshToken }: { projectId: string; refreshToken: number }) {
  const [proposals, setProposals] = useState<ConstraintProposal[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState('');

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
      <div className="constraint-proposal-actions">
        {proposal.status === 'pending' && <><button type="button" disabled={Boolean(busyId)} onClick={() => void decide(proposal, 'accept')}>确认并启用</button><button type="button" disabled={Boolean(busyId)} onClick={() => void decide(proposal, 'reject')}>拒绝</button></>}
        {proposal.status === 'accepted' && <button type="button" disabled={Boolean(busyId)} onClick={() => void decide(proposal, proposal.enabled ? 'disable' : 'enable')}>{proposal.enabled ? '关闭约束' : '启用约束'}</button>}
      </div>
    </details>)}
  </section>;
}
