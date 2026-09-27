import { request } from './client';

export interface ConstraintProposal {
  id: string;
  kind: 'reply.forbid_text' | 'patch.forbid_path' | 'patch.forbid_text';
  value: string;
  statement: string;
  code: string;
  test: string;
  status: 'pending' | 'accepted' | 'rejected';
  enabled: boolean;
  provenance: { source: string; model: string | null; conversationExcerpt: string; createdAt: string };
  audit: { action: string; actor: string; at: string }[];
}

export function listConstraintProposals(projectId: string) {
  return request<{ ok: boolean; proposals: ConstraintProposal[] }>(`/api/projects/${projectId}/constraint-proposals`);
}

export function decideConstraintProposal(projectId: string, proposalId: string, decision: 'accept' | 'reject' | 'enable' | 'disable') {
  return request<{ ok: boolean; proposal: ConstraintProposal }>(`/api/projects/${projectId}/constraint-proposals/${proposalId}/decision`, {
    method: 'POST', body: JSON.stringify({ decision, actor: 'human' })
  });
}

export interface ConstraintPolicy {
  preset: string;
  disabled: string[];
  rejected: { id: string | null; reason: string }[];
  audit: { id: string; action: 'enable' | 'disable'; actor: string; at: string }[];
  constraints: { id: string; statement: string; tier: 'core' | 'standard' | 'experimental'; canToggle: boolean; enabled: boolean }[];
}

export function getConstraintPolicy(projectId: string) {
  return request<{ ok: boolean; policy: ConstraintPolicy }>(`/api/projects/${projectId}/constraint-policy`);
}

export function setConstraintEnabled(projectId: string, constraintId: string, enabled: boolean) {
  return request<{ ok: boolean; policy: ConstraintPolicy }>(`/api/projects/${projectId}/constraint-policy/${constraintId}/decision`, {
    method: 'POST', body: JSON.stringify({ actor: 'human', enabled })
  });
}
